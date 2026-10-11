import { ConfigError, loadConfig } from '@/config';
import { Environment } from '@/constants/environment';

const base = { DATABASE_URL: 'postgresql://core:pw@localhost:5432/verdale' };

/** Everything a deployed (non-local) environment must set besides the database and Better Stack. */
const deployed = {
  STORAGE_DRIVER: 'r2',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_TESTS_BUCKET: 'verdale-tests',
  R2_PUBLIC_BUCKET: 'verdale-public',
  JUDGE_KEY_ID: 'core-prod',
  JUDGE_SECRET: 'c'.repeat(40),
  JUDGE_CALLBACK_KEYS: `judge-prod:${'j'.repeat(40)}`,
};

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
      ...deployed,
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
      const staging = { ...base, ...deployed, ENV: 'staging', BETTERSTACK_SOURCE_TOKEN: 't' };
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

  describe('storage settings (M3)', () => {
    it('defaults to a local directory and the built-in picture route', () => {
      const { storage } = loadConfig(base);
      expect(storage.driver).toBe('local');
      expect(storage.localDir).toBe('.data/storage');
      expect(storage.publicAssetBaseUrl).toBe('/api/v1/assets');
      expect(storage.r2).toBeUndefined();
      expect(storage.retryAttempts).toBe(3);
    });

    it('needs every R2 value when the driver is r2, and names the missing ones', () => {
      try {
        loadConfig({ ...base, STORAGE_DRIVER: 'r2', R2_ENDPOINT: 'https://x.example' });
        throw new Error('expected a ConfigError');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as Error).message;
        for (const name of [
          'R2_ACCESS_KEY_ID',
          'R2_SECRET_ACCESS_KEY',
          'R2_TESTS_BUCKET',
          'R2_PUBLIC_BUCKET',
        ]) {
          expect(message).toContain(name);
        }
        expect(message).not.toContain('R2_ENDPOINT');
      }
    });

    it('refuses local or memory storage outside local', () => {
      const staging = {
        ...base,
        ...deployed,
        ENV: 'staging',
        BETTERSTACK_SOURCE_TOKEN: 't',
        SESSION_SECRET: 'x'.repeat(32),
      };
      expect(() => loadConfig({ ...staging, STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER/);
      expect(loadConfig(staging).storage.r2).toMatchObject({ testsBucket: 'verdale-tests' });
    });

    it('uses a public domain for pictures when one is given, without a trailing slash', () => {
      const { storage } = loadConfig({
        ...base,
        PUBLIC_ASSET_BASE_URL: 'https://img.verdale.dev/',
      });
      expect(storage.publicAssetBaseUrl).toBe('https://img.verdale.dev');
    });
  });

  describe('Judge settings (M3)', () => {
    it('works without Judge keys locally (submissions then wait in the queue)', () => {
      const { judge } = loadConfig(base);
      expect(judge.signing).toBeUndefined();
      expect(judge.callbackKeys).toEqual({});
      expect(judge.url).toBe('http://localhost:8081');
      expect(judge.callbackUrl).toBe('http://host.docker.internal:8080/internal/judge/result');
    });

    it('needs the key id and the secret together, and the secret must be long enough', () => {
      expect(() => loadConfig({ ...base, JUDGE_KEY_ID: 'core-local' })).toThrow(/JUDGE_KEY_ID/);
      expect(() =>
        loadConfig({ ...base, JUDGE_KEY_ID: 'core-local', JUDGE_SECRET: 'short' })
      ).toThrow(/JUDGE_SECRET/);
      const { judge } = loadConfig({
        ...base,
        JUDGE_KEY_ID: 'core-local',
        JUDGE_SECRET: 's'.repeat(32),
      });
      expect(judge.signing).toEqual({ keyId: 'core-local', secret: 's'.repeat(32) });
    });

    it('parses the callback keyring and refuses a malformed one', () => {
      const { judge } = loadConfig({
        ...base,
        JUDGE_CALLBACK_KEYS: `judge-a:${'a'.repeat(32)}, judge-b:${'b'.repeat(32)}`,
      });
      expect(Object.keys(judge.callbackKeys)).toEqual(['judge-a', 'judge-b']);
      expect(() => loadConfig({ ...base, JUDGE_CALLBACK_KEYS: 'no-colon' })).toThrow(
        /JUDGE_CALLBACK_KEYS/
      );
      expect(() => loadConfig({ ...base, JUDGE_CALLBACK_KEYS: 'id:short' })).toThrow(
        /JUDGE_CALLBACK_KEYS/
      );
    });

    it('requires keys outside local and builds the callback URL from CORE_INTERNAL_URL', () => {
      const production = {
        ...base,
        ENV: 'production',
        BETTERSTACK_SOURCE_TOKEN: 't',
        SESSION_SECRET: 'x'.repeat(32),
        STORAGE_DRIVER: 'r2',
      };
      expect(() => loadConfig(production)).toThrow(/JUDGE_SECRET/);
      const config = loadConfig({
        ...production,
        ...deployed,
        CORE_INTERNAL_URL: 'https://core.internal/',
      });
      expect(config.judge.callbackUrl).toBe('https://core.internal/internal/judge/result');
    });
  });
});
