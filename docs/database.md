# Database (Neon Postgres)

Decided for GRD-2: local development uses a **Neon `dev` branch**, not a local Postgres container. Every developer points `.env` at the dev branch (or their own child branch of it).

## Branches (GRD-3)

| Branch    | Used by           | Notes                                                                                             |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `main`    | production        | Launch plan with scale-to-zero off at public launch (GRD-64)                                      |
| `staging` | staging deploys   | Branched from `main`                                                                              |
| `dev`     | local development | Branched from `staging`; reset freely. A developer may create a child branch for risky migrations |

Region: AWS ap-southeast-1 (Singapore).

## Roles

Core connects as `verdale_core`, which owns the `verdale` database and its tables but is **not** a superuser (Neon's default owner role is not a superuser either; do not use `neondb_owner` for the service). Each branch has its own password.

## Connection strings

| Variable              | Neon host                                           | Used by                                                                |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`        | `ep-…-pooler…` (pooled, PgBouncer transaction mode) | the running service (`src/libs/prisma.ts`)                             |
| `DIRECT_DATABASE_URL` | `ep-…` (direct)                                     | `prisma migrate`, `prisma db seed`, Prisma Studio (`prisma.config.ts`) |

Both need `?sslmode=require`. They are secrets: keep them in the secret store and in your untracked `.env`, never in the repository.

## Connection limits

- Neon's pooler accepts up to 10,000 client connections and opens a limited number of real Postgres connections (it depends on compute size; 0.25 CU allows roughly 104 direct connections, a few reserved for Neon).
- PgBouncer in transaction mode does not support session state (`SET`, advisory session locks, prepared statements across transactions); Prisma with the `pg` adapter works within that.
- Migrations must use the direct URL: they need session-level locks.
- Keep `DATABASE_POOL_MAX` small (default 10) per Core process.
- On the Free plan the compute scales to zero after 5 minutes idle; the first query after that takes a few hundred milliseconds. `/ready` may briefly fail during that wake-up.

## Migrations

```bash
npm run db:migrate -- --name add_spaces   # create + apply on your dev branch (direct URL)
npm run db:deploy                          # apply pending migrations (staging/production release step)
npm run db:seed                            # sample users; refuses ENV=production
```

CI applies every migration to an empty Postgres and checks the result matches `schema.prisma`.

**When a migration goes wrong**: Prisma Migrate has no down migrations. Never edit or delete a migration that has reached `staging` or `main`. Write a new migration that fixes the problem and deploy it. If a migration failed half-way on a branch, mark it with `npx prisma migrate resolve --rolled-back <name>` (after undoing its partial changes) or `--applied <name>` (after completing them by hand), then deploy the fix. On Neon, test risky migrations first on a child branch of `staging`.
