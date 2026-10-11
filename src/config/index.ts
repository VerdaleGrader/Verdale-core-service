import { z } from 'zod';
import { Environment } from '@/constants/environment';

/**
 * Every setting Core reads from the environment. The service refuses to
 * start when anything is missing or malformed, and lists every problem.
 */
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
  })
  .superRefine((env, context) => {
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
}

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
  };
}
