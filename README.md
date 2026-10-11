# Verdale Core service

Core owns accounts, Spaces and permissions, problems, submissions and the publish gate. It is the only service with database access. It talks to the Frontend over the public API and to Judge over the signed internal API.

Stack: Node 22, TypeScript, Fastify 5, Prisma 7 (Neon Postgres), Zod, winston → Better Stack, Jest.

> Status: M1 gave the service skeleton (config, health/readiness, logging, error format, graceful shutdown), Prisma and the API contracts. M2 adds OAuth sign-in and sessions, usernames, Spaces, members, invitations and the permission engine (see [docs/auth.md](docs/auth.md)). Problems and submissions come in M3.

## Run it

```bash
cp .env.example .env          # fill in the Neon dev branch URLs (docs/database.md)
npm install
npx prisma generate
npm run db:deploy             # apply migrations to your dev branch
npm run db:seed               # sample users, their personal Spaces, one public Space
npm run dev                   # http://localhost:8080/health, /ready
```

### Or with Docker Compose (local Postgres, no Neon)

```bash
docker compose up --build     # Postgres 17 -> migrations -> Core on http://localhost:8080
docker compose run --rm seed  # sample users
docker compose down -v        # stop and wipe the local database
```

Does not read `.env`. Override host ports with `CORE_PORT` (default 8080) and `POSTGRES_PORT` (default 5433) if they are taken, e.g. by `npm run dev`.

## Commands

| Command                          | What                                                                       |
| -------------------------------- | -------------------------------------------------------------------------- |
| `npm run check`                  | Everything CI runs: ESLint, Prettier, `tsc --noEmit`, Jest, contract check |
| `npm run dev`                    | Run with reload                                                            |
| `npm run build` / `npm start`    | Compile to `build/` and run                                                |
| `npm run db:migrate -- --name x` | Create and apply a migration (direct URL)                                  |
| `npm run db:deploy`              | Apply pending migrations (release step)                                    |
| `npm run db:seed`                | Seed development data                                                      |
| `TEST_DATABASE_URL=… npm test`   | Also runs the database integration tests (docs/auth.md#testing)            |
| `npm run contracts:generate`     | Regenerate `src/contracts/*.gen.ts` from `contracts/`                      |

## Layout

Controller → Service → Repository, wired by hand in `src/routes.ts`, as in the Trailblazer backend.

```
contracts/          API contracts for all three repos (source of truth, see contracts/README.md)
prisma/             schema, migrations, seed
src/index.ts        startup, graceful shutdown (close server, close DB, flush logs)
src/routes.ts       app, request id, standard error handler, routes
src/config/         environment schema; refuses to start when invalid
src/controllers/    HTTP handlers
src/permissions/    can(actor, action, resource): the one place that decides access
src/middleware/     session cookie names, requireUser
src/services/       business logic; throw typed errors from src/errors
src/repositories/   Prisma queries only
src/libs/           winston (Better Stack), Prisma, HMAC signing
src/logging/        TLogger: layer, context, request_id on every line
src/contracts/      generated types (do not edit)
docs/               database guide, auth and permissions, decision log
```

Conventions: snake_case database columns, `TLogger` instead of `console`, services throw `VError` subclasses, every error response is `{status, error_code, message, request_id, details?}`.

## Running all three repos together

The repos are siblings: `Verdale-core-service`, `Verdale-judge-service`, `Verdale-frontend`.

1. **Judge** (needs Docker; the sandbox runs in a privileged Linux container):
   ```bash
   cd Verdale-judge-service && cp .env.example .env && make up
   ```
   Judge listens on `localhost:8081`. It can send results to Core at `http://host.docker.internal:8080/internal/judge/` (allowed in its `config.json`) or to its own mock Core on `localhost:8090`. Until Core receives results (GRD-44), use `make submit` in the Judge repo to drive it.
2. **Core**: `npm run dev` here (port 8080).
3. **Frontend**:
   ```bash
   cd Verdale-frontend && cp .env.example .env.local && npm install && npm run dev
   ```
   Open http://localhost:3000. The Frontend proxies `/api/*` and `/health`, `/ready` to Core.

Keys: Core's core-to-judge signing key must match `VERDALE_JUDGE_AUTH_INBOUND_KEYS` in Judge's `.env`, and Judge's callback key must be in Core's judge-to-core keyring (added with GRD-44).

## Contracts

`contracts/` is the source of truth for the Core public API, the Judge API and the HMAC scheme. Change them here first, bump `contracts/VERSION` and the changelog, run `npm run contracts:generate`, then re-pin in Frontend (`npm run contracts:sync`) and Judge (`make contracts-sync`). See [contracts/README.md](contracts/README.md).

## More

- [docs/database.md](docs/database.md): Neon branches, roles, pooled vs direct URLs, connection limits, fixing a bad migration
- [docs/decisions.md](docs/decisions.md): engineering decisions for Milestone 1
