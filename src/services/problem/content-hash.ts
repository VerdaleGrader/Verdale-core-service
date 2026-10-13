import { createHash } from 'node:crypto';

export interface HashTest {
  position: number;
  input_sha256: string;
  output_sha256: string | null;
  is_sample: boolean;
}

export interface HashSolution {
  language: string;
  source: string;
  is_primary: boolean;
}

export interface HashContent {
  tests: HashTest[];
  solutions: HashSolution[];
  time_limit_ms: number;
  memory_limit_kb: number;
  allowed_languages: string[];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * What a verification run is bound to (GRD-51): the tests in order (input and
 * output hashes, Visible to solvers), the reference solutions, the limits and
 * the allowed languages. Same content, same hash, whatever the row ids, the
 * order rows were read in or when they were created; the statement and title
 * are not part of it.
 */
export function contentHash(content: HashContent): string {
  const tests = [...content.tests]
    .sort((a, b) => a.position - b.position)
    .map((test) => [test.input_sha256, test.output_sha256 ?? '', test.is_sample ? 1 : 0]);
  const solutions = content.solutions
    .map((solution) => [solution.is_primary ? 1 : 0, solution.language, sha(solution.source)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha(
    JSON.stringify({
      tests,
      solutions,
      time_limit_ms: content.time_limit_ms,
      memory_limit_kb: content.memory_limit_kb,
      allowed_languages: [...content.allowed_languages].sort(),
    })
  );
}
