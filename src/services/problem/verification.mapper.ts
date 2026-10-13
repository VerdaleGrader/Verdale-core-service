import type { VerificationRunRecord } from '@/repositories/verification.repository';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';

export type VerificationStatusName = 'queued' | 'running' | 'passed' | 'failed' | 'error';

export interface VerificationTestResultDto {
  position: number;
  verdict: 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'OLE' | 'ISE' | 'SKIPPED';
  time_ms: number | null;
  memory_kb: number | null;
  is_sample: boolean;
}

export interface VerificationRunDto {
  id: string;
  status: VerificationStatusName;
  /** A passed run whose content hash still equals the version's current one. */
  valid: boolean;
  requested_by: PublicUser;
  created_at: string;
  finished_at: string | null;
  verdict: 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE' | 'OLE' | 'ISE' | null;
  reason: string | null;
  tests_passed: number | null;
  tests_total: number;
  max_time_ms: number | null;
  max_memory_kb: number | null;
  results: VerificationTestResultDto[];
}

export function toVerificationRun(
  run: VerificationRunRecord,
  currentHash: string
): VerificationRunDto {
  return {
    id: run.id,
    status: run.status,
    valid: run.status === 'passed' && run.content_hash === currentHash,
    requested_by: toPublicUser(run.requested_by),
    created_at: run.created_at.toISOString(),
    finished_at: run.finished_at?.toISOString() ?? null,
    verdict: run.verdict,
    reason: run.reason,
    tests_passed: run.tests_passed,
    tests_total: run.tests_total,
    max_time_ms: run.max_time_ms,
    max_memory_kb: run.max_memory_kb,
    results: (run.results as unknown as VerificationTestResultDto[]) ?? [],
  };
}
