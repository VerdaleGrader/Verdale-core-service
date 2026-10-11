## What and why

<!-- Story key (GRD-n) and a short summary. -->

## How it was tested

- [ ] `npm run check` passes (lint, format, typecheck, tests, contract check)
- [ ] New migrations apply to an empty database (`npm run db:deploy` on a fresh branch)

## Contract

- [ ] No contract change, or `contracts/` was changed, VERSION and CHANGELOG bumped, and `npm run contracts:generate` run

## Checklist

- [ ] New settings are validated in `src/config` and documented in `.env.example`
- [ ] Logs use TLogger with request_id and contain no secrets or hidden test content
