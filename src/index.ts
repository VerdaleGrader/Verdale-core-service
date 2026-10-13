import 'dotenv/config';
import { ConfigError, loadConfig } from '@/config';
import { configureLogger, flushLogs, logger as rootLogger } from '@/libs/winston';
import { HttpJudgeClient } from '@/libs/judge';
import { createOAuthProviders } from '@/libs/oauth';
import { createStorages } from '@/libs/storage';
import { createDatabase } from '@/libs/prisma';
import TLogger, { Layer } from '@/logging/logger';
import { buildApp } from '@/routes';

const logger = new TLogger(Layer.OTHER, 'index.main');

async function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      rootLogger.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  configureLogger(config);

  const database = createDatabase(config);
  const app = buildApp({
    version: config.version,
    readinessChecks: [{ name: 'database', check: database.isReachable }],
    api: {
      prisma: database.prisma,
      auth: config.auth,
      oauthProviders: createOAuthProviders(config.auth.providers),
      storage: createStorages(config.storage),
      judge: { client: new HttpJudgeClient(config.judge), config: config.judge },
      publicAssetBaseUrl: config.storage.publicAssetBaseUrl,
      publish: config.publish,
    },
  });
  if (!config.judge.signing) {
    logger.warn({
      message: 'JUDGE_KEY_ID / JUDGE_SECRET are not set: submissions are kept but not judged',
    });
  }
  // Retries hand-overs to Judge that failed while it was down.
  app.dispatcher?.start();
  // Keeps "generate expected output" jobs moving and removes old ones.
  app.generator?.startLoop();
  if (Object.keys(config.auth.providers).length === 0) {
    logger.warn({ message: 'No OAuth provider is configured: nobody can log in' });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ message: `Received ${signal}, shutting down` });
    const timer = setTimeout(() => {
      logger.error({ message: 'Shutdown timed out, exiting' });
      void flushLogs().finally(() => process.exit(1));
    }, config.shutdownTimeoutMs);
    timer.unref();
    try {
      await app.close(); // stop accepting requests, finish in-flight ones
      await app.dispatcher?.stop(); // finish hand-overs to Judge that are under way
      await app.generator?.stopLoop();
      await database.close();
      logger.info({ message: 'Shutdown complete' });
    } catch (error) {
      logger.error({ message: 'Error during shutdown', error: error as Error });
    } finally {
      await flushLogs(); // ship buffered lines to Better Stack before exiting
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  logger.info({
    message: `Core listening on ${config.host}:${config.port}`,
    data: { env: config.env },
  });
}

main().catch(async (error) => {
  logger.error({ message: 'Fatal error during startup', error });
  await flushLogs();
  process.exit(1);
});
