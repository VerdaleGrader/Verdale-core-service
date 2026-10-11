import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import { loadConfig } from '@/config';
import { OAuthProfile, OAuthProvider, OAuthProviders } from '@/libs/oauth';
import { buildApp } from '@/routes';

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

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  github: FakeProvider;
  google: FakeProvider;
  prisma: PrismaClient;
  login: (
    profile: Partial<OAuthProfile> & { providerAccountId: string; email: string }
  ) => Promise<Client>;
  anonymous: () => Client;
  close: () => Promise<void>;
}

export interface Client {
  cookie: string;
  request: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown
  ) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const database = createTestPrisma();
  const config = loadConfig({
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://x:y@localhost/z',
    FRONTEND_ORIGIN,
    ...env,
  });
  const github = new FakeProvider('github');
  const google = new FakeProvider('google');
  const oauthProviders: OAuthProviders = { github, google };
  const app = buildApp({
    version: 'test',
    readinessChecks: [],
    api: { prisma: database.prisma, auth: config.auth, oauthProviders },
  });
  await app.ready();

  const client = (cookie: string): Client => ({
    cookie,
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
