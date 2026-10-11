import { verify } from '@/libs/hmac';
import {
  HttpJudgeClient,
  JobRequest,
  JudgeRejectedError,
  JudgeUnavailableError,
} from '@/libs/judge';

const SECRET = 'core-to-judge-secret-0123456789abcdef-xyz';
const config = {
  url: 'http://judge.test',
  signing: { keyId: 'core-test', secret: SECRET },
  callbackKeys: {},
  callbackUrl: 'http://core.test/internal/judge/result',
};

const job: JobRequest = {
  job_id: '5f1d6b0e-3c1c-4b7b-9d0e-111111111111',
  kind: 'submission',
  language: 'cpp',
  source: 'int main(){}',
  limits: { time_ms: 1000, memory_kb: 65536, output_kb: 65536 },
  checker: 'line',
  tests: [
    {
      id: 't1',
      input: { sha256: 'a'.repeat(64), size_bytes: 2 },
      output: { sha256: 'b'.repeat(64), size_bytes: 2 },
      sample: true,
    },
  ],
  callback_url: config.callbackUrl,
};

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HttpJudgeClient', () => {
  it('posts the job to /internal/jobs, signed so that Judge’s check passes', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(202, {
        job_id: job.job_id,
        status: 'queued',
        accepted_at: new Date().toISOString(),
        duplicate: false,
      })
    );
    const accepted = await new HttpJudgeClient(config, { fetchImpl: impl }).createJob(job);
    expect(accepted).toMatchObject({ job_id: job.job_id, status: 'queued', duplicate: false });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('http://judge.test/internal/jobs');
    expect(init.method).toBe('POST');
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ])
    );
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(job);
    expect(
      verify(headers, { 'core-test': SECRET }, 'POST', '/internal/jobs', init.body as string)
    ).toEqual({ ok: true, keyId: 'core-test' });
  });

  it('a duplicate answer (200, duplicate: true) counts as accepted', async () => {
    const { impl } = fakeFetch(() =>
      json(200, {
        job_id: job.job_id,
        status: 'running',
        accepted_at: new Date().toISOString(),
        duplicate: true,
      })
    );
    expect((await new HttpJudgeClient(config, { fetchImpl: impl }).createJob(job)).duplicate).toBe(
      true
    );
  });

  it.each([400, 409, 413, 422])('Judge answering %i is a refusal for good', async (status) => {
    const { impl } = fakeFetch(() => json(status, { error_code: 'X' }));
    await expect(
      new HttpJudgeClient(config, { fetchImpl: impl }).createJob(job)
    ).rejects.toMatchObject({
      name: 'JudgeRejectedError',
      status,
    });
  });

  it.each([401, 403, 429, 500, 502, 503])(
    'Judge answering %i is "try again later"',
    async (status) => {
      const { impl } = fakeFetch(() => json(status, {}));
      await expect(
        new HttpJudgeClient(config, { fetchImpl: impl }).createJob(job)
      ).rejects.toBeInstanceOf(JudgeUnavailableError);
    }
  );

  it('a network failure or timeout is "try again later"', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      new HttpJudgeClient(config, { fetchImpl: impl }).createJob(job)
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
  });

  it('without keys it cannot call Judge and says so, instead of sending an unsigned request', async () => {
    const { impl, calls } = fakeFetch(() => json(202, {}));
    const client = new HttpJudgeClient({ ...config, signing: undefined }, { fetchImpl: impl });
    await expect(client.createJob(job)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it('reads a job’s state with a signed GET, and returns null for an unknown job', async () => {
    const state = { job_id: job.job_id, status: 'running', accepted_at: 'x', updated_at: 'y' };
    const found = fakeFetch(() => json(200, state));
    expect(await new HttpJudgeClient(config, { fetchImpl: found.impl }).getJob(job.job_id)).toEqual(
      state
    );
    const { url, init } = found.calls[0]!;
    expect(url).toBe(`http://judge.test/internal/jobs/${job.job_id}`);
    expect(init.method).toBe('GET');
    const headers = Object.fromEntries(
      Object.entries(init.headers as Record<string, string>).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ])
    );
    expect(
      verify(headers, { 'core-test': SECRET }, 'GET', `/internal/jobs/${job.job_id}`, '').ok
    ).toBe(true);

    const missing = fakeFetch(() => json(404, {}));
    expect(
      await new HttpJudgeClient(config, { fetchImpl: missing.impl }).getJob(job.job_id)
    ).toBeNull();
  });

  it('exposes the two error types the dispatcher distinguishes', () => {
    expect(new JudgeRejectedError('x', 400).status).toBe(400);
    expect(new JudgeUnavailableError('x')).toBeInstanceOf(Error);
  });
});
