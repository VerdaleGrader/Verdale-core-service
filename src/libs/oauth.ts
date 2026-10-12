import { createHash, randomBytes } from 'node:crypto';
import type { OAuthClientCredentials } from '@/config';

export type OAuthProviderName = 'github' | 'google';
export const OAUTH_PROVIDER_NAMES: readonly OAuthProviderName[] = ['github', 'google'];

/** What Core needs to know about a person from their provider. */
export interface OAuthProfile {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  /** Suggested username (GitHub login, Google name or e-mail prefix). */
  usernameHint: string;
  /** The provider's profile picture, when it has one (an https URL). */
  avatarUrl?: string;
}

export interface OAuthProvider {
  readonly name: OAuthProviderName;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Exchanges the code and reads the profile. Throws OAuthExchangeError. */
  fetchProfile(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthProfile>;
}

export class OAuthExchangeError extends Error {}

const TIMEOUT_MS = 10_000;

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new OAuthExchangeError(`${what} failed with status ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    throw new OAuthExchangeError(`${what} returned an unreadable body`);
  }
  return body as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Only https URLs of sensible length are kept as profile pictures. */
export function avatarOf(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || raw.length > 512) return undefined;
  try {
    return new URL(raw).protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export class GitHubProvider implements OAuthProvider {
  readonly name = 'github' as const;
  constructor(private readonly credentials: OAuthClientCredentials) {}

  authorizeUrl({
    state,
    codeChallenge,
    redirectUri,
  }: Parameters<OAuthProvider['authorizeUrl']>[0]) {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async fetchProfile({
    code,
    codeVerifier,
    redirectUri,
  }: Parameters<OAuthProvider['fetchProfile']>[0]) {
    const tokenBody = await readJson(
      await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'GitHub token exchange'
    );
    const accessToken = text(tokenBody.access_token);
    if (!accessToken) throw new OAuthExchangeError('GitHub did not return an access token');

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'verdale-core',
    };
    const user = await readJson(
      await fetch('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'GitHub profile'
    );
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!emailsResponse.ok) {
      throw new OAuthExchangeError(`GitHub e-mails failed with status ${emailsResponse.status}`);
    }
    const emails = (await emailsResponse.json().catch(() => [])) as Array<Record<string, unknown>>;
    const primary = emails.find((entry) => entry.primary === true && entry.verified === true);
    const login = text(user.login);

    return {
      providerAccountId: String(user.id ?? ''),
      email: text(primary?.email).toLowerCase(),
      emailVerified: Boolean(primary),
      displayName: text(user.name) || login,
      usernameHint: login,
      avatarUrl: avatarOf(user.avatar_url),
    };
  }
}

export class GoogleProvider implements OAuthProvider {
  readonly name = 'google' as const;
  constructor(private readonly credentials: OAuthClientCredentials) {}

  authorizeUrl({
    state,
    codeChallenge,
    redirectUri,
  }: Parameters<OAuthProvider['authorizeUrl']>[0]) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async fetchProfile({
    code,
    codeVerifier,
    redirectUri,
  }: Parameters<OAuthProvider['fetchProfile']>[0]) {
    const tokenBody = await readJson(
      await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'Google token exchange'
    );
    const accessToken = text(tokenBody.access_token);
    if (!accessToken) throw new OAuthExchangeError('Google did not return an access token');

    const info = await readJson(
      await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      'Google profile'
    );
    const email = text(info.email).toLowerCase();
    return {
      providerAccountId: text(info.sub),
      email,
      emailVerified: info.email_verified === true,
      displayName: text(info.name) || email.split('@')[0] || '',
      usernameHint: email.split('@')[0] || text(info.given_name),
      avatarUrl: avatarOf(info.picture),
    };
  }
}

export type OAuthProviders = Partial<Record<OAuthProviderName, OAuthProvider>>;

export function createOAuthProviders(config: {
  github?: OAuthClientCredentials;
  google?: OAuthClientCredentials;
}): OAuthProviders {
  return {
    ...(config.github ? { github: new GitHubProvider(config.github) } : {}),
    ...(config.google ? { google: new GoogleProvider(config.google) } : {}),
  };
}
