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
    const production = {
      ...base,
      ENV: 'production',
      BETTERSTACK_SOURCE_TOKEN: 't',
      SESSION_SECRET: 'x'.repeat(32),
    };
    expect(loadConfig(production).env).toBe(Environment.Production);
  });

  it('rejects a non-postgres URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  describe('auth settings', () => {
    it('uses local defaults and non-secure cookies in local', () => {
      const { auth } = loadConfig(base);
      expect(auth.frontendOrigin).toBe('http://localhost:3000');
      expect(auth.cookieSecure).toBe(false);
      expect(auth.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
      expect(auth.providers).toEqual({ github: undefined, google: undefined });
    });

    it('requires a session secret and secure cookies outside local', () => {
      const staging = { ...base, ENV: 'staging', BETTERSTACK_SOURCE_TOKEN: 't' };
      expect(() => loadConfig(staging)).toThrow(/SESSION_SECRET/);
      expect(() => loadConfig({ ...staging, SESSION_SECRET: 'too short' })).toThrow(
        /SESSION_SECRET/
      );
      const config = loadConfig({ ...staging, SESSION_SECRET: 'x'.repeat(32) });
      expect(config.auth.cookieSecure).toBe(true);
    });

    it('treats empty values as not set (as in .env.example and Compose)', () => {
      const { auth } = loadConfig({
        ...base,
        SESSION_SECRET: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
      });
      expect(auth.providers.github).toBeUndefined();
    });

    it('enables a provider only when id and secret are both set', () => {
      expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: 'id' })).toThrow(/GITHUB_CLIENT_ID/);
      const { auth } = loadConfig({
        ...base,
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
      });
      expect(auth.providers.github).toEqual({ clientId: 'id', clientSecret: 'secret' });
      expect(auth.providers.google).toBeUndefined();
    });
  });
});
