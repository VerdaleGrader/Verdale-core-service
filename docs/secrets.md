# Secrets: inventory, owners and rotation (GRD-59)

Every secret of the platform, where it lives, who may read it, and how to change
it **without stopping the system**. A secret that cannot be rotated is a
liability: rotate on a schedule, and at once when a person with access leaves or
a machine is suspected.

The repository holds no secret. Two things enforce it: `.env` files are in
`.gitignore` and CI fails if one is tracked; and CI scans the whole history with
gitleaks (`.gitleaks.toml`, job `secrets`). If the scan fails on a real secret:
**rotate it first** (rewriting history does not un-leak it), then remove it.

## Inventory

"Reads" is the least access that makes the system work. Fill the last column in
when a person is named; the table is the checklist for the quarterly review.

| Secret                                      | Variable(s)                                                                                                    | Used by                                                    | Stored in                                                                                                         | Reads                                            | Rotate                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Core-to-Judge HMAC key (signs jobs)         | Core: `JUDGE_KEY_ID`, `JUDGE_SECRET`. Judge: `VERDALE_JUDGE_AUTH_INBOUND_KEYS` (keyring)                       | Core signs, Judge verifies                                 | Core: the Jenkins file credential `verdale-core-service-prod`. Judge: `/etc/verdale-judge/judge.env` (root, 0600) | Core's deployers; root on the Judge machine      | every 90 days, and on any suspicion. [HMAC](#rotate-an-hmac-key)                          |
| Judge-to-Core HMAC key (signs results)      | Judge: `VERDALE_JUDGE_CALLBACK_KEY_ID`, `VERDALE_JUDGE_CALLBACK_SECRET`. Core: `JUDGE_CALLBACK_KEYS` (keyring) | Judge signs, Core verifies                                 | as above                                                                                                          | as above                                         | as above. A leaked callback key cannot submit jobs, and the reverse                       |
| Database password                           | `DATABASE_URL`, `DIRECT_DATABASE_URL` (Neon)                                                                   | Core only; `DIRECT_…` only for migrations and the seed     | Jenkins credential                                                                                                | Core's deployers. **Never on the Judge machine** | every 180 days. [Database](#rotate-the-database-password)                                 |
| R2 token, read and write                    | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                                      | Core (tests and pictures)                                  | Jenkins credential                                                                                                | Core's deployers                                 | every 180 days. [R2](#rotate-an-r2-token)                                                 |
| R2 token, **read only** on the tests bucket | `VERDALE_JUDGE_STORAGE_S3_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY`                                                | Judge                                                      | `judge.env`                                                                                                       | root on the Judge machine                        | every 180 days, and when that machine is rebuilt                                          |
| Better Stack source token                   | `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_INGESTING_HOST`                                                       | Core logging (Judge does not ship logs)                    | Jenkins credential                                                                                                | Core's deployers                                 | on suspicion; a token can only write logs. [Better Stack](#rotate-the-better-stack-token) |
| Session / OAuth-state secret                | `SESSION_SECRET`                                                                                               | Core (signs the short-lived OAuth state cookie)            | Jenkins credential                                                                                                | Core's deployers                                 | every 180 days. [Session](#rotate-the-session-secret)                                     |
| OAuth client secrets                        | `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`                                                                 | Core sign-in                                               | Jenkins credential                                                                                                | Core's deployers; the provider consoles          | every 365 days or when a console admin leaves                                             |
| Keyring for authors' AI keys                | `AI_KEY_ENCRYPTION_KEYS`                                                                                       | Core encrypts and decrypts the keys authors save (GRD-124) | Jenkins credential                                                                                                | Core's deployers                                 | on suspicion. Already rotates without downtime, [see below](#rotate-the-ai-key-keyring)   |
| Redis password                              | `REDIS_PASSWORD`, `VERDALE_JUDGE_REDIS_PASSWORD`                                                               | Judge and its Redis, same machine, `127.0.0.1`             | `judge.env`, the Compose environment                                                                              | root on the Judge machine                        | when the machine is rebuilt                                                               |

Authors' own AI keys are not platform secrets: they sit in the database,
encrypted with the keyring above, and never leave Core.

Decide the names and fill in the "Reads" column in the team's own tracker; do
not write people or tokens in this file.

## Rotate an HMAC key

Both sides accept **several keys at once** (a keyring of `key-id:secret`) and the
signature carries the key id, so a key is replaced in three steps and nothing is
refused in between. `src/libs/hmac.test.ts` and Judge's `pkg/hmacauth` test this
sequence. Do each direction on its own, one at a time.

_Core to Judge (jobs)._ Judge reads its keyring at start, so each Judge restart
is a drain (`systemctl restart` waits for running jobs; queued jobs stay in
Redis).

1. Make a secret of at least 32 characters (`openssl rand -base64 48`) and a **new key id** that carries the date, e.g. `core-2027-01`.
2. **Judge learns it:** add `core-2027-01:<new>` to `VERDALE_JUDGE_AUTH_INBOUND_KEYS` next to the old pair (`old-id:<old>,core-2027-01:<new>`), restart Judge. Core still signs with the old key: everything works.
3. **Core switches:** set `JUDGE_KEY_ID=core-2027-01` and `JUDGE_SECRET=<new>`, deploy Core. Jobs signed with the old key that are in flight still verify.
4. Check, for a day if you like: Judge's log has no "rejected unsigned or badly signed request" lines.
5. **Judge forgets the old key:** remove it from the keyring, restart Judge. A request with the old key is now refused (`UNKNOWN_KEY_ID`).

_Judge to Core (results)._ The same, mirrored: add the new pair to Core's
`JUDGE_CALLBACK_KEYS` and deploy; change `VERDALE_JUDGE_CALLBACK_KEY_ID` and
`_SECRET` on Judge and restart; remove the old pair from Core. Judge signs a
result when it delivers it, so after the restart even results that were waiting
in its outbox use the new key; keep the old pair in Core's keyring until that
restart is done and `judge_outbox_pending` has been 0 once.

If a key is **known to be leaked**, do steps 1 to 5 at once and skip the wait in
step 4. The ±300 s window and the signature over the body and the path limit
what a leaked key could do in the meantime to jobs of that direction only.

## Rotate the database password

Neon: create a second role with the same rights, put its connection strings in
the Jenkins credential, deploy Core (it restarts and reconnects), check `/ready`,
then drop the old role. Do the migrations connection (`DIRECT_DATABASE_URL`) in
the same release.

## Rotate an R2 token

Create a new token with the same scope (Core: read and write on both buckets;
Judge: **read only** on the tests bucket), switch the consumer, check a
submission (Core) or a job (Judge), revoke the old token. Judge's disk cache
of test files already fetched is not affected by the switch.

## Rotate the Better Stack token

Create a new source token, deploy Core with it, revoke the old one.

## Rotate the session secret

`SESSION_SECRET` only signs the OAuth state cookie that lives during a sign-in
(minutes). Sessions themselves are random tokens stored hashed in the database
(`docs/auth.md`), so changing the secret **does not sign anybody out**; people who
are in the middle of signing in must start again.

## Rotate the AI key keyring

`AI_KEY_ENCRYPTION_KEYS` is a keyring too: put the new `key-id:secret` **first**
(it encrypts new keys), keep the old one behind it so saved keys stay readable,
and drop the old one when no row uses its id:

```sql
select key_id, count(*) from user_ai_credentials group by key_id;
```

An author who saves their key again moves it to the newest id.

## When a secret is leaked, or a person or machine is no longer trusted

1. Rotate the secrets in the inventory that the person or machine could read (the "Reads" column), starting with the ones that give the most: the database password and the R2 read-and-write token.
2. A Judge machine under suspicion holds only: the two HMAC keys, a read-only R2 token and the Redis password (docs/runbook.md in the Judge repository). Rebuild the machine and rotate those four.
3. Look at `audit_logs` and the logs for the period since the exposure.

## Rotation drill

A rotation is only real once it has been done. Record each drill here:

| Date    | Secret              | Where   | Who | Result                                                                                                                   |
| ------- | ------------------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------ |
| not yet | HMAC, Core to Judge | staging |     | The three steps are covered by unit tests on both sides; the run on staging (with a Judge restart) has **not** been done |
