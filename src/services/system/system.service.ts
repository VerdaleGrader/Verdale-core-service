import TLogger, { Layer } from '@/logging/logger';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export default class SystemService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly version: string,
    private readonly checks: ReadinessCheck[]
  ) {}

  getHealth() {
    return { status: 'ok' as const, version: this.version };
  }

  async getReadiness(requestId: string) {
    const logger = this.logger.setContext('service.system.getReadiness', requestId);
    const results = await Promise.all(
      this.checks.map(async ({ name, check }) => [name, await check().catch(() => false)] as const)
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, ok]) => ok);
    if (!ready) logger.warn({ message: 'Service is not ready', data: { checks } });
    return { status: ready ? ('ready' as const) : ('not_ready' as const), checks };
  }
}
