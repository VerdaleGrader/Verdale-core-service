import { Client, TestApp } from '@/test/harness';

/** A Space with one user of every kind, for permission tests. */
export interface Cast {
  owner: Client;
  editor: Client;
  solver: Client;
  /** Logged in, but not a member of the Space. */
  outsider: Client;
  visitor: Client;
  slug: string;
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
  return { owner, editor, solver, outsider, visitor: t.anonymous(), slug };
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
 * Makes a problem reachable for solvers (GRD-81): puts it in the Collection
 * "main" and the Collection in the Space's starting Track, "general". Safe to
 * call again for more problems.
 */
export async function exposeProblem(
  client: Client,
  space: string,
  problem: string,
  { collection = 'main', track = 'general' }: { collection?: string; track?: string } = {}
) {
  const base = `/api/v1/spaces/${space}`;
  const made = await client.request('POST', `${base}/collections`, {
    name: collection,
    slug: collection,
  });
  if (made.status !== 201 && made.status !== 409) {
    throw new Error(`could not create the collection: ${made.status} ${JSON.stringify(made.body)}`);
  }
  const added = await client.request('PATCH', `${base}/collections/${collection}/problems`, {
    add: [problem],
  });
  if (added.status !== 200) {
    throw new Error(`could not add the problem: ${added.status} ${JSON.stringify(added.body)}`);
  }
  const current = await client.request('GET', `${base}/tracks/${track}`);
  const slugs = (current.body.collections as { slug: string }[]).map((item) => item.slug);
  if (!slugs.includes(collection)) {
    const set = await client.request('PUT', `${base}/tracks/${track}/collections`, {
      collection_slugs: [...slugs, collection],
    });
    if (set.status !== 200) throw new Error(`could not set the track: ${set.status}`);
  }
}

/**
 * A published problem: one sample ("1 2" -> "3") and one hidden test, and a
 * primary reference solution. Returns what the leak checks need.
 */
export async function createPublishedProblem(
  cast: Cast,
  slug = 'sum',
  extra: Record<string, unknown> = {},
  { expose = true }: { expose?: boolean } = {}
) {
  await createDraft(cast.editor, cast.slug, slug, extra);
  const sample = await addTest(cast.editor, cast.slug, slug, '1 2\n', '3\n', true);
  const hidden = await addTest(cast.editor, cast.slug, slug, HIDDEN.input, HIDDEN.output, false);
  const solution = await cast.editor.request('POST', problemUrl(cast.slug, slug, '/solutions'), {
    language: 'cpp',
    source: SOLUTION_SOURCE,
  });
  const published = await cast.editor.request('POST', problemUrl(cast.slug, slug, '/publish'));
  if (published.status !== 200) {
    throw new Error(`could not publish: ${published.status} ${JSON.stringify(published.body)}`);
  }
  if (expose) await exposeProblem(cast.owner, cast.slug, slug);
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
