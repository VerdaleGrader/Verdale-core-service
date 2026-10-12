import { Cast, castSpace, createPublishedProblem, problemUrl, submitCode } from '@/test/fixtures';
import { Client, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb('Track members and invitations (GRD-80)', () => {
  let t: TestApp;
  let cast: Cast;
  let newcomer: Client;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t);
    newcomer = await t.login({ providerAccountId: 'nina', email: 'nina@example.com' });
    await cast.owner.request('POST', '/api/v1/spaces/team/tracks', {
      name: 'Closed',
      slug: 'closed',
      visibility: 'members',
    });
  });
  afterEach(async () => t.close());

  const tracks = '/api/v1/spaces/team/tracks';
  const closed = `${tracks}/closed`;
  const link = async (body: object = {}, client: Client = cast.editor) => {
    const response = await client.request('POST', `${closed}/invites`, body);
    expect(response.status).toBe(201);
    return response.body as { id: string; token: string; link: string; track: { slug: string } };
  };
  const slugs = (body: { items: Array<{ slug: string }> }) => body.items.map((item) => item.slug);
  const auditActions = async () =>
    (await t.prisma.auditLog.findMany({ orderBy: { created_at: 'asc' } })).map((row) => row.action);

  describe('a link', () => {
    it('is created by an owner or an editor, with an expiry, and returns its token once', async () => {
      for (const who of ['owner', 'editor'] as const) {
        const response = await cast[who].request('POST', `${closed}/invites`, {
          expires_in_days: 3,
        });
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          role: 'solver',
          status: 'pending',
          track: { slug: 'closed', name: 'Closed' },
          invited_user: null,
        });
        expect(response.body.link).toBe(`/invites/${response.body.token}`);
        const days =
          (new Date(response.body.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
        expect(days).toBeGreaterThan(2.9);
        expect(days).toBeLessThan(3.1);
      }
      const listed = await cast.owner.request('GET', `${closed}/invites`);
      expect(listed.body.items).toHaveLength(2);
      expect(JSON.stringify(listed.body)).not.toContain('token');
      expect(await t.prisma.invite.count({ where: { track_id: { not: null } } })).toBe(2);
    });

    it('is limited to 1 to 30 days and a solver seat', async () => {
      for (const body of [
        { expires_in_days: 0 },
        { expires_in_days: 31 },
        { expires_in_days: 1.5 },
      ]) {
        expect((await cast.owner.request('POST', `${closed}/invites`, body)).status).toBe(400);
      }
      // A role in the body is ignored: a Track invitation never gives more than a solver seat.
      const response = await cast.owner.request('POST', `${closed}/invites`, { role: 'owner' });
      expect(response.status).toBe(201);
      expect(response.body.role).toBe('solver');
    });

    it('lets a newcomer in as a solver of the Space and a member of the Track', async () => {
      const invite = await link();
      const preview = await newcomer.request('GET', `/api/v1/invites/${invite.token}`);
      expect(preview.body).toMatchObject({ track: { slug: 'closed' }, space: { slug: 'team' } });
      const accepted = await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ role: 'solver', track: { slug: 'closed' } });
      const membership = await t.prisma.membership.findFirstOrThrow({
        where: { user: { username: 'nina' }, space: { slug: 'team' } },
      });
      expect(membership.role).toBe('solver');
      expect(await t.prisma.trackMember.count()).toBe(1);
    });

    it('works once: a second person gets 410, the same person 409', async () => {
      const invite = await link();
      expect(
        (await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`)).status
      ).toBe(200);
      const second = await t.login({ providerAccountId: 'ned', email: 'ned@example.com' });
      expect((await second.request('POST', `/api/v1/invites/${invite.token}/accept`)).status).toBe(
        410
      );
      expect(
        (await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`)).status
      ).toBe(410);
    });

    it('is refused after it expires', async () => {
      const invite = await link();
      await t.prisma.invite.update({
        where: { id: invite.id },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      expect(
        (await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`)).status
      ).toBe(410);
      expect((await newcomer.request('GET', `/api/v1/invites/${invite.token}`)).body.status).toBe(
        'expired'
      );
      expect((await cast.owner.request('GET', `${closed}/invites`)).body.items).toEqual([]);
      expect(await t.prisma.membership.count({ where: { user: { username: 'nina' } } })).toBe(1);
    });

    it('is refused after it is revoked, and the revocation is recorded', async () => {
      const invite = await link();
      expect((await cast.editor.request('DELETE', `${closed}/invites/${invite.id}`)).status).toBe(
        204
      );
      expect(
        (await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`)).status
      ).toBe(410);
      expect((await cast.editor.request('DELETE', `${closed}/invites/${invite.id}`)).status).toBe(
        409
      );
      expect(await auditActions()).toEqual(['track.invite_created', 'track.invite_revoked']);
    });

    it('cannot be revoked through another Track or the Space', async () => {
      const invite = await link();
      await cast.owner.request('POST', tracks, { name: 'Other', slug: 'other' });
      expect(
        (await cast.owner.request('DELETE', `${tracks}/other/invites/${invite.id}`)).status
      ).toBe(404);
      expect(
        (await cast.owner.request('DELETE', `/api/v1/spaces/team/invites/${invite.id}`)).status
      ).toBe(404);
    });

    it('a Space link still lets someone into the Space only', async () => {
      const spaceLink = await cast.owner.request('POST', '/api/v1/spaces/team/invites', {
        role: 'solver',
      });
      const accepted = await newcomer.request(
        'POST',
        `/api/v1/invites/${spaceLink.body.token}/accept`
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.track).toBeNull();
      expect(await t.prisma.trackMember.count()).toBe(0);
      const spaceList = await cast.owner.request('GET', '/api/v1/spaces/team/invites');
      expect(spaceList.body.items.every((item: { track: unknown }) => item.track === null)).toBe(
        true
      );
    });

    it('a Space invitation list does not show Track links and the reverse', async () => {
      await link();
      expect((await cast.owner.request('GET', '/api/v1/spaces/team/invites')).body.items).toEqual(
        []
      );
    });

    it('an existing member keeps their role and joins the Track', async () => {
      const invite = await link();
      const accepted = await cast.editor.request('POST', `/api/v1/invites/${invite.token}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body.role).toBe('editor');
      const membership = await t.prisma.membership.findFirstOrThrow({
        where: { user: { username: 'edith' }, space: { slug: 'team' } },
      });
      expect(membership.role).toBe('editor');
    });

    it('cannot be used to join an archived Track or Space', async () => {
      const invite = await link();
      await cast.owner.request('POST', `${closed}/archive`);
      expect(
        (await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`)).status
      ).toBe(410);
      expect((await cast.owner.request('POST', `${closed}/invites`, {})).status).toBe(409);
    });
  });

  describe('a person', () => {
    it('is invited by username and only that person can answer', async () => {
      const invite = await cast.editor.request('POST', `${closed}/invites`, { username: 'nina' });
      expect(invite.status).toBe(201);
      expect(invite.body.invited_user).toMatchObject({ username: 'nina' });
      expect(invite.body.link).toBeUndefined();
      expect(
        (await cast.outsider.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
      ).toBe(404);
      const mine = await newcomer.request('GET', '/api/v1/me/invites');
      expect(mine.body.items).toHaveLength(1);
      expect(mine.body.items[0]).toMatchObject({ track: { slug: 'closed' } });
      const accepted = await newcomer.request(
        'POST',
        `/api/v1/me/invites/${mine.body.items[0].id}/accept`
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.track.slug).toBe('closed');
    });

    it('can decline, and then is not a member', async () => {
      const invite = await cast.editor.request('POST', `${closed}/invites`, { username: 'nina' });
      const declined = await newcomer.request(
        'POST',
        `/api/v1/me/invites/${invite.body.id}/decline`
      );
      expect(declined.body.status).toBe('declined');
      expect(await t.prisma.trackMember.count()).toBe(0);
      expect(await t.prisma.membership.count({ where: { user: { username: 'nina' } } })).toBe(1); // personal Space only
    });

    it('unknown, repeated and already-member invitations are refused', async () => {
      expect(
        (await cast.editor.request('POST', `${closed}/invites`, { username: 'ghost' })).status
      ).toBe(404);
      await cast.editor.request('POST', `${closed}/invites`, { username: 'nina' });
      expect(
        (await cast.editor.request('POST', `${closed}/invites`, { username: 'nina' })).status
      ).toBe(409);
      await cast.solver.request('GET', '/api/v1/me');
      const first = await cast.editor.request('POST', `${closed}/invites`, { username: 'sol' });
      await cast.solver.request('POST', `/api/v1/invites/${first.body.token}/accept`);
      expect(
        (await cast.editor.request('POST', `${closed}/invites`, { username: 'sol' })).status
      ).toBe(409);
    });

    it('a person invited to a Track and to the Space has two separate pending invitations', async () => {
      await cast.owner.request('POST', '/api/v1/spaces/team/invites', {
        role: 'solver',
        username: 'nina',
      });
      expect(
        (await cast.editor.request('POST', `${closed}/invites`, { username: 'nina' })).status
      ).toBe(201);
    });
  });

  describe('members', () => {
    beforeEach(async () => {
      const invite = await link();
      await newcomer.request('POST', `/api/v1/invites/${invite.token}/accept`);
    });

    it('owners and editors list them', async () => {
      const list = await cast.editor.request('GET', `${closed}/members`);
      expect(list.status).toBe(200);
      expect(list.body.items).toMatchObject([{ username: 'nina', space_role: 'solver' }]);
      expect((await cast.solver.request('GET', `${closed}/members`)).status).toBe(403);
      expect((await cast.outsider.request('GET', `${closed}/members`)).status).toBe(404);
    });

    it('a member sees the Track others cannot see, and the open Tracks', async () => {
      expect(slugs((await newcomer.request('GET', tracks)).body)).toEqual(['general', 'closed']);
      expect((await newcomer.request('GET', closed)).status).toBe(200);
      expect((await cast.solver.request('GET', closed)).status).toBe(404);
    });

    it('someone invited to a closed Track only sees that Track when all others are closed too', async () => {
      await cast.owner.request('PATCH', `${tracks}/general`, { visibility: 'members' });
      expect(slugs((await newcomer.request('GET', tracks)).body)).toEqual(['closed']);
      expect(slugs((await cast.solver.request('GET', tracks)).body)).toEqual([]);
    });

    it('problems in the closed Track reach exactly its members', async () => {
      await createPublishedProblem(cast, 'secret-1', {}, { placed: false });
      await cast.editor.request('POST', '/api/v1/spaces/team/collections', {
        name: 'Closed set',
        slug: 'closed-set',
        track_slugs: ['closed'],
      });
      await cast.editor.request('POST', '/api/v1/spaces/team/collections/closed-set/problems', {
        problem_slugs: ['secret-1'],
      });
      expect((await newcomer.request('GET', problemUrl('team', 'secret-1'))).status).toBe(200);
      expect((await submitCode(newcomer, 'team', 'secret-1')).status).toBe(202);
      await t.settle();
      expect((await cast.solver.request('GET', problemUrl('team', 'secret-1'))).status).toBe(404);
    });

    it('removing a member takes the Track away but not the Space', async () => {
      expect((await cast.editor.request('DELETE', `${closed}/members/nina`)).status).toBe(204);
      expect((await newcomer.request('GET', closed)).status).toBe(404);
      expect((await newcomer.request('GET', tracks)).status).toBe(200);
      const membership = await t.prisma.membership.findFirst({
        where: { user: { username: 'nina' }, space: { slug: 'team' } },
      });
      expect(membership?.role).toBe('solver');
      expect(await auditActions()).toEqual([
        'track.invite_created',
        'track.member_joined',
        'track.member_removed',
      ]);
      expect((await cast.editor.request('DELETE', `${closed}/members/nina`)).status).toBe(404);
    });

    it('only owners and editors can remove members', async () => {
      expect((await cast.solver.request('DELETE', `${closed}/members/nina`)).status).toBe(403);
      expect((await newcomer.request('DELETE', `${closed}/members/nina`)).status).toBe(403);
    });

    it('leaving or being removed from the Space removes the Track memberships', async () => {
      expect((await cast.owner.request('DELETE', '/api/v1/spaces/team/members/nina')).status).toBe(
        204
      );
      expect(await t.prisma.trackMember.count()).toBe(0);
      const again = await link();
      await newcomer.request('POST', `/api/v1/invites/${again.token}/accept`);
      expect(await t.prisma.trackMember.count()).toBe(1);
      expect((await newcomer.request('POST', '/api/v1/spaces/team/leave')).status).toBe(204);
      expect(await t.prisma.trackMember.count()).toBe(0);
    });

    it('the audit log says who invited, who joined and who was removed', async () => {
      await cast.editor.request('DELETE', `${closed}/members/nina`);
      const rows = await t.prisma.auditLog.findMany({ orderBy: { created_at: 'asc' } });
      const track = await t.prisma.track.findFirstOrThrow({ where: { slug: 'closed' } });
      expect(rows.map((row) => row.action)).toEqual([
        'track.invite_created',
        'track.member_joined',
        'track.member_removed',
      ]);
      expect(rows.every((row) => row.target_id === track.id)).toBe(true);
      const editor = await t.prisma.user.findFirstOrThrow({ where: { username: 'edith' } });
      expect(rows[0]!.actor_id).toBe(editor.id);
      expect(rows[2]!.data).toMatchObject({ user: 'nina' });
    });
  });

  describe('permissions and rules', () => {
    it('solvers and outsiders cannot invite or list invitations', async () => {
      expect((await cast.solver.request('POST', `${closed}/invites`, {})).status).toBe(403);
      expect((await cast.solver.request('GET', `${closed}/invites`)).status).toBe(403);
      expect((await cast.outsider.request('POST', `${closed}/invites`, {})).status).toBe(404);
      expect((await cast.visitor.request('POST', `${closed}/invites`, {})).status).toBe(401);
    });

    it('an archived Space accepts no new Track invitations', async () => {
      await cast.owner.request('POST', '/api/v1/spaces/team/archive');
      expect((await cast.owner.request('POST', `${closed}/invites`, {})).status).toBe(403);
    });

    it('the database refuses a Track member who is not in the Space', async () => {
      const track = await t.prisma.track.findFirstOrThrow({ where: { slug: 'closed' } });
      const stranger = await t.prisma.user.findFirstOrThrow({ where: { username: 'nina' } });
      await expect(
        t.prisma.trackMember.create({ data: { track_id: track.id, user_id: stranger.id } })
      ).rejects.toThrow();
    });

    it('the database refuses a Track invitation that gives more than a solver seat', async () => {
      const track = await t.prisma.track.findFirstOrThrow({ where: { slug: 'closed' } });
      const creator = await t.prisma.user.findFirstOrThrow({ where: { username: 'olivia' } });
      await expect(
        t.prisma.invite.create({
          data: {
            space_id: track.space_id,
            track_id: track.id,
            created_by_id: creator.id,
            token_hash: 'x'.repeat(64),
            role: 'editor',
            expires_at: new Date(Date.now() + 1000),
          },
        })
      ).rejects.toThrow();
    });
  });
});
