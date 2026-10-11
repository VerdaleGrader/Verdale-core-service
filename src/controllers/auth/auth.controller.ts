import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfigurations } from '@/config';
import { VError } from '@/errors';
import { OAuthProviders } from '@/libs/oauth';
import { OAUTH_STATE_COOKIE, SESSION_COOKIE } from '@/middleware/session';
import AuthService, { OAuthStateCookie } from '@/services/auth/auth.service';
import { providerParams } from '@/validation/schemas';
import { z } from 'zod';

const STATE_COOKIE_PATH = '/api/v1/auth/oauth';
const STATE_MAX_AGE_SECONDS = 10 * 60;

const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(100).optional(),
});

export default class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: AuthConfigurations,
    private readonly providers: OAuthProviders
  ) {}

  /** GET /api/v1/auth/providers: which sign-in buttons to show. */
  async providersList(_request: FastifyRequest, reply: FastifyReply) {
    return reply.send({ providers: Object.keys(this.providers) });
  }

  /** GET /api/v1/auth/oauth/:provider/start?redirect=/path */
  async start(request: FastifyRequest, reply: FastifyReply) {
    const { provider } = providerParams.parse(request.params);
    const { redirect } = z
      .object({ redirect: z.string().max(512).optional() })
      .parse(request.query);
    const { authorizeUrl, stateCookie } = this.authService.startOAuth(provider, redirect);
    reply.setCookie(OAUTH_STATE_COOKIE, JSON.stringify(stateCookie), {
      signed: true,
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax', // the provider sends the browser back with a top-level GET
      path: STATE_COOKIE_PATH,
      maxAge: STATE_MAX_AGE_SECONDS,
    });
    return reply.redirect(authorizeUrl);
  }

  /** GET /api/v1/auth/oauth/:provider/callback: the browser lands here, so answer with redirects. */
  async callback(request: FastifyRequest, reply: FastifyReply) {
    const { provider } = providerParams.parse(request.params);
    const query = callbackQuery.parse(request.query);
    const stateCookie = this.readStateCookie(request);
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: STATE_COOKIE_PATH });

    if (query.error) return this.failure(reply, 'access_denied');
    try {
      const result = await this.authService.completeOAuth(provider, query, stateCookie, request.id);
      reply.setCookie(SESSION_COOKIE, result.sessionToken, {
        httpOnly: true,
        secure: this.config.cookieSecure,
        sameSite: 'lax',
        path: '/',
        expires: result.expiresAt,
      });
      return reply.redirect(`${this.config.frontendOrigin}${result.redirect}`);
    } catch (error) {
      if (error instanceof VError) return this.failure(reply, error.error_code.toLowerCase());
      throw error;
    }
  }

  /** POST /api/v1/auth/logout: the session stops working at once, server-side. */
  async logout(request: FastifyRequest, reply: FastifyReply) {
    await this.authService.logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  }

  private failure(reply: FastifyReply, code: string) {
    return reply.redirect(`${this.config.frontendOrigin}/login?error=${encodeURIComponent(code)}`);
  }

  private readStateCookie(request: FastifyRequest): OAuthStateCookie | null {
    const raw = request.cookies[OAUTH_STATE_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    try {
      const parsed = JSON.parse(unsigned.value) as OAuthStateCookie;
      return typeof parsed.state === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
}
