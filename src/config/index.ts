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
  };
}
