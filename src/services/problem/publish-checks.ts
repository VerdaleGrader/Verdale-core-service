export interface PublishCheck {
  key: 'statement' | 'languages' | 'sample_test' | 'tests' | 'outputs' | 'solution';
  ok: boolean;
  message: string;
}

export interface PublishFacts {
  statement: string;
  statementMode: 'markdown' | 'pdf';
  hasStatementPdf: boolean;
  languageCount: number;
  testCount: number;
  sampleCount: number;
  /** Testcases without an expected output. */
  missingOutputCount: number;
  hasPrimarySolution: boolean;
}

/**
 * What a draft needs before it can be published. Milestone 4 adds the
 * verification run (the reference solution against every test on Judge) in
 * front of this; these cheap checks stay as the first gate.
 */
export function buildPublishChecks(facts: PublishFacts): PublishCheck[] {
  return [
    statementCheck(facts),
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
        facts.testCount >= 1 ? `${facts.testCount} testcase(s) added.` : 'Add at least one testcase.',
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
      key: 'solution',
      ok: facts.hasPrimarySolution,
      message: facts.hasPrimarySolution
        ? 'A primary reference solution is attached.'
        : 'Attach a reference solution and mark it as primary.',
    },
  ];
}

function statementCheck(facts: PublishFacts): PublishCheck {
  if (facts.statementMode === 'pdf') {
    return {
      key: 'statement',
      ok: facts.hasStatementPdf,
      message: facts.hasStatementPdf
        ? 'The statement is a PDF.'
        : 'Upload the PDF statement, or switch back to Markdown.',
    };
  }
  const written = facts.statement.trim().length > 0;
  return {
    key: 'statement',
    ok: written,
    message: written ? 'The statement is written.' : 'Write the statement.',
  };
}
