import { Client, TestApp, jobResult } from '@/test/harness';

/** A Space with one user of every kind, for permission tests. */
export interface Cast {
  owner: Client;
  editor: Client;
  solver: Client;
  /** Logged in, but not a member of the Space. */
  outsider: Client;
  visitor: Client;
  slug: string;
  /** The app under test, for helpers that need Judge (verify before publish). */
  app: TestApp;
}

export async function castSpace(
  t: TestApp,
  {
    visibility = 'private',
    slug = 'team',
  }: { visibility?: 'public' | 'private'; slug?: string } = {}
): Promise<Cast> {
  const signUp = (name: string) =>
    t.login({ providerAccountId: name, email: `${name}@example.com`, usernameHint: name });
  const [owner, editor, solver, outsider] = [
    await signUp('olivia'),
    await signUp('edith'),
    await signUp('sol'),
    await signUp('otto'),
  ];
  await owner.request('POST', '/api/v1/spaces', { name: 'Team', slug, visibility });
  for (const [client, role] of [
    [editor, 'editor'],
    [solver, 'solver'],
  ] as const) {
    const invite = await owner.request('POST', `/api/v1/spaces/${slug}/invites`, { role });
    const accepted = await client.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
    if (accepted.status !== 200) throw new Error(`could not add the ${role}: ${accepted.status}`);
  }
  return { owner, editor, solver, outsider, visitor: t.anonymous(), slug, app: t };
}

/** A new account that joins the Space with the given role, by invitation from the owner. */
export async function joinSpace(
  t: TestApp,
  cast: Cast,
  name: string,
  role: 'administrator' | 'editor' | 'observer' | 'solver'
): Promise<Client> {
  const client = await t.login({
    providerAccountId: name,
    email: `${name}@example.com`,
    usernameHint: name,
  });
  const invite = await cast.owner.request('POST', `/api/v1/spaces/${cast.slug}/invites`, { role });
  const accepted = await client.request('POST', `/api/v1/invites/${invite.body.token}/accept`);
  if (accepted.status !== 200) throw new Error(`could not add the ${role}: ${accepted.status}`);
  return client;
}

export const problemUrl = (space: string, problem: string, suffix = '') =>
  `/api/v1/spaces/${space}/problems/${problem}${suffix}`;

export async function createDraft(
  client: Client,
  space: string,
  slug = 'sum',
  extra: Record<string, unknown> = {}
) {
  const response = await client.request('POST', `/api/v1/spaces/${space}/problems`, {
    slug,
    title: 'Sum of two numbers',
    statement: 'Read $a$ and $b$ and print $a + b$.',
    ...extra,
  });
  if (response.status !== 201) {
    throw new Error(
      `could not create the draft: ${response.status} ${JSON.stringify(response.body)}`
    );
  }
  return response.body;
}

export function addTest(
  client: Client,
  space: string,
  problem: string,
  input: string | Buffer,
  output: string | Buffer,
  isSample = false
) {
  return client.upload('POST', problemUrl(space, problem, '/tests'), [
    { name: 'input', filename: 'in.txt', content: input },
    { name: 'output', filename: 'out.txt', content: output },
    { name: 'is_sample', content: String(isSample) },
  ]);
}

export const SOLUTION_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}\n';

/** Hidden marker strings that must never appear in any solver-facing response. */
export const HIDDEN = { input: '987654321 123456789\n', output: '1111111110\n' };

/**
 * Puts a problem in a Collection of the Space's starter Track "General" (GRD-81): solvers,
 * outsiders and visitors only reach problems through a Track. Creates the Collection when it
 * is not there yet. `track` can be any Track slug.
 */
export async function placeInTrack(
  cast: Cast,
  problemSlug: string,
  { track = 'general', collection = 'general-set' }: { track?: string; collection?: string } = {}
) {
  const base = `/api/v1/spaces/${cast.slug}`;
  const created = await cast.editor.request('POST', `${base}/collections`, {
    name: collection,
    slug: collection,
    track_slugs: [track],
  });
  if (created.status !== 201 && created.status !== 409) {
    throw new Error(
      `could not create the collection: ${created.status} ${JSON.stringify(created.body)}`
    );
  }
  if (created.status === 409) {
    await cast.editor.request('POST', `${base}/tracks/${track}/collections`, {
      collection_slugs: [collection],
    });
  }
  const added = await cast.editor.request('POST', `${base}/collections/${collection}/problems`, {
    problem_slugs: [problemSlug],
  });
  if (added.status !== 200) {
    throw new Error(`could not add the problem: ${added.status} ${JSON.stringify(added.body)}`);
  }
}

/**
 * Verifies the draft the way the web app does: asks for it, lets the fake Judge accept the
 * job and answers it with a result where every test is AC (or what `override` says).
 */
export async function verifyDraft(
  cast: Cast,
  slug: string,
  override: Parameters<typeof jobResult>[1] = {}
) {
  const started = await cast.editor.request('POST', problemUrl(cast.slug, slug, '/verify'));
  if (started.status !== 202) {
    throw new Error(`could not verify: ${started.status} ${JSON.stringify(started.body)}`);
  }
  await cast.app.settle();
  const job = cast.app.judge.last;
  // The verify job is not what the test is about: take it off the fake Judge's list.
  cast.app.judge.jobs = cast.app.judge.jobs.filter((candidate) => candidate !== job);
  const delivered = await cast.app.deliver(jobResult(job, { kind: 'verify', ...override }));
  if (delivered.status !== 204) {
    throw new Error(`verify result refused: ${delivered.status} ${JSON.stringify(delivered.body)}`);
  }
  return started.body;
}

/**
 * A published problem: one sample ("1 2" -> "3") and one hidden test, and a
 * primary reference solution. Returns what the leak checks need.
 */
export async function createPublishedProblem(
  cast: Cast,
  slug = 'sum',
  extra: Record<string, unknown> = {},
  { placed = true }: { placed?: boolean } = {}
) {
  await createDraft(cast.editor, cast.slug, slug, extra);
  const sample = await addTest(cast.editor, cast.slug, slug, '1 2\n', '3\n', true);
  const hidden = await addTest(cast.editor, cast.slug, slug, HIDDEN.input, HIDDEN.output, false);
  const solution = await cast.editor.request('POST', problemUrl(cast.slug, slug, '/solutions'), {
    language: 'cpp',
    source: SOLUTION_SOURCE,
  });
  await verifyDraft(cast, slug);
  const published = await cast.editor.request('POST', problemUrl(cast.slug, slug, '/publish'));
  if (published.status !== 200) {
    throw new Error(`could not publish: ${published.status} ${JSON.stringify(published.body)}`);
  }
  if (placed) await placeInTrack(cast, slug);
  return {
    slug,
    sample: sample.body,
    hidden: hidden.body,
    solution: solution.body,
    editor: published.body,
  };
}

/** Everything a submission test needs: a public Space, a published problem and a judge job. */
export async function submitCode(
  client: Client,
  space: string,
  problem: string,
  body: { language?: string; source?: string; track?: string } = {}
) {
  return client.request('POST', problemUrl(space, problem, '/submissions'), {
    language: 'cpp',
    source: SOLUTION_SOURCE,
    ...body,
  });
}
