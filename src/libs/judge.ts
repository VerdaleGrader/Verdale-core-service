import type { components } from '@/contracts/judge.gen';
import type { JudgeConfigurations } from '@/config';
import { signedHeaders } from '@/libs/hmac';

export type JobRequest = components['schemas']['JobRequest'];
export type JobAccepted = components['schemas']['JobAccepted'];
export type JobState = components['schemas']['JobState'];
export type JobResult = components['schemas']['JobResult'];

/**
 * Judge could not take the job now (down, slow, overloaded, or Core's keys are not
 * accepted yet). The submission is kept and handed over again later.
 */
export class JudgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}

/** Judge looked at the job and refused it for good (400, 409, 413, 422); retrying the same job cannot help. */
export class JudgeRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'JudgeRejectedError';
  }
}

/** What Core needs from Judge. Tests use a fake; production uses HttpJudgeClient. */
export interface JudgeClient {
  createJob(request: JobRequest): Promise<JobAccepted>;
  /** Null when Judge does not know the job. */
  getJob(jobId: string): Promise<JobState | null>;
}

const PERMANENT_STATUSES = new Set([400, 409, 413, 422]);

/** Signed HTTP calls to Judge's internal API (contracts/HMAC.md). */
export class HttpJudgeClient implements JudgeClient {
  constructor(
    private readonly config: JudgeConfigurations,
    private readonly options: {
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {}
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body: string): Promise<Response> {
    if (!this.config.signing) {
      throw new JudgeUnavailableError('Judge is not configured (JUDGE_KEY_ID / JUDGE_SECRET).');
    }
    const headers = {
      ...signedHeaders(
        this.config.signing.keyId,
        this.config.signing.secret,
        method,
        path,
        body,
        this.options.now?.()
      ),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
    try {
      return await (this.options.fetchImpl ?? fetch)(`${this.config.url}${path}`, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw new JudgeUnavailableError('Could not reach Judge.', error);
    }
  }

  async createJob(request: JobRequest): Promise<JobAccepted> {
    const response = await this.call('POST', '/internal/jobs', JSON.stringify(request));
    if (response.status === 202 || response.status === 200) {
      return (await response.json()) as JobAccepted;
    }
    const text = await response.text().catch(() => '');
    if (PERMANENT_STATUSES.has(response.status)) {
      throw new JudgeRejectedError(
        `Judge refused the job (${response.status}): ${text}`.slice(0, 500),
        response.status
      );
    }
    // 401/403 (keys), 429, 5xx and anything unexpected: try again later.
    throw new JudgeUnavailableError(`Judge answered ${response.status}: ${text}`.slice(0, 500));
  }

  async getJob(jobId: string): Promise<JobState | null> {
    const response = await this.call('GET', `/internal/jobs/${jobId}`, '');
    if (response.status === 404) return null;
    if (!response.ok) throw new JudgeUnavailableError(`Judge answered ${response.status}.`);
    return (await response.json()) as JobState;
  }
}
