import winston from 'winston';
import { Logtail } from '@logtail/node';
import { LogtailTransport } from '@logtail/winston';
import type { Configurations } from '@/config';
import { Environment } from '@/constants/environment';

let logtail: Logtail | undefined;

/**
 * The single winston logger for the whole service. Locally it prints
 * readable lines to the console; elsewhere it prints JSON and ships every
 * line to Better Stack.
 */
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'verdale-core' },
  transports: [new winston.transports.Console({ silent: process.env.NODE_ENV === 'test' })],
});

export function configureLogger(config: Configurations) {
  logger.level = config.logLevel;
  logger.defaultMeta = {
    service: 'verdale-core',
    environment: config.env,
    version: config.version,
  };
  if (config.env === Environment.Local) {
    logger.format = winston.format.combine(
      winston.format.timestamp(),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const { service, environment, version, ...rest } = meta;
        const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
        return `${timestamp} ${level} ${message}${extra}`;
      })
    );
  }
  if (config.betterStack.sourceToken) {
    const host = config.betterStack.ingestingHost;
    logtail = new Logtail(config.betterStack.sourceToken, {
      endpoint: host ? (host.startsWith('http') ? host : `https://${host}`) : undefined,
    });
    logger.add(new LogtailTransport(logtail));
  }
}

/** Sends log lines still buffered for Better Stack. Call before exiting. */
export async function flushLogs() {
  await logtail?.flush();
}
