import { ConfigError, loadConfig } from '@/config';
import { Environment } from '@/constants/environment';

const base = { DATABASE_URL: 'postgresql://core:pw@localhost:5432/verdale' };

describe('loadConfig', () => {
  it('applies defaults for local development', () => {
    const config = loadConfig(base);
    expect(config.env).toBe(Environment.Local);
    expect(config.port).toBe(8080);
    expect(config.database.poolMax).toBe(10);
  });

  it('refuses to start without a database and lists every problem', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'abc' });
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).toContain('PORT');
    }
  });

  it('requires Better Stack outside local', () => {
    expect(() => loadConfig({ ...base, ENV: 'production' })).toThrow(/BETTERSTACK_SOURCE_TOKEN/);
    expect(loadConfig({ ...base, ENV: 'production', BETTERSTACK_SOURCE_TOKEN: 't' }).env).toBe(
      Environment.Production
    );
  });

  it('rejects a non-postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });
});
