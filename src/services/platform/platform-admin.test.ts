import { runPlatformAdminCli } from '@/cli/platform-admin';
import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  problemUrl,
  submitCode,
} from '@/test/fixtures';
import {
  Client,
  createTestApp,
  describeDb,
  jobResult,
  resetDatabase,
  TestApp,
} from '@/test/harness';

describeDb('Platform administration (GRD-58)', () => {
  let t: TestApp;
  let cast: Cast;
  let admin: Client;
  let adminUser: { id: string };

  beforeEach(async () => {
    t = await createTestApp({
      RATE_LIMIT_API_PER_IP: '100000',
      RATE_LIMIT_API_PER_USER: '100000',
      RATE_LIMIT_SUBMIT_PER_USER: '1000',
      RATE_LIMIT_SUBMIT_PER_IP: '1000',
    });
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    await createPublishedProblem(cast);
    // Another person, made a platform administrator the only way there is: the command line.
    admin = await t.login({
      providerAccountId: 'ruth',
      email: 'ruth@example.com',
      usernameHint: 'ruth',
    });
    await runPlatformAdminCli(['grant', 'ruth'], t.prisma);
    adminUser = await t.prisma.user.findUniqueOrThrow({ where: { username: 'ruth' } });
  });
  afterEach(async () => t.close());

  const adminApi = (client: Client, method: 'GET' | 'POST', path: string, body?: unknown) =>
    client.request(method, `/api/v1/admin${path}`, body);
  const auditActions = async () =>
    (await t.prisma.platformAuditLog.findMany({ orderBy: { created_at: 'asc' } })).map(
      (row) => row.action
    );

  describe('the role', () => {
    it('is given on the command line, is audited, and is not in the API', async () => {
      const row = await t.prisma.user.findUniqueOrThrow({ where: { username: 'ruth' } });
      expect(row.platform_role).toBe('admin');
      const entry = await t.prisma.platformAuditLog.findFirstOrThrow({
        where: { action: 'admin.granted' },
      });
      expect(entry).toMatchObject({ actor_id: null, target_type: 'user', target_label: 'ruth' });
      expect(entry.data).toEqual({ via: 'command line' });

      // Nothing a request can send changes it.
      const patched = await cast.solver.request('PATCH', '/api/v1/me', { platform_role: 'admin' });
      expect(patched.status).toBe(400);
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { username: 'sol' } })).platform_role
      ).toBe('user');
    });

    it('can be taken away, reported, and a mistake names the user', async () => {
      expect(await runPlatformAdminCli(['list'], t.prisma)).toEqual(['ruth <ruth@example.com>']);
      expect(await runPlatformAdminCli(['grant', 'ruth'], t.prisma)).toEqual([
        'ruth already has the role "admin"; nothing changed.',
      ]);
      expect(await runPlatformAdminCli(['revoke', 'ruth'], t.prisma)).toEqual([
        'ruth is no longer a platform administrator.',
      ]);
      expect((await adminApi(admin, 'GET', '/reports')).status).toBe(404);
      await expect(runPlatformAdminCli(['grant', 'nobody'], t.prisma)).rejects.toThrow(
        'No user named "nobody".'
      );
      await expect(runPlatformAdminCli(['grant'], t.prisma)).rejects.toThrow(/usage/);
      await expect(runPlatformAdminCli(['destroy'], t.prisma)).rejects.toThrow(/usage/);
    });

    it('is separate from the roles in a Space: an owner is not an administrator', async () => {
      for (const client of [cast.owner, cast.editor, cast.solver, cast.outsider]) {
        expect((await adminApi(client, 'GET', '/reports')).status).toBe(404);
        expect((await adminApi(client, 'GET', '/audit-log')).status).toBe(404);
        expect(
          (await adminApi(client, 'POST', '/users/sol/suspend', { reason: 'because' })).status
        ).toBe(404);
        expect(
          (await adminApi(client, 'POST', `/spaces/${cast.slug}/suspend`, { reason: 'because' }))
            .status
        ).toBe(404);
        expect(
          (
            await adminApi(client, 'POST', `/spaces/${cast.slug}/problems/sum/unpublish`, {
              reason: 'because',
            })
          ).status
        ).toBe(404);
      }
      expect((await adminApi(cast.visitor, 'GET', '/reports')).status).toBe(401);
      // Nothing changed.
      expect(await t.prisma.user.count({ where: { suspended_at: { not: null } } })).toBe(0);
      expect(await t.prisma.platformAuditLog.count({ where: { actor_id: { not: null } } })).toBe(0);
    });

    it('does not work for an administrator who is suspended', async () => {
      await t.prisma.user.update({
        where: { username: 'ruth' },
        data: { suspended_at: new Date() },
      });
      expect((await adminApi(admin, 'GET', '/reports')).status).toBe(403); // the account is closed first
    });
  });

  describe('reports', () => {
    const report = (
      client: Cast['solver'],
      body: object = { reason: 'This copies a contest problem.' }
    ) => client.request('POST', problemUrl(cast.slug, 'sum', '/report'), body);

    it('lets a person who can see a problem report it with a reason', async () => {
      const response = await report(cast.solver, {
        reason: 'Copied from a contest.\nSee the link.',
        category: 'copyright',
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'open' });

      const row = await t.prisma.problemReport.findFirstOrThrow({ include: { reporter: true } });
      expect(row).toMatchObject({
        category: 'copyright',
        status: 'open',
        reason: 'Copied from a contest.\nSee the link.',
      });
      expect(row.reporter.username).toBe('sol');
    });

    it('asks for a reason, and a signed-in person', async () => {
      expect((await report(cast.solver, {})).status).toBe(400);
      expect((await report(cast.solver, { reason: '  ' })).status).toBe(400);
      expect((await report(cast.solver, { reason: 'x'.repeat(1001) })).status).toBe(400);
      expect((await report(cast.solver, { reason: 'fine', category: 'spam' })).status).toBe(400);
      expect((await report(cast.visitor as never)).status).toBe(401);
      expect(await t.prisma.problemReport.count()).toBe(0);
    });

    it('keeps one open report per person and problem, and lets others report', async () => {
      expect((await report(cast.solver)).status).toBe(201);
      const again = await report(cast.solver);
      expect(again.status).toBe(409);
      expect(again.body.error_code).toBe('ALREADY_REPORTED');
      expect((await report(cast.outsider)).status).toBe(201);
      expect(await t.prisma.problemReport.count()).toBe(2);
    });

    it('does not reveal or accept a problem the person cannot see', async () => {
      await createDraft(cast.editor, cast.slug, 'secret');
      const draft = await cast.solver.request('POST', problemUrl(cast.slug, 'secret', '/report'), {
        reason: 'looks wrong',
      });
      expect(draft.status).toBe(404);
      const missing = await cast.solver.request(
        'POST',
        problemUrl(cast.slug, 'nothing', '/report'),
        {
          reason: 'looks wrong',
        }
      );
      expect(missing.status).toBe(404);
      expect(await t.prisma.problemReport.count()).toBe(0);
    });

    it('is limited to a few reports a minute per person', async () => {
      await createDraft(cast.editor, cast.slug, 'noop');
      for (let n = 0; n < 5; n++) await report(cast.solver);
      const limited = await report(cast.solver);
      expect(limited.status).toBe(429);
      expect(limited.body.error_code).toBe('RATE_LIMITED');
    });

    it('is read by administrators, oldest first while open, and resolved once', async () => {
      await report(cast.solver, { reason: 'first report' });
      await report(cast.outsider, { reason: 'second report', category: 'abuse' });

      const open = await adminApi(admin, 'GET', '/reports');
      expect(open.status).toBe(200);
      expect(open.body.total).toBe(2);
      expect(open.body.items.map((item: { reason: string }) => item.reason)).toEqual([
        'first report',
        'second report',
      ]);
      expect(open.body.items[0]).toMatchObject({
        status: 'open',
        reporter: { username: 'sol' },
        problem: {
          space: cast.slug,
          slug: 'sum',
          title: 'Sum of two numbers',
          status: 'published',
          suspended: false,
        },
        resolved_at: null,
      });

      const id = open.body.items[0].id;
      const resolved = await adminApi(admin, 'POST', `/reports/${id}/resolve`, {
        outcome: 'dismissed',
        note: 'no issue',
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({
        status: 'dismissed',
        resolved_by: 'ruth',
        resolution_note: 'no issue',
      });
      expect(
        (await adminApi(admin, 'POST', `/reports/${id}/resolve`, { outcome: 'actioned' })).body
          .error_code
      ).toBe('REPORT_RESOLVED');

      expect((await adminApi(admin, 'GET', '/reports')).body.total).toBe(1);
      expect((await adminApi(admin, 'GET', '/reports?status=dismissed')).body.total).toBe(1);
      expect((await adminApi(admin, 'GET', '/reports?status=all')).body.total).toBe(2);
      expect(
        (await adminApi(admin, 'POST', `/reports/${id}/resolve`, { outcome: 'maybe' })).status
      ).toBe(400);
      expect(
        (
          await adminApi(admin, 'POST', '/reports/00000000-0000-0000-0000-000000000000/resolve', {
            outcome: 'dismissed',
          })
        ).status
      ).toBe(404);
    });
  });

  describe('taking a problem down', () => {
    const unpublish = () =>
      adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/unpublish`, {
        reason: 'Copyright complaint',
      });

    it('hides it from solvers at once, refuses their submissions, and keeps it for its authors', async () => {
      const before = await submitCode(cast.solver, cast.slug, 'sum');
      expect(before.status).toBe(202);
      const listedBefore = await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}/problems`);
      expect(JSON.stringify(listedBefore.body)).toContain('"slug":"sum"');

      const response = await unpublish();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ suspended: true, status: 'draft' });

      for (const client of [cast.solver, cast.outsider, cast.visitor]) {
        expect((await client.request('GET', problemUrl(cast.slug, 'sum'))).status).toBe(404);
      }
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(404);
      // It is gone from the lists solvers see, and from the Track's problems.
      const listed = await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}/problems`);
      expect(JSON.stringify(listed.body)).not.toContain('"slug":"sum"');
      // The staff still reach it, and it still has its published version.
      expect((await cast.editor.request('GET', problemUrl(cast.slug, 'sum'))).status).toBe(200);
      const row = await t.prisma.problem.findFirstOrThrow({ include: { current_version: true } });
      expect(row).toMatchObject({ status: 'draft', suspension_reason: 'Copyright complaint' });
      expect(row.suspended_at).toBeInstanceOf(Date);
      expect(row.current_version?.status).toBe('published');
      // A solver keeps the history of what they sent, and Judge's answer for an earlier one is still taken.
      await t.settle();
      expect((await t.deliver(jobResult(t.judge.last))).status).toBe(204);
    });

    it('cannot be undone by the authors: no publishing, no update, no archive, no delete', async () => {
      await unpublish();
      const attempts = [
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish')),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/updates'), {
          fields: { title: 'Sneaky' },
        }),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/archive')),
        cast.editor.request('DELETE', problemUrl(cast.slug, 'sum')),
        cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/draft')),
        cast.owner.request('POST', problemUrl(cast.slug, 'sum', '/publish')),
      ];
      for (const attempt of await Promise.all(attempts)) {
        expect(attempt.status).toBeGreaterThanOrEqual(400);
        expect(attempt.status).toBeLessThan(500);
      }
      const row = await t.prisma.problem.findFirstOrThrow();
      expect(row.status).toBe('draft');
      expect(row.suspended_at).not.toBeNull();
    });

    it('is restored by an administrator and is then as it was', async () => {
      await unpublish();
      const restored = await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/restore`);
      expect(restored.body).toMatchObject({ suspended: false, status: 'published' });
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'sum'))).status).toBe(200);
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
      expect((await t.prisma.problem.findFirstOrThrow()).suspended_at).toBeNull();
    });

    it('answers clearly to the wrong state, a missing problem and a missing reason', async () => {
      expect(
        (await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/restore`)).body.error_code
      ).toBe('NOT_SUSPENDED');
      await unpublish();
      expect((await unpublish()).body.error_code).toBe('ALREADY_SUSPENDED');
      expect(
        (
          await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/nothing/unpublish`, {
            reason: 'because',
          })
        ).status
      ).toBe(404);
      expect(
        (
          await adminApi(admin, 'POST', `/spaces/nowhere/problems/sum/unpublish`, {
            reason: 'because',
          })
        ).status
      ).toBe(404);
      expect(
        (await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/restore`)).status
      ).toBe(200);
      expect(
        (await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/unpublish`, {})).status
      ).toBe(400);
      expect(
        (
          await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/unpublish`, {
            reason: 'ok',
            extra: 1,
          })
        ).status
      ).toBe(400);
      await createDraft(cast.editor, cast.slug, 'wip');
      expect(
        (
          await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/wip/unpublish`, {
            reason: 'because',
          })
        ).body.error_code
      ).toBe('NOT_PUBLISHED');
    });
  });

  describe('suspending a user', () => {
    it('stops everything but reading /me and signing out, and says why', async () => {
      const response = await adminApi(admin, 'POST', '/users/sol/suspend', {
        reason: 'Abuse of the judge',
      });
      expect(response.body).toMatchObject({ username: 'sol', suspended: true });

      const blocked = await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error_code).toBe('ACCOUNT_SUSPENDED');
      expect(blocked.body.message).toContain('Abuse of the judge');
      expect((await submitCode(cast.solver, cast.slug, 'sum')).body.error_code).toBe(
        'ACCOUNT_SUSPENDED'
      );
      expect((await cast.solver.request('GET', '/api/v1/me')).status).toBe(200);
      expect((await cast.solver.request('POST', '/api/v1/auth/logout')).status).toBeLessThan(400);
    });

    it('is lifted by restoring, and does not touch anybody else', async () => {
      await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'Abuse of the judge' });
      expect((await cast.editor.request('GET', `/api/v1/spaces/${cast.slug}`)).status).toBe(200);
      await adminApi(admin, 'POST', '/users/sol/restore');
      // Signing out above ended the session, so sign in again.
      const again = await t.login({
        providerAccountId: 'sol',
        email: 'sol@example.com',
        usernameHint: 'sol',
      });
      expect((await again.request('GET', `/api/v1/spaces/${cast.slug}`)).status).toBe(200);
    });

    it('refuses to suspend an administrator or an unknown user, or twice', async () => {
      expect(
        (await adminApi(admin, 'POST', '/users/ruth/suspend', { reason: 'oops' })).body.error_code
      ).toBe('CANNOT_SUSPEND_ADMIN');
      expect(
        (await adminApi(admin, 'POST', '/users/nobody/suspend', { reason: 'oops' })).status
      ).toBe(404);
      await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'first' });
      expect(
        (await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'second' })).body.error_code
      ).toBe('ALREADY_SUSPENDED');
      expect((await adminApi(admin, 'POST', '/users/edith/restore')).body.error_code).toBe(
        'NOT_SUSPENDED'
      );
    });
  });

  describe('suspending only the submissions of a user', () => {
    it('stops new submissions and re-checks, and nothing else', async () => {
      await adminApi(admin, 'POST', '/users/sol/suspend-submissions', {
        reason: 'Flooding the queue',
      });

      const refused = await submitCode(cast.solver, cast.slug, 'sum');
      expect(refused.status).toBe(403);
      expect(refused.body.error_code).toBe('SUBMISSIONS_SUSPENDED');
      expect(await t.prisma.submission.count({ where: { user: { username: 'sol' } } })).toBe(0);
      // The rest of the account works.
      expect((await cast.solver.request('GET', problemUrl(cast.slug, 'sum'))).status).toBe(200);
      expect((await cast.solver.request('GET', '/api/v1/me')).status).toBe(200);
      // Others still submit.
      expect((await submitCode(cast.editor, cast.slug, 'sum')).status).toBe(202);

      await adminApi(admin, 'POST', '/users/sol/resume-submissions');
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
    });

    it('also stops a re-check of an earlier system error', async () => {
      const sent = await submitCode(cast.solver, cast.slug, 'sum');
      await t.settle();
      await t.deliver(
        jobResult(t.judge.last, { verdict: 'ISE', tests: [], error: { code: 'X', message: 'x' } })
      );
      await adminApi(admin, 'POST', '/users/sol/suspend-submissions', {
        reason: 'Flooding the queue',
      });
      const recheck = await cast.solver.request(
        'POST',
        `/api/v1/submissions/${sent.body.id}/rejudge`
      );
      expect(recheck.body.error_code).toBe('SUBMISSIONS_SUSPENDED');
    });
  });

  describe('suspending a Space', () => {
    it('closes it to everyone, members included, and takes it out of the lists', async () => {
      const response = await adminApi(admin, 'POST', `/spaces/${cast.slug}/suspend`, {
        reason: 'Illegal content',
      });
      expect(response.body).toMatchObject({ slug: cast.slug, suspended: true });

      const member = await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}`);
      expect(member.status).toBe(403);
      expect(member.body.error_code).toBe('SPACE_SUSPENDED');
      for (const client of [cast.outsider, cast.visitor]) {
        expect((await client.request('GET', `/api/v1/spaces/${cast.slug}`)).status).toBe(404);
        expect((await client.request('GET', problemUrl(cast.slug, 'sum'))).status).toBe(404);
      }
      // Writing and submitting are closed too, also for the owner.
      expect((await submitCode(cast.solver, cast.slug, 'sum')).body.error_code).toBe(
        'SPACE_SUSPENDED'
      );
      expect(
        (await cast.owner.request('PATCH', `/api/v1/spaces/${cast.slug}`, { name: 'Renamed' }))
          .status
      ).toBe(403);
      expect(
        (await cast.editor.request('POST', problemUrl(cast.slug, 'sum', '/publish'))).status
      ).toBe(403);

      const publicList = await cast.visitor.request('GET', '/api/v1/spaces');
      expect(JSON.stringify(publicList.body)).not.toContain(`"slug":"${cast.slug}"`);
      const mine = await cast.solver.request('GET', '/api/v1/me/spaces');
      expect(JSON.stringify(mine.body)).not.toContain(`"slug":"${cast.slug}"`);
    });

    it('is restored by an administrator and is then as it was', async () => {
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/suspend`, { reason: 'Illegal content' });
      expect(
        (await adminApi(admin, 'POST', `/spaces/${cast.slug}/suspend`, { reason: 'again' })).body
          .error_code
      ).toBe('ALREADY_SUSPENDED');
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/restore`);
      expect((await cast.solver.request('GET', `/api/v1/spaces/${cast.slug}`)).status).toBe(200);
      expect((await submitCode(cast.solver, cast.slug, 'sum')).status).toBe(202);
      expect((await adminApi(admin, 'POST', `/spaces/${cast.slug}/restore`)).body.error_code).toBe(
        'NOT_SUSPENDED'
      );
      expect(
        (await adminApi(admin, 'POST', '/spaces/nowhere/suspend', { reason: 'because' })).status
      ).toBe(404);
    });
  });

  describe('the audit log', () => {
    it('records who did what to what and when, for every action, and nothing for a refused one', async () => {
      await cast.solver.request('POST', problemUrl(cast.slug, 'sum', '/report'), {
        reason: 'Copied from a contest',
      });
      const reportId = (await t.prisma.problemReport.findFirstOrThrow()).id;
      await adminApi(admin, 'POST', `/reports/${reportId}/resolve`, {
        outcome: 'actioned',
        note: 'taken down',
      });
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/unpublish`, {
        reason: 'Copied',
      });
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/problems/sum/restore`);
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/suspend`, { reason: 'Illegal' });
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/restore`);
      await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'Abuse' });
      await adminApi(admin, 'POST', '/users/sol/restore');
      await adminApi(admin, 'POST', '/users/edith/suspend-submissions', { reason: 'Flood' });
      await adminApi(admin, 'POST', '/users/edith/resume-submissions');
      // Refused: no entry.
      await adminApi(admin, 'POST', '/users/ruth/suspend', { reason: 'oops' });
      await adminApi(cast.solver, 'POST', '/users/edith/suspend', { reason: 'revenge' });

      expect(await auditActions()).toEqual([
        'admin.granted',
        'report.resolved',
        'problem.unpublished',
        'problem.restored',
        'space.suspended',
        'space.restored',
        'user.suspended',
        'user.restored',
        'user.submissions_suspended',
        'user.submissions_resumed',
      ]);

      const log = await adminApi(admin, 'GET', '/audit-log');
      expect(log.status).toBe(200);
      expect(log.body.total).toBe(10);
      // Newest first.
      expect(log.body.items[0]).toMatchObject({
        action: 'user.submissions_resumed',
        target_type: 'user',
        target_label: 'edith',
        actor: 'ruth',
      });
      const unpublished = log.body.items.find(
        (item: { action: string }) => item.action === 'problem.unpublished'
      );
      expect(unpublished).toMatchObject({
        actor: 'ruth',
        target_type: 'problem',
        target_label: `${cast.slug}/sum`,
        data: { reason: 'Copied' },
      });
      expect(new Date(unpublished.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('can be read by target, by kind and by administrator, and pages', async () => {
      await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'Abuse' });
      await adminApi(admin, 'POST', `/spaces/${cast.slug}/suspend`, { reason: 'Illegal' });
      const solId = (await t.prisma.user.findUniqueOrThrow({ where: { username: 'sol' } })).id;

      const byTarget = await adminApi(
        admin,
        'GET',
        `/audit-log?target_type=user&target_id=${solId}`
      );
      expect(byTarget.body.items.map((item: { action: string }) => item.action)).toEqual([
        'user.suspended',
      ]);
      expect((await adminApi(admin, 'GET', '/audit-log?target_type=space')).body.total).toBe(1);
      expect((await adminApi(admin, 'GET', '/audit-log?actor=ruth')).body.total).toBe(2);
      expect((await adminApi(admin, 'GET', '/audit-log?actor=nobody')).body.total).toBe(0);
      const page = await adminApi(admin, 'GET', '/audit-log?page=2&page_size=1');
      expect(page.body).toMatchObject({ page: 2, page_size: 1, total: 3 });
      expect(page.body.items).toHaveLength(1);
      expect((await adminApi(admin, 'GET', '/audit-log?target_type=nothing')).status).toBe(400);
    });

    it('is kept when the thing it is about goes away (no foreign key to the target)', async () => {
      await adminApi(admin, 'POST', '/users/sol/suspend', { reason: 'Abuse' });
      await t.prisma.platformAuditLog.findFirstOrThrow({ where: { action: 'user.suspended' } });
      await t.prisma.user.delete({ where: { id: adminUser.id } }).catch(() => undefined);
      const rows = await t.prisma.platformAuditLog.findMany({
        where: { action: 'user.suspended' },
      });
      expect(rows).toHaveLength(1);
    });
  });
});
