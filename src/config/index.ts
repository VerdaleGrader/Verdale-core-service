import { z } from 'zod';
import { Environment } from '@/constants/environment';

/**
 * Every setting Core reads from the environment. The service refuses to
 * start when anything is missing or malformed, and lists every problem.
 */
/** An empty value (`GITHUB_CLIENT_ID=` in .env or Compose) means "not set". */
const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);
const optionalText = z.preprocess(blankAsUnset, z.string().min(1).optional());

const schema = z
  .object({
    ENV: z.enum(Environment).default(Environment.Local),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    // Pooled connection (Neon "-pooler" host) used by the running service.
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    BETTERSTACK_SOURCE_TOKEN: z.string().optional(),
    BETTERSTACK_INGESTING_HOST: z.string().optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
    // Origin of the web app. The browser talks to Core only through it
    // (/api/* is proxied), so cookies are first-party and OAuth redirects
    // come back here.
    FRONTEND_ORIGIN: z.url().default('http://localhost:3000'),
    // Signs the short-lived OAuth state cookie. At least 32 characters.
    SESSION_SECRET: z.preprocess(blankAsUnset, z.string().min(32).optional()),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    // Set to true behind nginx so rate limits see the real client address.
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    GITHUB_CLIENT_ID: optionalText,
    GITHUB_CLIENT_SECRET: optionalText,
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    // --- Files (M3) ---------------------------------------------------------
    // memory is for tests; local writes to a directory (share it with Judge's
    // storage.local_dir in development); r2 is Cloudflare R2 over the S3 API.
    STORAGE_DRIVER: z.enum(['memory', 'local', 'r2']).default('local'),
    STORAGE_LOCAL_DIR: z.string().min(1).default('.data/storage'),
    R2_ENDPOINT: optionalText,
    R2_ACCESS_KEY_ID: optionalText,
    R2_SECRET_ACCESS_KEY: optionalText,
    // Private bucket for test files (Judge reads it with a read-only token).
    R2_TESTS_BUCKET: optionalText,
    // Public bucket for statement pictures.
    R2_PUBLIC_BUCKET: optionalText,
    // Where browsers load statement pictures from (the public bucket's own
    // domain). Left out, Core serves them at /api/v1/assets.
    PUBLIC_ASSET_BASE_URL: z.preprocess(blankAsUnset, z.url().optional()),
    STORAGE_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
    STORAGE_RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    STORAGE_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).max(10_000).default(200),
    // --- Judge (M3) ---------------------------------------------------------
    JUDGE_URL: z.url().default('http://localhost:8081'),
    // Core signs jobs with this key (Judge's VERDALE_JUDGE_AUTH_INBOUND_KEYS).
    JUDGE_KEY_ID: optionalText,
    JUDGE_SECRET: z.preprocess(blankAsUnset, z.string().min(32).optional()),
    // Keys Judge signs results with, "id:secret,id:secret" (judge-to-core keyring).
    JUDGE_CALLBACK_KEYS: z.preprocess(blankAsUnset, z.string().optional()),
    // How Judge reaches Core to deliver results (inside Docker: host.docker.internal).
    CORE_INTERNAL_URL: z.url().default('http://host.docker.internal:8080'),
  })
  .superRefine((env, context) => {
    if (env.ENV !== Environment.Local && !env.SESSION_SECRET) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'is required outside local (at least 32 characters)',
      });
    }
    for (const provider of ['GITHUB', 'GOOGLE'] as const) {
      const id = env[`${provider}_CLIENT_ID`];
      const secret = env[`${provider}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        context.addIssue({
          code: 'custom',
          path: [`${provider}_CLIENT_ID`],
          message: `${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET must be set together`,
        });
      }
    }
    if (env.STORAGE_DRIVER === 'r2') {
      for (const name of [
        'R2_ENDPOINT',
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_TESTS_BUCKET',
        'R2_PUBLIC_BUCKET',
      ] as const) {
        if (!env[name]) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'is required when STORAGE_DRIVER=r2',
          });
        }
      }
    } else if (env.ENV !== Environment.Local) {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'must be r2 outside local',
      });
    }
    if (Boolean(env.JUDGE_KEY_ID) !== Boolean(env.JUDGE_SECRET)) {
      context.addIssue({
        code: 'custom',
        path: ['JUDGE_KEY_ID'],
        message: 'JUDGE_KEY_ID and JUDGE_SECRET must be set together',
      });
    }
    if (env.JUDGE_CALLBACK_KEYS) {
      try {
        parseKeyring(env.JUDGE_CALLBACK_KEYS);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          path: ['JUDGE_CALLBACK_KEYS'],
          message: (error as Error).message,
        });
      }
    }
    if (env.ENV !== Environment.Local) {
      for (const name of ['JUDGE_KEY_ID', 'JUDGE_SECRET', 'JUDGE_CALLBACK_KEYS'] as const) {
        if (!env[name]) {
          context.addIssue({ code: 'custom', path: [name], message: 'is required outside local' });
        }
      }
    }
    if (env.ENV !== Environment.Local && !env.BETTERSTACK_SOURCE_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['BETTERSTACK_SOURCE_TOKEN'],
        message: 'is required outside local so logs reach Better Stack',
      });
    }
  });

export interface Configurations {
  env: Environment;
  host: string;
  port: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  database: { url: string; poolMax: number };
  betterStack: { sourceToken?: string; ingestingHost?: string };
  shutdownTimeoutMs: number;
  version: string;
  auth: AuthConfigurations;
  storage: StorageConfigurations;
  judge: JudgeConfigurations;
}

export interface StorageConfigurations {
  driver: 'memory' | 'local' | 'r2';
  localDir: string;
  r2?: {
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    testsBucket: string;
    publicBucket: string;
  };
  /** Prefix of statement picture URLs (no trailing slash). */
  publicAssetBaseUrl: string;
  timeoutMs: number;
  retryAttempts: number;
  retryBackoffMs: number;
}

export interface JudgeConfigurations {
  url: string;
  /** Without these Core still accepts submissions but cannot hand them to Judge. */
  signing?: { keyId: string; secret: string };
  /** Judge-to-core keyring for result callbacks: key id to secret. */
  callbackKeys: Record<string, string>;
  /** Where Judge is told to POST results. */
  callbackUrl: string;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfigurations {
  frontendOrigin: string;
  sessionSecret: string;
  sessionTtlMs: number;
  /** Cookies are `Secure` everywhere except local development. */
  cookieSecure: boolean;
  trustProxy: boolean;
  /** A provider is enabled only when both its id and secret are set. */
  providers: { github?: OAuthClientCredentials; google?: OAuthClientCredentials };
}

/** "id:secret,id:secret" (the format of Judge's inbound keys). Secrets are at least 32 characters. */
export function parseKeyring(text: string): Record<string, string> {
  const keyring: Record<string, string> = {};
  for (const entry of text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    const keyId = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || secret.length < 32) {
      throw new Error(
        'must be "key-id:secret" pairs separated by commas (secret at least 32 characters)'
      );
    }
    keyring[keyId] = secret;
  }
  return keyring;
}

const LOCAL_SESSION_SECRET = 'local-development-only-session-secret-0000';

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Configurations {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const value = parsed.data;
  return {
    env: value.ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    database: { url: value.DATABASE_URL, poolMax: value.DATABASE_POOL_MAX },
    betterStack: {
      sourceToken: value.BETTERSTACK_SOURCE_TOKEN,
      ingestingHost: value.BETTERSTACK_INGESTING_HOST,
    },
    shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    version: env.npm_package_version ?? process.env.APP_VERSION ?? 'dev',
    auth: {
      frontendOrigin: value.FRONTEND_ORIGIN.replace(/\/$/, ''),
      sessionSecret: value.SESSION_SECRET ?? LOCAL_SESSION_SECRET,
      sessionTtlMs: value.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      cookieSecure: value.ENV !== Environment.Local,
      trustProxy: value.TRUST_PROXY,
      providers: {
        github:
          value.GITHUB_CLIENT_ID && value.GITHUB_CLIENT_SECRET
            ? { clientId: value.GITHUB_CLIENT_ID, clientSecret: value.GITHUB_CLIENT_SECRET }
            : undefined,
        google:
          value.GOOGLE_CLIENT_ID && value.GOOGLE_CLIENT_SECRET
            ? { clientId: value.GOOGLE_CLIENT_ID, clientSecret: value.GOOGLE_CLIENT_SECRET }
            : undefined,
      },
    },
    storage: {
      driver: value.STORAGE_DRIVER,
      localDir: value.STORAGE_LOCAL_DIR,
      r2:
        value.STORAGE_DRIVER === 'r2'
          ? {
              endpoint: value.R2_ENDPOINT!,
              accessKeyId: value.R2_ACCESS_KEY_ID!,
              secretAccessKey: value.R2_SECRET_ACCESS_KEY!,
              testsBucket: value.R2_TESTS_BUCKET!,
              publicBucket: value.R2_PUBLIC_BUCKET!,
            }
          : undefined,
      publicAssetBaseUrl: (value.PUBLIC_ASSET_BASE_URL ?? '/api/v1/assets').replace(/\/$/, ''),
      timeoutMs: value.STORAGE_TIMEOUT_MS,
      retryAttempts: value.STORAGE_RETRY_ATTEMPTS,
      retryBackoffMs: value.STORAGE_RETRY_BACKOFF_MS,
    },
    judge: {
      url: value.JUDGE_URL.replace(/\/$/, ''),
      signing:
        value.JUDGE_KEY_ID && value.JUDGE_SECRET
          ? { keyId: value.JUDGE_KEY_ID, secret: value.JUDGE_SECRET }
          : undefined,
      callbackKeys: value.JUDGE_CALLBACK_KEYS ? parseKeyring(value.JUDGE_CALLBACK_KEYS) : {},
      callbackUrl: `${value.CORE_INTERNAL_URL.replace(/\/$/, '')}/internal/judge/result`,
    },
  };
}
