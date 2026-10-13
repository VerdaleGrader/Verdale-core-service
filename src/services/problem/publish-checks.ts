import { MEMORY_LIMIT_KB, TIME_LIMIT_MS } from '@/constants/limits';

export interface PublishCheck {
  key:
    | 'statement'
    | 'languages'
    | 'limits'
    | 'sample_test'
    | 'tests'
    | 'hidden_tests'
    | 'outputs'
    | 'solution'
    | 'verified';
  ok: boolean;
  message: string;
}

export interface PublishFacts {
  statement: string;
  /** In PDF mode the uploaded file is the statement and the text may stay empty. */
  statementMode?: 'markdown' | 'pdf';
  hasPdf?: boolean;
  languageCount: number;
  testCount: number;
  sampleCount: number;
  /** Testcases without an expected output. */
  missingOutputCount: number;
  hasPrimarySolution: boolean;
  timeLimitMs: number;
  memoryLimitKb: number;
  /** Hidden (not Visible to solvers) testcases a version needs; `PUBLISH_MIN_HIDDEN_TESTS`. */
  minHiddenTests: number;
  /** The version passed verification and nothing it was verified against changed since. */
  verified: boolean;
  /** What to say when `verified` is false. */
  verifiedHint?: string;
}

/**
 * What a draft needs before it can be published (GRD-52). Every check says what
 * is missing or what is in place, so an author knows exactly which one failed.
 * Everything except `verified` is cheap and is also required before a
 * verification run can start.
 */
export function buildPublishChecks(facts: PublishFacts): PublishCheck[] {
  const hiddenCount = Math.max(0, facts.testCount - facts.sampleCount);
  const hiddenOk = hiddenCount >= facts.minHiddenTests;
  const timeOk = facts.timeLimitMs >= TIME_LIMIT_MS.min && facts.timeLimitMs <= TIME_LIMIT_MS.max;
  const memoryOk =
    facts.memoryLimitKb >= MEMORY_LIMIT_KB.min && facts.memoryLimitKb <= MEMORY_LIMIT_KB.max;
  const pdf = facts.statementMode === 'pdf';
  const statementOk = pdf ? facts.hasPdf === true : facts.statement.trim().length > 0;
  return [
    {
      key: 'statement',
      ok: statementOk,
      message: statementOk
        ? pdf
          ? 'The PDF statement is uploaded.'
          : 'The statement is written.'
        : pdf
          ? 'Upload the PDF statement.'
          : 'Write the statement.',
    },
    {
      key: 'languages',
      ok: facts.languageCount >= 1,
      message:
        facts.languageCount >= 1
          ? 'At least one language is allowed.'
          : 'Allow at least one language.',
    },
    {
      key: 'limits',
      ok: timeOk && memoryOk,
      message:
        timeOk && memoryOk
          ? 'The time and memory limits are within range.'
          : [
              timeOk
                ? null
                : `Set the time limit between ${TIME_LIMIT_MS.min} and ${TIME_LIMIT_MS.max} ms.`,
              memoryOk
                ? null
                : `Set the memory limit between ${MEMORY_LIMIT_KB.min} and ${MEMORY_LIMIT_KB.max} KB.`,
            ]
              .filter(Boolean)
              .join(' '),
    },
    {
      key: 'tests',
      ok: facts.testCount >= 1,
      message:
        facts.testCount >= 1
          ? `${facts.testCount} testcase(s) added.`
          : 'Add at least one testcase.',
    },
    {
      key: 'outputs',
      ok: facts.missingOutputCount === 0,
      message:
        facts.missingOutputCount === 0
          ? 'Every testcase has an expected output.'
          : `${facts.missingOutputCount} testcase(s) have no expected output yet. Upload one or generate it from a solution.`,
    },
    {
      key: 'sample_test',
      ok: facts.sampleCount >= 1,
      message:
        facts.sampleCount >= 1
          ? `${facts.sampleCount} sample testcase(s) shown to solvers.`
          : 'Mark at least one testcase as a sample so solvers can see an example.',
    },
    {
      key: 'hidden_tests',
      ok: hiddenOk,
      message: hiddenOk
        ? `${hiddenCount} hidden testcase(s) (at least ${facts.minHiddenTests} needed).`
        : `Add at least ${facts.minHiddenTests} hidden testcase(s) (not Visible to solvers); there are ${hiddenCount}.`,
    },
    {
      key: 'solution',
      ok: facts.hasPrimarySolution,
      message: facts.hasPrimarySolution
        ? 'A primary reference solution is attached.'
        : 'Attach a reference solution and mark it as primary.',
    },
    {
      key: 'verified',
      ok: facts.verified,
      message: facts.verified
        ? 'The reference solution passed every test on Judge.'
        : (facts.verifiedHint ??
          'Run the verification: the reference solution must pass every test on Judge.'),
    },
  ];
}
