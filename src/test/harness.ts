import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { AuthConfigurations } from '@/config';
import { loadConfig } from '@/config';
import type { AiClient, AiPrompt, AiProviderName } from '@/libs/ai-provider';
import { AiProviderError, AiProviderErrorCode } from '@/libs/ai-provider';
import type { JobAccepted, JobRequest, JobResult, JobState, JudgeClient } from '@/libs/judge';
import { JudgeRejectedError, JudgeUnavailableError } from '@/libs/judge';
import SecretBox from '@/libs/crypto';
import { signedHeaders } from '@/libs/hmac';
import { OAuthProfile, OAuthProvider, OAuthProviders } from '@/libs/oauth';
import { MemoryFileStorage } from '@/libs/storage/memory';
import { ApiDependencies, buildApp } from '@/routes';

/**
 * Integration tests run against a real Postgres (set TEST_DATABASE_URL to a
 * database with migrations applied; CI does this). Without it they are
 * skipped, so `npm test` still works on a laptop without a database.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

export const FRONTEND_ORIGIN = 'http://localhost:3000';

export function createTestPrisma() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

export async function resetDatabase(prisma: PrismaClient) {
  // The tests empty every table: never let them near a shared database.
  const host = new URL(TEST_DATABASE_URL ?? 'postgresql://invalid').hostname;
  if (!SAFE_HOSTS.has(host)) {
    throw new Error(`TEST_DATABASE_URL points at ${host}; refusing to wipe a non-local database`);
  }
  // TRUNCATE skips row triggers, so personal Spaces can be wiped too.
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" RESTART IDENTITY CASCADE');
}

/** A provider that returns whatever profile the test sets, with no network. */
export class FakeProvider implements OAuthProvider {
  profile: OAuthProfile | Error = {
    providerAccountId: 'gh-1',
    email: 'ada@example.com',
    emailVerified: true,
    displayName: 'Ada Lovelace',
    usernameHint: 'ada',
  };
  constructor(readonly name: 'github' | 'google' = 'github') {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    return `https://provider.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  async fetchProfile() {
    if (this.profile instanceof Error) throw this.profile;
    return this.profile;
  }
}

/** Judge key ring shared by the fake Judge and the callback tests. */
export const JUDGE_CALLBACK_KEY_ID = 'judge-test';
export const JUDGE_CALLBACK_SECRET = 'test-judge-to-core-secret-0123456789abcdef';
export const CALLBACK_URL = 'http://core.test/internal/judge/result';

/**
 * Stands in for Judge: remembers the jobs it was given, and can be told to be
 * down (503), to refuse jobs for good, or to report a job as running.
 */
export class FakeJudge implements JudgeClient {
  jobs: JobRequest[] = [];
  mode: 'up' | 'down' | 'reject' = 'up';
  running = new Set<string>();

  async createJob(request: JobRequest): Promise<JobAccepted> {
    if (this.mode === 'down') throw new JudgeUnavailableError('Judge is down');
    if (this.mode === 'reject') throw new JudgeRejectedError('refused', 400);
    this.jobs.push(request);
    return {
      job_id: request.job_id,
      status: 'queued',
      accepted_at: new Date().toISOString(),
      duplicate: false,
    };
  }

  async getJob(jobId: string): Promise<JobState | null> {
    if (this.mode === 'down') throw new JudgeUnavailableError('Judge is down');
    const job = this.jobs.find((candidate) => candidate.job_id === jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    return {
      job_id: jobId,
      status: this.running.has(jobId) ? 'running' : 'queued',
      accepted_at: now,
      updated_at: now,
    };
  }

  get last(): JobRequest {
    return this.jobs[this.jobs.length - 1]!;
  }
}

/** Key ring that encrypts authors' AI keys in tests. */
export const AI_KEY_RING = { 'ai-test': 'test-ai-key-encryption-secret-0123456789abcdef' };

/**
 * Stands in for Gemini and Claude: answers with the inputs the test sets, or
 * fails with a provider error. It remembers every call, key and prompt
 * included, so tests can check what was sent and to whom.
 */
export class FakeAiClient implements AiClient {
  calls: Array<{ provider: AiProviderName; apiKey: string; prompt: AiPrompt }> = [];
  inputs: string[] = ['1 2\n', '3 4\n', '5 6\n'];
  failure: AiProviderErrorCode | null = null;

  async generateInputs(provider: AiProviderName, apiKey: string, prompt: AiPrompt) {
    this.calls.push({ provider, apiKey, prompt });
    if (this.failure) throw new AiProviderError(this.failure);
    return this.inputs;
  }
}

/** The pieces of ApiDependencies that M3 added, filled with in-memory fakes. */
export function testApiDependencies(
  prisma: PrismaClient,
  auth: AuthConfigurations,
  oauthProviders: OAuthProviders
): ApiDependencies & {
  judgeFake: FakeJudge;
  aiFake: FakeAiClient;
  tests: MemoryFileStorage;
  assets: MemoryFileStorage;
} {
  const tests = new MemoryFileStorage();
  const assets = new MemoryFileStorage();
  const judgeFake = new FakeJudge();
  const aiFake = new FakeAiClient();
  return {
    prisma,
    auth,
    oauthProviders,
    storage: { tests, assets },
    judge: {
      client: judgeFake,
      config: {
        callbackKeys: { [JUDGE_CALLBACK_KEY_ID]: JUDGE_CALLBACK_SECRET },
        callbackUrl: CALLBACK_URL,
      },
    },
    publicAssetBaseUrl: '/api/v1/assets',
    tuning: { streamIntervalMs: 10 },
    ai: { client: aiFake, secretBox: new SecretBox(AI_KEY_RING) },
    judgeFake,
    aiFake,
    tests,
    assets,
  };
}

/** A JobResult for a job, with sensible defaults; override anything. */
export function jobResult(job: JobRequest, overrides: Partial<JobResult> = {}): JobResult {
  const tests = job.tests.map((test) => ({
    id: test.id,
    verdict: 'AC' as const,
    time_ms: 12,
    memory_kb: 2048,
    exit_code: 0,
    ...(test.sample ? { stdout_preview: '3\n', checker_message: '' } : {}),
  }));
  return {
    job_id: job.job_id,
    kind: 'submission',
    verdict: 'AC',
    tests,
    summary: { passed: tests.length, total: tests.length, time_ms: 12, memory_kb: 2048 },
    judged_at: new Date().toISOString(),
    judge_version: 'test-1',
    ...overrides,
  };
}

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  judge: FakeJudge;
  /** Files Core wrote: private test bucket and public picture bucket. */
  storage: { tests: MemoryFileStorage; assets: MemoryFileStorage };
  ai: FakeAiClient;
  /** Waits for submissions handed to Judge in the background. */
  settle: () => Promise<void>;
  /** Judge delivering a result to Core, signed the way Judge signs it. */
  deliver: (
    result: unknown,
    options?: { keyId?: string; secret?: string; timestampMs?: number; rawBody?: string }
  ) => Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  github: FakeProvider;
  google: FakeProvider;
  prisma: PrismaClient;
  login: (
    profile: Partial<OAuthProfile> & { providerAccountId: string; email: string }
  ) => Promise<Client>;
  anonymous: () => Client;
  close: () => Promise<void>;
}

export interface UploadPart {
  name: string;
  /** Present for a file part. */
  filename?: string;
  content: Buffer | string;
  contentType?: string;
}

/** multipart/form-data body, built by hand so tests control every byte. */
export function multipartBody(parts: UploadPart[]) {
  const boundary = `----verdale${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename !== undefined ? `; filename="${part.filename}"` : '');
    const type =
      part.filename !== undefined
        ? `\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}`
        : '';
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}${type}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export interface Client {
  cookie: string;
  /** multipart/form-data upload. */
  upload: (
    method: 'POST' | 'PUT',
    url: string,
    parts: UploadPart[]
  ) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Raw response text, for downloads and event streams. */
  text: (
    method: 'GET' | 'POST',
    url: string
  ) => Promise<{ status: number; text: string; headers: Record<string, unknown> }>;
  request: (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown
  ) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function createTestApp(
  env: Record<string, string> = {},
  tuning: NonNullable<ApiDependencies['tuning']> = {}
): Promise<TestApp> {
  const database = createTestPrisma();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://x:y@localhost/z',
    FRONTEND_ORIGIN,
    ...env,
  });
  const github = new FakeProvider('github');
  const google = new FakeProvider('google');
  const oauthProviders: OAuthProviders = { github, google };
  const { judgeFake, aiFake, tests, assets, ...api } = testApiDependencies(
    database.prisma,
    config.auth,
    oauthProviders
  );
  const app = buildApp({
    version: 'test',
    readinessChecks: [],
    api: { ...api, tuning: { ...api.tuning, ...tuning } },
  });
  await app.ready();

  const deliver: TestApp['deliver'] = async (result, options = {}) => {
    const body = options.rawBody ?? JSON.stringify(result);
    const path = '/internal/judge/result';
    const headers = signedHeaders(
      options.keyId ?? JUDGE_CALLBACK_KEY_ID,
      options.secret ?? JUDGE_CALLBACK_SECRET,
      'POST',
      path,
      body,
      options.timestampMs
    );
    const response = await app.inject({
      method: 'POST',
      url: path,
      payload: body,
      headers: { ...headers, 'content-type': 'application/json' },
    });
    return { status: response.statusCode, body: response.body ? safeJson(response.body) : null };
  };

  const client = (cookie: string): Client => ({
    cookie,
    async upload(method, url, parts) {
      const { payload, contentType } = multipartBody(parts);
      const response = await app.inject({
        method,
        url,
        payload,
        headers: {
          ...(cookie ? { cookie } : {}),
          origin: FRONTEND_ORIGIN,
          'content-type': contentType,
        },
      });
      return {
        status: response.statusCode,
        body: response.body ? safeJson(response.body) : null,
        headers: response.headers,
      };
    },
    async text(method, url) {
      const response = await app.inject({
        method,
        url,
        headers: { ...(cookie ? { cookie } : {}), origin: FRONTEND_ORIGIN },
      });
      return { status: response.statusCode, text: response.body, headers: response.headers };
    },
    async request(method, url, payload) {
      const response = await app.inject({
        method,
        url,
        payload: payload as object | undefined,
        headers: { ...(cookie ? { cookie } : {}), origin: FRONTEND_ORIGIN },
      });
      const text = response.body;
      return {
        status: response.statusCode,
        body: text ? safeJson(text) : null,
        headers: response.headers,
      };
    },
  });

  const login: TestApp['login'] = async (profile) => {
    github.profile = {
      emailVerified: true,
      displayName: profile.displayName ?? profile.email.split('@')[0]!,
      usernameHint: profile.usernameHint ?? profile.email.split('@')[0]!,
      ...profile,
    };
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github/start' });
    const stateCookie = cookieFrom(start.headers['set-cookie'], 'vd_oauth');
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/github/callback?code=abc&state=${state}`,
      headers: { cookie: stateCookie },
    });
    const session = cookieFrom(callback.headers['set-cookie'], 'vd_session');
    if (!session)
      throw new Error(`login failed: ${callback.statusCode} ${callback.headers.location}`);
    return client(session);
  };

  return {
    app,
    judge: judgeFake,
    storage: { tests, assets },
    ai: aiFake,
    settle: async () => {
      await app.dispatcher!.idle();
      await app.aiTester!.idle();
    },
    deliver,
    github,
    google,
    prisma: database.prisma,
    login,
    anonymous: () => client(''),
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** "name=value" for one cookie out of Set-Cookie header(s); empty if absent or cleared. */
export function cookieFrom(header: string | string[] | undefined, name: string): string {
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  const line = lines.filter((entry) => entry.startsWith(`${name}=`)).pop();
  if (!line) return '';
  const pair = line.split(';')[0]!;
  return pair === `${name}=` ? '' : pair;
}

export function rawSetCookie(header: string | string[] | undefined, name: string): string {
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  return lines.find((entry) => entry.startsWith(`${name}=`)) ?? '';
}
