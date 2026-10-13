import type { PrismaClient } from '../../../generated/prisma/client';
import type { AuthConfigurations } from '@/config';
import { isValidIdentifier } from '@/constants/identifiers';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors';
import {
  OAuthExchangeError,
  OAuthProfile,
  OAuthProviderName,
  OAuthProviders,
  createPkcePair,
  safeAvatarUrl,
} from '@/libs/oauth';
import { generateToken, hashToken } from '@/libs/tokens';
import TLogger, { Layer } from '@/logging/logger';
import { Db, isUniqueViolation } from '@/repositories/db';
import SessionRepository from '@/repositories/session.repository';
import SpaceRepository from '@/repositories/space.repository';
import TrackRepository from '@/repositories/track.repository';
import UserRepository from '@/repositories/user.repository';
import LegalService from '@/services/legal/legal.service';
import { toSessionUser, SessionUser } from '@/services/user/user.mapper';

export interface OAuthStart {
  authorizeUrl: string;
  /** Goes into a signed, short-lived cookie and comes back with the callback. */
  stateCookie: OAuthStateCookie;
}

export interface OAuthStateCookie {
  provider: OAuthProviderName;
  state: string;
  verifier: string;
  redirect: string;
}

export interface LoginResult {
  sessionToken: string;
  expiresAt: Date;
  user: SessionUser;
  redirect: string;
  isNewUser: boolean;
}

const MAX_SIGNUP_ATTEMPTS = 5;

/** Only same-site relative paths are allowed as a post-login destination. */
export function safeRedirectPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  if (/\p{Cc}/u.test(value)) return '/';
  return value;
}

/** Turns a provider's login or e-mail prefix into a valid username candidate. */
export function usernameCandidate(hint: string): string {
  let candidate = hint
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 24);
  if (candidate.length < 3) candidate = `user-${candidate}`.replace(/-$/, '');
  if (candidate.length < 3) candidate = 'user';
  return candidate;
}

export default class AuthService {
  private readonly logger = new TLogger(Layer.SERVICE);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly spaces: SpaceRepository,
    private readonly tracks: TrackRepository,
    private readonly legal: LegalService,
    private readonly providers: OAuthProviders,
    private readonly config: AuthConfigurations,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The URL a provider sends the browser back to; must match the app registered at the provider. */
  callbackUrl(provider: OAuthProviderName): string {
    return `${this.config.frontendOrigin}/api/v1/auth/oauth/${provider}/callback`;
  }

  startOAuth(provider: OAuthProviderName, redirect: unknown): OAuthStart {
    const client = this.providers[provider];
    if (!client) throw new NotFoundError('This sign-in method is not available.');
    const { verifier, challenge } = createPkcePair();
    const state = generateToken();
    return {
      authorizeUrl: client.authorizeUrl({
        state,
        codeChallenge: challenge,
        redirectUri: this.callbackUrl(provider),
      }),
      stateCookie: { provider, state, verifier, redirect: safeRedirectPath(redirect) },
    };
  }

  async completeOAuth(
    provider: OAuthProviderName,
    query: { code?: string; state?: string },
    stateCookie: OAuthStateCookie | null,
    requestId: string
  ): Promise<LoginResult> {
    const logger = this.logger.setContext('service.auth.completeOAuth', requestId);
    const client = this.providers[provider];
    if (!client) throw new NotFoundError('This sign-in method is not available.');
    if (
      !stateCookie ||
      stateCookie.provider !== provider ||
      !query.state ||
      query.state !== stateCookie.state ||
      !query.code
    ) {
      throw new BadRequestError('The sign-in attempt is invalid or has expired. Please try again.');
    }

    let profile: OAuthProfile;
    try {
      profile = await client.fetchProfile({
        code: query.code,
        codeVerifier: stateCookie.verifier,
        redirectUri: this.callbackUrl(provider),
      });
    } catch (error) {
      if (error instanceof OAuthExchangeError || error instanceof Error) {
        logger.warn({ message: 'OAuth exchange failed', data: { provider }, error });
      }
      throw new BadRequestError('Sign-in with the provider failed. Please try again.');
    }
    if (!profile.providerAccountId || !profile.email) {
      throw new BadRequestError('The provider did not share an e-mail address.');
    }
    if (!profile.emailVerified) {
      // Linking by an unverified e-mail would let anyone take over an account.
      throw new BadRequestError('Your e-mail address at the provider is not verified.');
    }

    for (let attempt = 1; ; attempt++) {
      try {
        // The user, the personal Space, the acceptance of the Terms and the
        // session are created together (GRD-10, GRD-122): a failure leaves no
        // half-made account behind, and nobody gets a session without a record.
        const { session, ...outcome } = await this.prisma.$transaction(async (tx) => {
          const resolved = await this.resolveUser(tx, provider, profile);
          return { ...resolved, session: await this.createSession(tx, resolved.user.id) };
        });
        logger.info({
          message: outcome.isNewUser ? 'user signed up' : 'user logged in',
          data: { provider, userId: outcome.user.id },
        });
        return {
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          user: toSessionUser(outcome.user),
          redirect: stateCookie.redirect,
          isNewUser: outcome.isNewUser,
        };
      } catch (error) {
        // Two sign-ups racing for the same username: pick another one.
        if (isUniqueViolation(error) && attempt < MAX_SIGNUP_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  /** Session token -> user, or null. Expired and unknown tokens look the same. */
  async authenticate(token: string | undefined) {
    if (!token) return null;
    const session = await this.sessions.findActive(this.prisma, hashToken(token), this.now());
    return session?.user ?? null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.sessions.deleteByTokenHash(this.prisma, hashToken(token));
  }

  requireUser<T>(user: T | null): T {
    if (!user) throw new UnauthorizedError('Please log in.');
    return user;
  }

  // --- internals ----------------------------------------------------------

  private async resolveUser(tx: Db, provider: OAuthProviderName, profile: OAuthProfile) {
    const avatarUrl = safeAvatarUrl(profile.avatarUrl);
    const linked = await this.users.findByOAuthAccount(tx, provider, profile.providerAccountId);
    if (linked) return { user: await this.refreshAvatar(tx, linked, avatarUrl), isNewUser: false };

    // Same verified e-mail seen through another provider: same person.
    const sameEmail = await this.users.findByEmail(tx, profile.email);
    if (sameEmail) {
      await this.users.linkOAuthAccount(tx, sameEmail.id, provider, profile.providerAccountId);
      return { user: await this.refreshAvatar(tx, sameEmail, avatarUrl), isNewUser: false };
    }

    const username = await this.freeUsername(tx, profile.usernameHint);
    const displayName = (profile.displayName.trim() || username).slice(0, 64);
    const user = await this.users.create(tx, {
      email: profile.email,
      username,
      display_name: displayName,
      avatar_url: avatarUrl,
    });
    await this.users.linkOAuthAccount(tx, user.id, provider, profile.providerAccountId);

    // Signing up always yields a personal Space (GRD-16), in this transaction.
    const space = await this.spaces.create(tx, {
      created_by_id: user.id,
      name: username,
      slug: username,
      description: '',
      visibility: 'private',
      is_personal: true,
    });
    await this.spaces.addMember(tx, space.id, user.id, 'owner');
    await this.tracks.createStarterTrack(tx, space.id);
    // The login page says that signing in means accepting the Terms and the
    // Privacy Policy; record which versions were in force (GRD-122).
    await this.legal.recordCurrent(tx, user.id);
    return { user, isNewUser: true };
  }

  /**
   * The picture is refreshed at every login (GRD-68). A provider that sends
   * none leaves the stored one alone, so a missing picture in one login
   * does not erase a good one from another provider.
   */
  private async refreshAvatar<T extends { id: string; avatar_url: string | null }>(
    tx: Db,
    user: T,
    avatarUrl: string | null
  ): Promise<T> {
    if (avatarUrl === null || avatarUrl === user.avatar_url) return user;
    return (await this.users.update(tx, user.id, { avatar_url: avatarUrl })) as unknown as T;
  }

  private async freeUsername(tx: Db, hint: string): Promise<string> {
    const base = usernameCandidate(hint);
    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = attempt === 0 ? '' : `-${Math.floor(1000 + Math.random() * 9000)}`;
      const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      if (isValidIdentifier(candidate) && !(await this.spaces.isIdentifierTaken(tx, candidate))) {
        return candidate;
      }
    }
    return `user-${generateToken()
      .slice(0, 12)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;
  }

  private async createSession(db: Db, userId: string) {
    const now = this.now();
    await this.sessions.deleteExpiredForUser(db, userId, now);
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    await this.sessions.create(db, {
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
    });
    return { token, expiresAt };
  }
}
