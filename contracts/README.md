# Verdale contracts

Source of truth for every API contract between the three Verdale repositories.

| File                       | What                                                                 |
| -------------------------- | -------------------------------------------------------------------- |
| `core-public.openapi.yaml` | Core's public HTTP API, consumed by Frontend                         |
| `judge.openapi.yaml`       | Judge's internal API and the result callback, between Core and Judge |
| `HMAC.md`                  | How Core and Judge sign and verify requests                          |
| `hmac-test-vectors.json`   | Expected signatures, run by both implementations' tests              |
| `VERSION`                  | Contract version, pinned by consumers                                |
| `CHANGELOG.md`             | History and the rules for changing a contract                        |

## Who generates what

| Repo             | Generates from             | Output                                                                          | Check                     |
| ---------------- | -------------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| Core (this repo) | both specs                 | `src/contracts/*.gen.ts` (types)                                                | `npm run contracts:check` |
| Frontend         | `core-public.openapi.yaml` | `lib/contracts/core-public.gen.ts` (types for the typed `openapi-fetch` client) | `npm run contracts:check` |
| Judge            | `judge.openapi.yaml`       | `pkg/contract/types.gen.go`                                                     | `make contracts-check`    |

Consumers never edit their copy. They pin a version by copying this folder with their `contracts:sync` script, which records the version and the SHA-256 of every file in `contracts/contracts.lock.json`. Their CI fails when a vendored file no longer matches the lock or the generated code no longer matches the vendored spec.
