import { createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

describeDb(
  'members and invitations (GRD-18), roles (GRD-96, GRD-97) and the owner rule (GRD-14)',
  () => {
    let t: TestApp;
    beforeEach(async () => {
      t = await createTestApp();
      await resetDatabase(t.prisma);
    });
    afterEach(async () => t.close());

    const signUp = (name: string) =>
      t.login({ providerAccountId: name, email: `${name}@example.com`, usernameHint: name });

    /** ada owns "team"; returns everyone who might be involved. */
    async function setup() {
      const ada = await signUp('ada');
      const grace = await signUp('grace');
      const linus = await signUp('linus');
      const eve = await signUp('eve');
      await ada.request('POST', '/api/v1/spaces', { name: 'Team', slug: 'team' });
      return { ada, grace, linus, eve };
    }

    /** My role in a Space; null for a non-member (a private Space answers 404 then). */
    const roleOf = async (client: Awaited<ReturnType<typeof signUp>>, slug = 'team') =>
      (await client.request('GET', `/api/v1/spaces/${slug}`)).body?.my_role ?? null;

    async function join(
      owner: Awaited<ReturnType<typeof signUp>>,
      guest: Awaited<ReturnType<typeof signUp>>,
      role: 'administrator' | 'editor' | 'observer' | 'solver'
    ) {
      const invite = await owner.request('POST', '/api/v1/spaces/team/invites', { role });
      const response = await guest.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
      expect(response.status).toBe(200);
    }

    describe('inviting', () => {
      it('by link: role, expiry, and a token that is shown only once', async () => {
        const { ada } = await setup();
        const response = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'editor',
          expires_in_days: 3,
        });
        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
          role: 'editor',
          status: 'pending',
          space: { slug: 'team' },
          invited_user: null,
        });
        expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(response.body.link).toBe(`/invites/${response.body.token}`);
        const days = (Date.parse(response.body.expires_at) - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(2.9);
        expect(days).toBeLessThan(3.1);

        const stored = await t.prisma.invite.findFirstOrThrow();
        expect(JSON.stringify(stored)).not.toContain(response.body.token);

        const listed = await ada.request('GET', '/api/v1/spaces/team/invites');
        expect(listed.body.items).toHaveLength(1);
        expect(listed.body.items[0].token).toBeUndefined();
        expect(listed.body.items[0].link).toBeUndefined();
      });

      it('by username: only that person can see and answer it', async () => {
        const { ada, grace, linus } = await setup();
        const created = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'solver',
          username: 'Grace',
        });
        expect(created.status).toBe(201);
        expect(created.body.invited_user).toEqual({
          username: 'grace',
          display_name: 'grace',
          avatar_url: null,
        });
        expect(created.body.link).toBeUndefined();

        const mine = await grace.request('GET', '/api/v1/me/invites');
        expect(mine.body.items).toHaveLength(1);
        expect((await linus.request('GET', '/api/v1/me/invites')).body.items).toHaveLength(0);

        const id = mine.body.items[0].id;
        // someone else cannot answer it, not even with the link-style token
        expect((await linus.request('POST', `/api/v1/me/invites/${id}/accept`)).status).toBe(404);
        expect(
          (await linus.request('POST', `/api/v1/invites/${created.body.token}/accept`)).status
        ).toBe(404);
        expect(await roleOf(linus)).toBeNull();

        const accepted = await grace.request('POST', `/api/v1/me/invites/${id}/accept`);
        expect(accepted.body).toMatchObject({
          status: 'accepted',
          role: 'solver',
          space: { slug: 'team' },
        });
        expect(await roleOf(grace)).toBe('solver');
      });

      it('rejects bad input', async () => {
        const { ada } = await setup();
        const invalid: unknown[] = [
          { role: 'owner' },
          { role: 'admin' },
          {},
          { role: 'editor', expires_in_days: 0 },
          { role: 'editor', expires_in_days: 31 },
          { role: 'editor', expires_in_days: 1.5 },
        ];
        for (const body of invalid) {
          expect((await ada.request('POST', '/api/v1/spaces/team/invites', body)).status).toBe(400);
        }
        expect(
          (
            await ada.request('POST', '/api/v1/spaces/team/invites', {
              role: 'editor',
              username: 'nobody',
            })
          ).status
        ).toBe(404);
      });

      it('cannot invite someone who is already a member, or twice', async () => {
        const { ada, grace } = await setup();
        const first = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'solver',
          username: 'grace',
        });
        expect(first.status).toBe(201);
        const again = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'editor',
          username: 'grace',
        });
        expect(again.status).toBe(409);
        await grace.request('POST', `/api/v1/invites/${first.body.token}/accept`);
        const member = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'editor',
          username: 'grace',
        });
        expect(member.status).toBe(409);
      });

      it('only owners invite; the invite list is owner-only', async () => {
        const { ada, grace, linus, eve } = await setup();
        await join(ada, grace, 'editor');
        await join(ada, linus, 'solver');
        for (const person of [grace, linus]) {
          expect(
            (await person.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' })).status
          ).toBe(403);
          expect((await person.request('GET', '/api/v1/spaces/team/invites')).status).toBe(403);
        }
        expect(
          (await eve.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' })).status
        ).toBe(404);
        expect(
          (await t.anonymous().request('POST', '/api/v1/spaces/team/invites', { role: 'solver' }))
            .status
        ).toBe(401);
      });
    });

    describe('answering', () => {
      it('a link holder sees a preview without logging in, then accepts once logged in', async () => {
        const { ada, grace } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'editor' });
        const preview = await t.anonymous().request('GET', `/api/v1/invites/${invite.body.token}`);
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({
          space: { name: 'Team', slug: 'team' },
          role: 'editor',
          status: 'pending',
          invited_by: { username: 'ada' },
        });
        expect(preview.body.token).toBeUndefined();

        expect(
          (await t.anonymous().request('POST', `/api/v1/invites/${invite.body.token}/accept`))
            .status
        ).toBe(401);
        const accepted = await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
        expect(accepted.status).toBe(200);
        expect(await roleOf(grace)).toBe('editor');
      });

      it('can be declined, after which it cannot be used', async () => {
        const { ada, grace } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'solver',
          username: 'grace',
        });
        const id = (await grace.request('GET', '/api/v1/me/invites')).body.items[0].id;
        const declined = await grace.request('POST', `/api/v1/me/invites/${id}/decline`);
        expect(declined.body.status).toBe('declined');
        expect(await roleOf(grace)).toBeNull();
        expect((await grace.request('POST', `/api/v1/me/invites/${id}/accept`)).status).toBe(410);
        expect(
          (await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
        ).toBe(410);
        expect((await grace.request('GET', '/api/v1/me/invites')).body.items).toHaveLength(0);
      });

      it('a link can be used once: the second person gets 410', async () => {
        const { ada, grace, linus } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' });
        expect(
          (await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
        ).toBe(200);
        expect(
          (await linus.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
        ).toBe(410);
        expect(await roleOf(linus)).toBeNull();
      });

      it('two people opening the same link at the same moment: exactly one gets in', async () => {
        const { ada, grace, linus } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' });
        const results = await Promise.all([
          grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`),
          linus.request('POST', `/api/v1/invites/${invite.body.token}/accept`),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual([200, 410]);
        expect(await t.prisma.membership.count({ where: { space: { slug: 'team' } } })).toBe(2);
      });

      it('an expired link does not work, and shows as expired', async () => {
        const { ada, grace } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' });
        await t.prisma.invite.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });
        expect(
          (await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
        ).toBe(410);
        expect(
          (await t.anonymous().request('GET', `/api/v1/invites/${invite.body.token}`)).body.status
        ).toBe('expired');
        expect((await ada.request('GET', '/api/v1/spaces/team/invites')).body.items).toHaveLength(
          0
        );
        expect(await roleOf(grace)).toBeNull();
      });

      it('a revoked link does not work', async () => {
        const { ada, grace } = await setup();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' });
        const revoked = await ada.request(
          'DELETE',
          `/api/v1/spaces/team/invites/${invite.body.id}`
        );
        expect(revoked.status).toBe(204);
        expect(
          (await grace.request('POST', `/api/v1/invites/${invite.body.token}/accept`)).status
        ).toBe(410);
        expect(
          (await t.anonymous().request('GET', `/api/v1/invites/${invite.body.token}`)).body.status
        ).toBe('revoked');
        // revoking twice, or a used invite, is a conflict
        expect(
          (await ada.request('DELETE', `/api/v1/spaces/team/invites/${invite.body.id}`)).status
        ).toBe(409);
      });

      it('only owners of that Space can revoke, and only its own invitations', async () => {
        const { ada, grace } = await setup();
        await join(ada, grace, 'editor');
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' });
        expect(
          (await grace.request('DELETE', `/api/v1/spaces/team/invites/${invite.body.id}`)).status
        ).toBe(403);
        await ada.request('POST', '/api/v1/spaces', { name: 'Other', slug: 'other' });
        expect(
          (await ada.request('DELETE', `/api/v1/spaces/other/invites/${invite.body.id}`)).status
        ).toBe(404);
      });

      it('an unknown token is a 404, and a member cannot redeem a second invite', async () => {
        const { ada, grace } = await setup();
        expect(
          (await grace.request('POST', `/api/v1/invites/${'x'.repeat(43)}/accept`)).status
        ).toBe(404);
        await join(ada, grace, 'solver');
        const second = await ada.request('POST', '/api/v1/spaces/team/invites', { role: 'editor' });
        const response = await grace.request('POST', `/api/v1/invites/${second.body.token}/accept`);
        expect(response.status).toBe(409);
        expect(await roleOf(grace)).toBe('solver');
        // the invitation was not used up by the failed attempt
        expect(
          (await t.anonymous().request('GET', `/api/v1/invites/${second.body.token}`)).body.status
        ).toBe('pending');
      });
    });

    describe('managing members', () => {
      it('lists members with their roles, to members only', async () => {
        const { ada, grace, eve } = await setup();
        await join(ada, grace, 'solver');
        const list = await grace.request('GET', '/api/v1/spaces/team/members');
        expect(
          list.body.items.map((member: { username: string; role: string }) => [
            member.username,
            member.role,
          ])
        ).toEqual([
          ['ada', 'owner'],
          ['grace', 'solver'],
        ]);
        expect((await eve.request('GET', '/api/v1/spaces/team/members')).status).toBe(404);
        expect((await t.anonymous().request('GET', '/api/v1/spaces/team/members')).status).toBe(
          401
        );
      });

      it('a public Space still hides its member list from non-members', async () => {
        const { ada, eve } = await setup();
        await ada.request('PATCH', '/api/v1/spaces/team', { visibility: 'public' });
        expect((await eve.request('GET', '/api/v1/spaces/team/members')).status).toBe(403);
      });

      it('owner changes roles', async () => {
        const { ada, grace } = await setup();
        await join(ada, grace, 'solver');
        const response = await ada.request('PATCH', '/api/v1/spaces/team/members/grace', {
          role: 'editor',
        });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ username: 'grace', role: 'editor' });
        expect(await roleOf(grace)).toBe('editor');
        expect(
          (await ada.request('PATCH', '/api/v1/spaces/team/members/grace', { role: 'king' })).status
        ).toBe(400);
        expect(
          (await ada.request('PATCH', '/api/v1/spaces/team/members/nobody', { role: 'editor' }))
            .status
        ).toBe(404);
      });

      it('non-owners cannot change roles or remove anyone', async () => {
        const { ada, grace, linus } = await setup();
        await join(ada, grace, 'editor');
        await join(ada, linus, 'solver');
        expect(
          (await grace.request('PATCH', '/api/v1/spaces/team/members/linus', { role: 'editor' }))
            .status
        ).toBe(403);
        expect(
          (await grace.request('PATCH', '/api/v1/spaces/team/members/grace', { role: 'owner' }))
            .status
        ).toBe(403);
        expect((await linus.request('DELETE', '/api/v1/spaces/team/members/grace')).status).toBe(
          403
        );
        expect(await roleOf(linus)).toBe('solver');
      });

      it('owner removes a member, who then loses access to a private Space', async () => {
        const { ada, grace } = await setup();
        await join(ada, grace, 'editor');
        expect((await ada.request('DELETE', '/api/v1/spaces/team/members/grace')).status).toBe(204);
        expect((await grace.request('GET', '/api/v1/spaces/team')).status).toBe(404);
        expect((await ada.request('DELETE', '/api/v1/spaces/team/members/grace')).status).toBe(404);
      });

      it('a member can leave on their own', async () => {
        const { ada, grace } = await setup();
        await join(ada, grace, 'solver');
        expect((await grace.request('POST', '/api/v1/spaces/team/leave')).status).toBe(204);
        expect(await roleOf(grace)).toBeNull();
        // and is no longer a member to leave
        expect((await grace.request('POST', '/api/v1/spaces/team/leave')).status).toBe(404);
      });

      it('someone who is not in a Space cannot leave it', async () => {
        const { eve } = await setup();
        expect((await eve.request('POST', '/api/v1/spaces/team/leave')).status).toBe(404);
      });
    });

    describe('the owner (exactly one)', () => {
      it('cannot leave, be removed, or be demoted; the Space must be handed over', async () => {
        const { ada } = await setup();
        const messages = [
          await ada.request('POST', '/api/v1/spaces/team/leave'),
          await ada.request('DELETE', '/api/v1/spaces/team/members/ada'),
          await ada.request('PATCH', '/api/v1/spaces/team/members/ada', { role: 'editor' }),
        ];
        for (const response of messages) {
          expect(response.status).toBe(409);
          expect(response.body.message).toMatch(/exactly one owner/);
        }
        expect(await roleOf(ada)).toBe('owner');
      });

      it('handing the Space over makes the old owner an administrator', async () => {
        const { ada, grace } = await setup();
        await join(ada, grace, 'editor');
        const response = await ada.request('PATCH', '/api/v1/spaces/team/members/grace', {
          role: 'owner',
        });
        expect(response.status).toBe(200);
        expect(await roleOf(grace)).toBe('owner');
        expect(await roleOf(ada)).toBe('administrator');
        expect(
          await t.prisma.membership.count({ where: { space: { slug: 'team' }, role: 'owner' } })
        ).toBe(1);
        // the new owner is now the one who cannot leave, and the old one can
        expect((await grace.request('POST', '/api/v1/spaces/team/leave')).status).toBe(409);
        expect((await ada.request('POST', '/api/v1/spaces/team/leave')).status).toBe(204);
      });

      it('only the owner hands the Space over', async () => {
        const { ada, grace, linus } = await setup();
        await join(ada, grace, 'editor');
        await join(ada, linus, 'solver');
        await ada.request('PATCH', '/api/v1/spaces/team/members/grace', { role: 'administrator' });
        const response = await grace.request('PATCH', '/api/v1/spaces/team/members/linus', {
          role: 'owner',
        });
        expect(response.status).toBe(403);
        expect(await roleOf(ada)).toBe('owner');
      });

      it("a personal Space's owner cannot leave it", async () => {
        const { ada } = await setup();
        expect((await ada.request('POST', '/api/v1/spaces/ada/leave')).status).toBe(409);
      });

      it('two handovers at the same moment: one of them wins', async () => {
        const { ada, grace, linus } = await setup();
        await join(ada, grace, 'editor');
        await join(ada, linus, 'editor');
        const results = await Promise.all([
          ada.request('PATCH', '/api/v1/spaces/team/members/grace', { role: 'owner' }),
          ada.request('PATCH', '/api/v1/spaces/team/members/linus', { role: 'owner' }),
        ]);
        expect(results.filter((result) => result.status === 200)).toHaveLength(1);
        expect(
          await t.prisma.membership.count({ where: { space: { slug: 'team' }, role: 'owner' } })
        ).toBe(1);
      });
    });

    describe('administrators and observers (GRD-96, GRD-97)', () => {
      async function withAdmin() {
        const people = await setup();
        await join(people.ada, people.grace, 'editor');
        await join(people.ada, people.linus, 'solver');
        await join(people.ada, people.eve, 'solver');
        expect(
          (
            await people.ada.request('PATCH', '/api/v1/spaces/team/members/grace', {
              role: 'administrator',
            })
          ).status
        ).toBe(200);
        return people;
      }

      it('the owner can invite an administrator or an observer', async () => {
        const { ada } = await setup();
        for (const role of ['administrator', 'observer']) {
          const response = await ada.request('POST', '/api/v1/spaces/team/invites', { role });
          expect(response.status).toBe(201);
          expect(response.body.role).toBe(role);
        }
      });

      it('an administrator invites and manages editors, observers and solvers', async () => {
        const { grace, linus } = await withAdmin();
        const invite = await grace.request('POST', '/api/v1/spaces/team/invites', {
          role: 'observer',
        });
        expect(invite.status).toBe(201);
        for (const role of ['observer', 'editor', 'solver']) {
          const response = await grace.request('PATCH', '/api/v1/spaces/team/members/linus', {
            role,
          });
          expect(response.status).toBe(200);
        }
        expect(await roleOf(linus)).toBe('solver');
        expect((await grace.request('DELETE', '/api/v1/spaces/team/members/linus')).status).toBe(
          204
        );
      });

      it('an administrator cannot make administrators, change them, or touch the owner', async () => {
        const { ada, grace, linus, eve } = await withAdmin();
        // a second administrator, made by the owner
        await ada.request('PATCH', '/api/v1/spaces/team/members/eve', { role: 'administrator' });
        expect(
          (await grace.request('POST', '/api/v1/spaces/team/invites', { role: 'administrator' }))
            .status
        ).toBe(403);
        const attempts = [
          await grace.request('PATCH', '/api/v1/spaces/team/members/linus', {
            role: 'administrator',
          }),
          await grace.request('PATCH', '/api/v1/spaces/team/members/eve', { role: 'solver' }),
          await grace.request('PATCH', '/api/v1/spaces/team/members/ada', { role: 'solver' }),
          await grace.request('PATCH', '/api/v1/spaces/team/members/linus', { role: 'owner' }),
          await grace.request('DELETE', '/api/v1/spaces/team/members/eve'),
          await grace.request('DELETE', '/api/v1/spaces/team/members/ada'),
        ];
        expect(attempts.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
        expect(await roleOf(eve)).toBe('administrator');
        expect(await roleOf(linus)).toBe('solver');
      });

      it('an administrator cannot touch the dangerous settings but can edit the rest', async () => {
        const { grace } = await withAdmin();
        expect(
          (await grace.request('PATCH', '/api/v1/spaces/team', { description: 'Hello' })).status
        ).toBe(200);
        expect(
          (await grace.request('PATCH', '/api/v1/spaces/team', { visibility: 'public' })).status
        ).toBe(403);
        expect((await grace.request('POST', '/api/v1/spaces/team/archive')).status).toBe(403);
        // setting the visibility it already has is not a change
        expect(
          (await grace.request('PATCH', '/api/v1/spaces/team', { visibility: 'private' })).status
        ).toBe(200);
      });

      it('an administrator may leave', async () => {
        const { grace } = await withAdmin();
        expect((await grace.request('POST', '/api/v1/spaces/team/leave')).status).toBe(204);
      });

      it('editors, observers and solvers cannot run the members', async () => {
        const { ada, grace, linus, eve } = await setup();
        await join(ada, grace, 'editor');
        await join(ada, linus, 'observer');
        await join(ada, eve, 'solver');
        for (const client of [grace, linus, eve]) {
          expect(
            (await client.request('POST', '/api/v1/spaces/team/invites', { role: 'solver' })).status
          ).toBe(403);
          expect(
            (await client.request('PATCH', '/api/v1/spaces/team/members/eve', { role: 'editor' }))
              .status
          ).toBe(403);
        }
      });

      it('an observer sees the member list but changes nothing', async () => {
        const { ada, linus } = await setup();
        await join(ada, linus, 'observer');
        expect((await linus.request('GET', '/api/v1/spaces/team/members')).status).toBe(200);
        expect(
          (await linus.request('PATCH', '/api/v1/spaces/team', { description: 'x' })).status
        ).toBe(403);
      });

      it('only the owner can revoke an invitation to administrator', async () => {
        const { ada, grace } = await withAdmin();
        const invite = await ada.request('POST', '/api/v1/spaces/team/invites', {
          role: 'administrator',
        });
        expect(
          (await grace.request('DELETE', `/api/v1/spaces/team/invites/${invite.body.id}`)).status
        ).toBe(403);
        expect(
          (await ada.request('DELETE', `/api/v1/spaces/team/invites/${invite.body.id}`)).status
        ).toBe(204);
      });
    });

    describe('the database enforces the owner rule as a backstop (GRD-14)', () => {
      it('refuses to commit a Space without an owner', async () => {
        const { ada } = await setup();
        const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
        await expect(
          t.prisma.membership.deleteMany({
            where: { space_id: space.id, user: { username: 'ada' } },
          })
        ).rejects.toThrow(/at least one owner/);
        await expect(
          t.prisma.membership.updateMany({
            where: { space_id: space.id },
            data: { role: 'solver' },
          })
        ).rejects.toThrow(/at least one owner/);
        expect(await roleOf(ada)).toBe('owner');
      });

      it('refuses a new Space created without an owner', async () => {
        const { ada } = await setup();
        const user = await t.prisma.user.findUniqueOrThrow({ where: { username: 'ada' } });
        await expect(
          t.prisma.space.create({
            data: { created_by_id: user.id, name: 'Ownerless', slug: 'ownerless' },
          })
        ).rejects.toThrow(/at least one owner/);
        expect((await ada.request('GET', '/api/v1/spaces/ownerless')).status).toBe(404);
      });

      it('refuses a second owner in the same Space', async () => {
        await setup();
        const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
        const grace = await t.prisma.user.findUniqueOrThrow({ where: { username: 'grace' } });
        await expect(
          t.prisma.membership.create({
            data: { space_id: space.id, user_id: grace.id, role: 'owner' },
          })
        ).rejects.toThrow();
      });

      it('a user cannot be a member of a Space twice', async () => {
        await setup();
        const space = await t.prisma.space.findUniqueOrThrow({ where: { slug: 'team' } });
        const user = await t.prisma.user.findUniqueOrThrow({ where: { username: 'ada' } });
        await expect(
          t.prisma.membership.create({
            data: { space_id: space.id, user_id: user.id, role: 'solver' },
          })
        ).rejects.toThrow();
      });

      it('rejects stored identifiers that are not lower-case', async () => {
        await setup();
        await expect(
          t.prisma.$executeRawUnsafe(`UPDATE users SET username = 'Ada' WHERE username = 'ada'`)
        ).rejects.toThrow();
        await expect(
          t.prisma.$executeRawUnsafe(`UPDATE spaces SET slug = 'Team' WHERE slug = 'team'`)
        ).rejects.toThrow();
      });
    });
  }
);
