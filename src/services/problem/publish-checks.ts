export interface PublishCheck {
  key: 'statement' | 'languages' | 'sample_test' | 'tests' | 'solution';
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
  hasPrimarySolution: boolean;
}

/**
 * What a draft needs before it can be published. Milestone 4 adds the
 * verification run (the reference solution against every test on Judge) in
 * front of this; these cheap checks stay as the first gate.
 */
export function buildPublishChecks(facts: PublishFacts): PublishCheck[] {
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
      key: 'tests',
      ok: facts.testCount >= 1,
      message:
        facts.testCount >= 1 ? `${facts.testCount} test(s) added.` : 'Add at least one test.',
    },
    {
      key: 'sample_test',
      ok: facts.sampleCount >= 1,
      message:
        facts.sampleCount >= 1
          ? `${facts.sampleCount} sample test(s) shown to solvers.`
          : 'Mark at least one test as a sample so solvers can see an example.',
    },
    {
      key: 'solution',
      ok: facts.hasPrimarySolution,
      message: facts.hasPrimarySolution
        ? 'A primary reference solution is attached.'
        : 'Attach a reference solution and mark it as primary.',
    },
  ];
}
