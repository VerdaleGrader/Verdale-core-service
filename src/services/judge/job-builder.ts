import { CAPTURE, OUTPUT_LIMIT_KB } from '@/constants/limits';
import type { JobRequest } from '@/libs/judge';

/**
 * The one place that turns a version's limits and tests into a Judge job, for
 * real submissions and for verification runs alike (GRD-51): the same sandbox
 * limits, the same checker, the same tests, so a solution that passes the
 * verification is judged by exactly the rules solvers are judged by.
 */
export function buildJudgeJob(input: {
  jobId: string;
  kind: 'submission' | 'verify';
  language: 'c' | 'cpp' | 'python';
  source: string;
  version: { time_limit_ms: number; memory_limit_kb: number };
  tests: Array<{
    id: string;
    input_sha256: string;
    input_size_bytes: number;
    output_sha256: string | null;
    output_size_bytes: number | null;
    is_sample: boolean;
  }>;
  callbackUrl: string;
}): JobRequest {
  return {
    job_id: input.jobId,
    kind: input.kind,
    language: input.language,
    source: input.source,
    limits: {
      time_ms: input.version.time_limit_ms,
      memory_kb: input.version.memory_limit_kb,
      output_kb: OUTPUT_LIMIT_KB,
    },
    checker: 'line',
    capture: { ...CAPTURE },
    tests: input.tests.map((test) => ({
      id: test.id,
      input: { sha256: test.input_sha256, size_bytes: test.input_size_bytes },
      output: { sha256: test.output_sha256!, size_bytes: test.output_size_bytes! },
      sample: test.is_sample,
    })),
    callback_url: input.callbackUrl,
  };
}
