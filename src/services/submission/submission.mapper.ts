import type { SubmissionListRow, SubmissionRecord } from '@/repositories/submission.repository';
import type { Language } from '@/services/problem/problem.mapper';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export type VerdictName = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE' | 'OLE' | 'ISE';
export type TestVerdictName = VerdictName | 'SKIPPED';
export type SubmissionStatusName = 'queued' | 'running' | 'completed';

export interface SubmissionSummaryDto {
  id: string;
  /** "Submission #3": its place among the author's submissions of this problem, oldest first. */
  number: number;
  problem: { slug: string; title: string };
  space: { name: string; slug: string };
  author: PublicUser;
  language: Language;
  status: SubmissionStatusName;
  verdict: VerdictName | null;
  time_ms: number | null;
  memory_kb: number | null;
  tests_passed: number | null;
  tests_total: number | null;
  /** The verdicts of the tests in judging order, as runs: enough to draw the progress bar. */
  test_runs: TestRunDto[];
  created_at: string;
  judged_at: string | null;
}

export interface TestRunDto {
  verdict: TestVerdictName;
  count: number;
}

export interface SubmissionTestResultDto {
  position: number;
  is_sample: boolean;
  verdict: TestVerdictName;
  time_ms: number;
  memory_kb: number;
  stdout_preview?: string;
  checker_message?: string;
}

export interface SubmissionDto extends SubmissionSummaryDto {
  source?: string;
  compile_message: string | null;
  error_code: string | null;
  results: SubmissionTestResultDto[];
  can_rejudge: boolean;
}

/** [AC, AC, AC, WA, SKIPPED] becomes [{AC, 3}, {WA, 1}, {SKIPPED, 1}]: a hundred tests stay a few runs. */
export function toTestRuns(results: { verdict: TestVerdictName }[]): TestRunDto[] {
  const runs: TestRunDto[] = [];
  for (const { verdict } of results) {
    const last = runs[runs.length - 1];
    if (last && last.verdict === verdict) last.count++;
    else runs.push({ verdict, count: 1 });
  }
  return runs;
}

type Summarisable = Pick<
  SubmissionListRow,
  | 'id'
  | 'language'
  | 'status'
  | 'verdict'
  | 'time_ms'
  | 'memory_kb'
  | 'tests_passed'
  | 'tests_total'
  | 'created_at'
  | 'judged_at'
  | 'user'
  | 'problem'
  | 'version'
>;

export function toSubmissionSummary(
  submission: Summarisable & { results?: { verdict: TestVerdictName }[] },
  space: { name: string; slug: string },
  number: number
): SubmissionSummaryDto {
  return {
    id: submission.id,
    number,
    problem: { slug: submission.problem.slug, title: submission.version.title },
    space,
    author: toPublicUser(submission.user),
    language: submission.language,
    status: submission.status,
    verdict: submission.verdict,
    time_ms: submission.time_ms,
    memory_kb: submission.memory_kb,
    tests_passed: submission.tests_passed,
    tests_total: submission.tests_total,
    test_runs: toTestRuns(submission.results ?? []),
    created_at: submission.created_at.toISOString(),
    judged_at: submission.judged_at?.toISOString() ?? null,
  };
}

/**
 * Per-test rows. The previews were stored for sample tests only, and they are
 * only passed on for sample rows here as well, so a hidden test shows a
 * verdict, a time and a memory figure and nothing else (GRD-46).
 */
export function toSubmissionDto(
  submission: SubmissionRecord,
  space: { name: string; slug: string },
  options: { includeSource: boolean; canRejudge: boolean; number: number }
): SubmissionDto {
  return {
    ...toSubmissionSummary(submission, space, options.number),
    ...(options.includeSource ? { source: submission.source } : {}),
    compile_message: submission.compile_message,
    error_code: submission.error_code,
    results: submission.results.map((result) => ({
      position: result.position,
      is_sample: result.is_sample,
      verdict: result.verdict,
      time_ms: result.time_ms,
      memory_kb: result.memory_kb,
      ...(result.is_sample && result.stdout_preview !== null
        ? { stdout_preview: result.stdout_preview }
        : {}),
      ...(result.is_sample && result.checker_message !== null
        ? { checker_message: result.checker_message }
        : {}),
    })),
    can_rejudge: options.canRejudge,
  };
}
