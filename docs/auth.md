# Accounts, Spaces and permissions (Milestone 2)

How sign-in, Spaces and the permission engine work in Core. API details live in `contracts/core-public.openapi.yaml`.

## Spike result: how we authenticate (GRD-10)

**Decision (2026-10-11, project owner): OAuth only (GitHub and Google). No passwords.** Core implements the OAuth 2.0 authorization-code flow with PKCE itself (`src/libs/oauth.ts`, `src/services/auth/auth.service.ts`) and keeps its own `users`, `oauth_accounts` and `sessions` tables.

| Criterion                | Hand-rolled OAuth in Core (chosen)                                                   | Better Auth, self-hosted in Core                                                                                       | Neon Auth (managed Better Auth)                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| E-mail and password      | Not built (decided: OAuth only)                                                      | Built in                                                                                                               | Built in                                                                                      |
| OAuth providers          | GitHub, Google (about 100 lines each); more means more code                          | Many providers as config                                                                                               | Google, GitHub, Vercel as managed; others via plugin matrix ¹                                 |
| Session shape            | Opaque random token in an httpOnly cookie, SHA-256 hash in `sessions`                | Cookie + database session                                                                                              | Cookie/session in the `neon_auth` schema                                                      |
| Cost                     | None                                                                                 | None (MIT licence ²)                                                                                                   | Auth MAU allowance is part of the Neon plan (60k Free, 1M Launch/Scale ¹); overage unverified |
| Provider lock-in         | None                                                                                 | Library, not a vendor                                                                                                  | Neon only; product is in beta, runs a pinned Better Auth version ¹                            |
| Who owns the users table | Core (`users`, with username rules and the personal Space in the signup transaction) | Better Auth wants its own `user/session/account` tables; Core's `users` would have to map onto them or sit beside them | `neon_auth.user` belongs to Neon; Core would keep a second `users` table in sync              |

¹ From Neon's pricing and Neon Auth documentation; Neon Auth is in beta, so re-check before relying on it. ² From third-party summaries; confirm in the Better Auth repository.

Why hand-rolled: with OAuth only, the flow is small and well specified; Core must create the user, the personal Space and the session in **one transaction** (GRD-16) and enforce shared username/slug rules, which is awkward when another library owns the user table. The price is that we maintain security-sensitive code. **Revisit and adopt Better Auth when** we add e-mail/password, magic links, MFA, or more than two or three providers.

Effect on GRD-11: no password hashing or e-mail verification code; "register" and "login" are the same flow (first sign-in creates the account). Brute-force protection is a per-client rate limit on the sign-in endpoints. Effect on GRD-12: usernames are generated from the provider profile at first sign-in (made unique), and the user can change them with `PATCH /api/v1/me`.

## Sign-in flow

1. Browser navigates to `GET /api/v1/auth/oauth/{provider}/start?redirect=/page`. Core sets a signed, httpOnly, 10-minute cookie (`vd_oauth`) holding the random `state`, the PKCE verifier and the safe redirect, then redirects to the provider.
2. The provider redirects to `{FRONTEND_ORIGIN}/api/v1/auth/oauth/{provider}/callback`. Core checks the `state` against the cookie, exchanges the code (with the PKCE verifier), reads the profile, and **requires a verified e-mail** (linking by an unverified e-mail would allow account takeover).
3. In one transaction: find the user by provider account; else by verified e-mail (links the new provider); else create the user, the personal Space (private, user is owner) and the provider link.
4. Core creates a session: a 256-bit random token in the `vd_session` cookie (httpOnly, SameSite=Lax, Secure outside local, 30 days). Only the SHA-256 hash is stored.
5. Failures never show JSON to the browser: it is redirected to `{FRONTEND_ORIGIN}/login?error=access_denied|bad_request|not_found`.

Logout deletes the session row, so a copied cookie stops working immediately.

**CSRF.** Cookies are SameSite=Lax, and every state-changing request that carries a session must send `Origin` equal to `FRONTEND_ORIGIN` (403 otherwise). The browser reaches Core only through the web app's `/api/*` proxy, so this is always true for the real app.

**Rate limits** (per client address, in memory, so per Core process): 20 requests/minute on the sign-in endpoints, 300/minute on the rest of the API. Set `TRUST_PROXY=true` behind nginx so the real client address is used.

### Registering the OAuth apps

| Provider | Where                                                              | Callback URL                                          |
| -------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| GitHub   | Settings > Developer settings > OAuth Apps                         | `{FRONTEND_ORIGIN}/api/v1/auth/oauth/github/callback` |
| Google   | Cloud Console > APIs & Services > Credentials > OAuth client (Web) | `{FRONTEND_ORIGIN}/api/v1/auth/oauth/google/callback` |

Use a separate app per environment (local `http://localhost:3000`, staging, production). Put the id and secret in `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Usernames and slugs

One namespace: lower-case, 3 to 32 characters, `[a-z0-9_-]`, starting with a letter or digit, not on the reserved list (`src/constants/identifiers.ts`). A user's personal Space has slug = username, so no Space can take a name that is (or later becomes) someone's username. Changing the username renames the personal Space's slug in the same transaction. Stored lower-case with CHECK constraints, so uniqueness is case-insensitive by construction.

## Spaces and membership

- `spaces`: `created_by_id` (the creator; never changes), name, slug (never changes), description, visibility, `is_personal`, `archived_at`. The owner is the one membership with role `owner` (exactly one per Space); ownership is handed over by making another member the owner (the old owner becomes an administrator).
- `memberships`: (space, user) unique, role owner / administrator / editor / observer / solver (one `owner` per Space: a partial unique index).
- `invites`: SHA-256 of the token, role (administrator, editor, observer or solver, never owner), optional invitee, status, `expires_at`. Expiry is computed from `expires_at`, never stored.
- **Exactly one owner:** services refuse to remove or demote the owner or let them leave (409; hand the Space over first), serialising concurrent changes with a row lock on the Space. The unique index forbids a second owner and a deferred constraint trigger forbids none at commit, so no code path can leave a Space without or with two owners. When the migration introduced the rule, a Space with several owners kept its oldest owner and the others became administrators.
- **Who may change whom** (`canAssignRole`, `canRemoveMember`): the owner anyone but themselves (making someone owner is the handover); an administrator editors, observers and solvers, never another administrator or the owner. Inviting follows the same rule. Visibility, archiving and handover are the owner's alone.
- **Personal Space:** exactly one per user (partial unique index), created in the signup transaction, cannot be archived, and a trigger blocks deleting it.
- A private Space answers **404**, not 403, to anyone who is not a member (its existence is not leaked). A visible Space where the action is not allowed answers 403.

## Permission table (`src/permissions/can.ts`)

`can(actor, action, resource)` is the only place that decides access. Callers load the facts (role, visibility, archived) and pass them in. Every cell of this table has a unit test (`src/permissions/can.test.ts`).

| Action                            | Visitor (not logged in)  | Logged-in, not a member  |    Solver     |   Observer   |    Editor    | Administrator |    Owner     |
| --------------------------------- | :----------------------: | :----------------------: | :-----------: | :----------: | :----------: | :-----------: | :----------: |
| space.view                        |       public only        |       public only        |      yes      |     yes      |     yes      |      yes      |     yes      |
| space.view_members                |            no            |            no            |      yes      |     yes      |     yes      |      yes      |     yes      |
| space.update / manage_members     |            no            |            no            |      no       |      no      |      no      |     yes ¹     |    yes ¹     |
| space.change_visibility / archive |            no            |            no            |      no       |      no      |      no      |      no       |    yes ¹     |
| space.transfer_ownership          |            no            |            no            |      no       |      no      |      no      |      no       |    yes ¹     |
| space.leave                       |            no            |            no            |      yes      |     yes      |     yes      |      yes      |     no ²     |
| problem.view ⁵                    |  published, public only  |  published, public only  |   published   |     all      |     all      |      all      |     all      |
| problem.view_private ⁴            |            no            |            no            |      no       |     yes      |     yes      |      yes      |     yes      |
| problem.create / update / publish |            no            |            no            |      no       |      no      |    yes ¹     |     yes ¹     |    yes ¹     |
| submission.create ⁵               |     **no (log in)**      |    public Spaces only    |     yes ¹     |    yes ¹     |    yes ¹     |     yes ¹     |    yes ¹     |
| submission.view                   |            no            |    own, public Spaces    |      own      | everyone's ³ | everyone's ³ | everyone's ³  | everyone's ³ |
| submission.view_all (GRD-93)      |            no            |            no            |      no       |     yes      |     yes      |      yes      |     yes      |
| track.view ⁶                      | open Tracks, public only | open Tracks, public only | open + joined |     all      |     all      |      all      |     all      |
| track.manage / manage_members     |            no            |            no            |      no       |      no      |    yes ¹     |     yes ¹     |    yes ¹     |
| track.view_progress (others')     |            no            |            no            |      no       |     yes      |     yes      |      yes      |     yes      |

¹ Not in an archived Space: an archived Space is read-only (problems stay visible; nothing created, edited, published or submitted; settings and members frozen). ² The owner hands the Space over first. ³ Decided in GRD-46: the staff (owner, administrator, editor, observer) see everyone's submissions in their Space, everyone else only their own. ⁴ Hidden tests, reference solutions and the editor view; readable by the staff in an archived Space too. An **observer** is read-only staff: it reads what an editor reads but creates, edits, publishes and manages nothing, and cannot re-judge.

Publish gate (M4): verify, Minor/Major updates, starting or discarding a Major draft and reading `…/verify` follow the table (`problem.update` to change, `problem.view_private` to read, so observers read the history and the verification report but change nothing; `problem.publish` for the publish itself). Solvers and visitors get 403/404 for all of them, checked before the problem is looked up.

⁵ Since GRD-81 a solver, an outsider of a public Space and a visitor reach a problem only through a Collection of a Track they can see (`problemInTrack`); the staff do not need one. Details and the exact 404 rules: [tracks.md](tracks.md). ⁶ A Track is visible when it is not archived and either open to the Space or the person was added to it; the staff see every Track, archived ones too.

Public Space: a logged-in user can view and submit code. Private Space: members only. **Visitors can view public Spaces and published problems but must log in to submit** (decision 2026-10-11).

## Terms and Privacy Policy acceptance (GRD-122)

Core records which version of the Terms and the Privacy Policy each user accepted, and when, in `legal_acceptances` (primary key user + document + version, plus `accepted_at`). Nothing else is stored: no IP address, no user agent, because the Privacy Policy lists what Verdale collects and this is not on the list.

- **One place to change the version.** `src/constants/legal.ts` (`CURRENT_LEGAL_VERSIONS`). A version is the document's effective date (`YYYY-MM-DD`). Republish a document: change its date there, in the Frontend's `lib/legal.ts` and in `content/legal/*.md`, in the same release.
- **First sign-in.** `AuthService.completeOAuth` creates the user, the personal Space, the acceptance records and the session in one transaction. The login page says that signing in means accepting both documents.
- **After a change.** `LegalService.hasAcceptedCurrent` is checked in the session hook (`src/routes.ts`). A signed-in user who has not accepted the current versions gets `403 LEGAL_ACCEPTANCE_REQUIRED` on every call except `GET /api/v1/me` (which carries `legal.acceptance_required`), `POST /api/v1/me/legal-acceptance` and `/api/v1/auth/*` (so they can log out). Users who signed up before this feature have no records and are asked once. Visitors are never asked.
- **Accepting** sends the versions the page showed; Core records them only if they are still current (`409 LEGAL_VERSION_CHANGED` otherwise). Old records stay as history and go with the account (`ON DELETE CASCADE`).

## Testing

`npm test` runs unit tests anywhere. Integration tests (sign-in, profile, Spaces, members, invitations, database rules) need Postgres with the migrations applied and are skipped without `TEST_DATABASE_URL`:

```bash
docker compose up -d postgres
DIRECT_DATABASE_URL=postgresql://verdale_core:local-postgres-password@127.0.0.1:5433/verdale npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://verdale_core:local-postgres-password@127.0.0.1:5433/verdale npm test
```

The tests empty every table, so they refuse to run against a non-local host. CI runs them against a Postgres service.
