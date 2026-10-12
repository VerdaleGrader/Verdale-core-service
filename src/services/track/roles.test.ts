import {
  Cast,
  castSpace,
  createDraft,
  createPublishedProblem,
  joinSpace,
  problemUrl,
} from '@/test/fixtures';
import { Client, createTestApp, describeDb, resetDatabase, TestApp } from '@/test/harness';

/** GRD-96/97 on top of Tracks: administrators manage them, observers only read. */
describeDb('Administrator and Observer in Tracks (GRD-96, GRD-97)', () => {
  let t: TestApp;
  let cast: Cast;
  let admin: Client;
  let observer: Client;
  beforeEach(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    cast = await castSpace(t, { visibility: 'public' });
    admin = await joinSpace(t, cast, 'ada', 'administrator');
    observer = await joinSpace(t, cast, 'obi', 'observer');
    await createPublishedProblem(cast, 'pa');
    await createDraft(cast.editor, 'team', 'wip');
    await cast.editor.request('POST', '/api/v1/spaces/team/collections/general-set/problems', {
      problem_slugs: ['wip'],
    });
    await cast.owner.request('POST', '/api/v1/spaces/team/tracks', {
      name: 'Secret',
      slug: 'secret',
      visibility: 'members',
    });
  });
  afterEach(async () => t.close());

  const tracks = '/api/v1/spaces/team/tracks';
  const slugs = (body: { items: Array<{ slug: string }> }) => body.items.map((item) => item.slug);

  it('an administrator manages Tracks, Collections and Track members like an editor', async () => {
    const created = await admin.request('POST', tracks, { name: 'Extra', slug: 'extra' });
    expect(created.status).toBe(201);
    const patched = await admin.request('PATCH', `${tracks}/secret`, { name: 'Secret 2' });
    expect(patched.status).toBe(200);
    const invite = await admin.request('POST', `${tracks}/secret/invites`, {});
    expect(invite.status).toBe(201);
    const collection = await admin.request('POST', '/api/v1/spaces/team/collections', {
      name: 'Made by admin',
      slug: 'by-admin',
    });
    expect(collection.status).toBe(201);
  });

  it('an observer sees every Track, members-only ones and drafts included', async () => {
    expect(slugs((await cast.solver.request('GET', tracks)).body)).toEqual(['general']);
    expect(slugs((await observer.request('GET', tracks)).body).sort()).toEqual([
      'general',
      'secret',
    ]);
    expect((await observer.request('GET', `${tracks}/secret`)).status).toBe(200);
    expect((await cast.solver.request('GET', `${tracks}/secret`)).status).toBe(404);

    const detail = await observer.request('GET', `${tracks}/general`);
    const problems = detail.body.collections.flatMap((c: { problems: Array<{ slug: string }> }) =>
      c.problems.map((p) => p.slug)
    );
    expect(problems.sort()).toEqual(['pa', 'wip']);
    expect((await observer.request('GET', problemUrl('team', 'wip'))).status).toBe(200);
  });

  it('an observer reads hidden tests and solutions but changes nothing', async () => {
    expect((await observer.request('GET', problemUrl('team', 'pa', '/tests'))).status).toBe(200);
    expect((await observer.request('GET', problemUrl('team', 'pa', '/solutions'))).status).toBe(
      200
    );
    expect((await cast.solver.request('GET', problemUrl('team', 'pa', '/tests'))).status).toBe(403);

    const attempts = [
      observer.request('POST', tracks, { name: 'Nope', slug: 'nope' }),
      observer.request('PATCH', `${tracks}/general`, { name: 'Nope' }),
      observer.request('POST', `${tracks}/general/invites`, {}),
      observer.request('POST', '/api/v1/spaces/team/problems', {
        slug: 'no-way',
        title: 'No way',
      }),
      observer.request('POST', problemUrl('team', 'pa', '/publish')),
    ];
    for (const response of await Promise.all(attempts)) expect(response.status).toBe(403);
  });

  it('progress of other people is for the staff, observers included; solvers see only their own', async () => {
    const members = await observer.request('GET', `${tracks}/general/progress/members`);
    expect(members.status).toBe(200);
    expect(
      members.body.items.map((item: { user: { username: string } }) => item.user.username)
    ).toEqual(['sol']);
    const someone = await observer.request('GET', `${tracks}/general/progress?username=sol`);
    expect(someone.status).toBe(200);
    expect(someone.body.user.username).toBe('sol');
    expect((await admin.request('GET', `${tracks}/general/progress/members`)).status).toBe(200);

    expect((await cast.solver.request('GET', `${tracks}/general/progress/members`)).status).toBe(
      403
    );
    expect(
      (await cast.solver.request('GET', `${tracks}/general/progress?username=edith`)).status
    ).toBe(403);
  });

  it('progress stays readable for the staff once the Space is archived', async () => {
    expect((await cast.owner.request('POST', '/api/v1/spaces/team/archive')).status).toBe(200);
    expect((await observer.request('GET', `${tracks}/general/progress/members`)).status).toBe(200);
    expect((await admin.request('POST', tracks, { name: 'Late', slug: 'late' })).status).toBe(403);
  });
});
