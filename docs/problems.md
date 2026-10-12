# Problems, tests and submissions (Milestone 3)

How a problem is written, frozen, solved and judged. API details live in `contracts/core-public.openapi.yaml`; who may do what is in the permission table of [auth.md](auth.md).

## The shape of the data

```
space ─< problem ─< problem_version ─< test_case          (files in the private bucket, by SHA-256)
                          │        └─< reference_solution
                          └──────────< submission ─< submission_test_result
```

- **problem**: belongs to a Space; slug unique inside the Space (`/spaces/<space>/problems/<slug>`); status `draft` (never published), `published`, or `archived`; `current_version_id` is the version solvers see.
- **problem_version**: title, Markdown statement, time limit, memory limit, allowed languages, status `draft` or `published`. A problem has at most one draft version at a time (partial unique index). M3 creates version 1 with the problem; creating the next draft from a published version arrives with the publish gate (M4).
- **test_case**: position (judging order), SHA-256 and size of the input and output, `is_sample`. The files themselves are in the private bucket at `tests/<sha256>`, the same key Judge reads.
- **reference_solution**: language, source, `is_primary` (at most one per version).
- **submission**: who, which exact version, language, source (kept in Postgres, at most 64 KiB), `status` (`queued`, `running`, `completed`), `verdict` (set exactly when completed), time and memory (maximum over the tests that ran), the current Judge job id. **submission_test_result**: one row per reported test; previews exist for sample tests only.

### A published version never changes

The service refuses first (409 `VERSION_PUBLISHED`, or `PROBLEM_ARCHIVED`); a trigger in the database refuses everything that gets past it: updating a published version, adding, changing or deleting its tests and solutions, and deleting it (which also stops a cascade from deleting its problem). `src/services/problem/problem.test.ts` tests both layers. A submission points at the exact version it was judged against, so editing a problem later (a new version, M4) can never change an old result.

## Tracks, Collections and PDF statements

Problems reach solvers through Tracks and Collections (GRD-77 to GRD-82), and a version can have a PDF statement (GRD-73). Everything about them, including what solvers see and why, is in [tracks.md](tracks.md).

## Limits and ranges (decisions, 2026-10-11)

All are in `src/constants/limits.ts` and are sent to the web app in `constraints`, so nothing is hard-coded twice. They sit inside the Judge contract (time 100 ms to 20 s, memory 16 MB to 2 GB) and inside CHECK constraints in the database.

| What                              | Value                                                                                       | Why                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Time limit                        | 100 ms to 10 s, default 1 s                                                                 | Judge allows up to 20 s; nobody needs that for a grader MVP and it blocks the queue  |
| Memory limit                      | 16 MB to 1 GB, default 256 MB                                                               | Judge allows 2 GB; the sandbox box is small                                          |
| Title / statement                 | 200 / 100 000 characters                                                                    | A statement is text; a hundred thousand characters is a long article                 |
| Tests per problem                 | 100                                                                                         | Judge accepts 500; 100 keeps a run short                                             |
| One test file (after normalising) | 8 MiB                                                                                       | Enough for 10^6 numbers; the upload is held in memory, so it must stay bounded       |
| All tests of a problem            | 128 MiB                                                                                     | Bounds storage and what Judge's disk cache must hold                                 |
| Sample test files                 | 64 KiB each, at most 10 samples                                                             | Samples are shown inline in the statement                                            |
| Reference solutions               | 5 per problem, 64 KiB each                                                                  | Judge's source limit                                                                 |
| Submission source                 | 64 KiB (bytes, not characters)                                                              | Judge's source limit                                                                 |
| Statement picture                 | 2 MiB; png, jpeg, webp                                                                      | No SVG: it can carry script                                                          |
| PDF statement                     | 10 MiB, 10 pages, not encrypted                                                             | A statement is read on screen; checked from the bytes, in a worker with a time limit |
| Tracks / Collections / links      | 50 Tracks and 200 Collections per Space, 200 problems per Collection, 200 items per request | Keeps pages and reorder requests small                                               |
| Submissions                       | 10 per minute per user (re-checks share the budget)                                         | In-memory per process; GRD-55 tunes it                                               |

## Test files (GRD-23, 24, 25)

Uploaded as `multipart/form-data` (`input`, `output`, `is_sample`), so the server sees the raw bytes. Each file is checked and **normalised** before it is hashed:

1. UTF-8 text only. A NUL byte, any other control character except tab, LF and CR, or invalid UTF-8 means "binary" and is refused, with the file name, the reason and (for binary data) the byte offset.
2. A leading byte order mark is removed.
3. CRLF and lone CR become LF.
4. Trailing blank lines are removed and a non-empty file ends with exactly one LF. Trailing spaces inside lines are kept (an input may need them); Judge's line checker ignores them when comparing outputs. An empty file stays empty.

The SHA-256 and the size are of the normalised content, so the same test saved with different line endings is stored once. The raw upload is capped at the file limit before normalising.

Storing order: validate, write the objects (skipping any that already exist: content-addressed), then insert the row under a lock on the problem. A failure between the two leaves an orphan object, which is harmless; removing a test keeps its objects because another test may share them. Cleaning orphans is a later job (M5).

## Storage (GRD-23)

`src/libs/storage` hides the provider behind `FileStorage` (`put`, `get`, `head`, `delete`, streams). Implementations: Cloudflare R2 over the S3 API (`@aws-sdk/client-s3`), a local directory, and memory (tests). `RetryingFileStorage` gives every provider the same behaviour: a per-call timeout, retries with exponential backoff for "unavailable" errors only, and a 503 for the caller when it gives up. Not-found and refused requests are answered at once. Two buckets: **private** for test files (Judge has a read-only token) and **public** for statement pictures (random names, content type read from the bytes). In development, picture URLs point at `GET /api/v1/assets/<name>`; in production set `PUBLIC_ASSET_BASE_URL` to the public bucket's domain.

The integration test against a real bucket (`src/libs/storage/storage.test.ts`) runs when `R2_TEST_ENDPOINT`, `R2_TEST_ACCESS_KEY_ID`, `R2_TEST_SECRET_ACCESS_KEY` and `R2_TEST_BUCKET` are set (point them at the staging bucket); it writes under a random prefix and removes what it wrote. Without them it is skipped.

## Publishing (provisional)

`POST …/publish` makes the draft the published, immutable version. It needs a statement, an allowed language, at least one testcase, an expected output for every testcase, at least one sample testcase and a primary reference solution; otherwise 409 `PUBLISH_BLOCKED` with one `details` entry per missing item. **This is only the cheap first gate.** Milestone 4 (GRD-50 to GRD-52) puts the verification run (the reference solution against every test on Judge) in front of it. Archiving closes a published problem to submissions but keeps it readable; a never-published draft is deleted instead.

## Reference solutions (GRD-26)

Every endpoint goes through `problem.view_private` or `problem.update`: owners and editors only, in every Space type, and also in an archived Space for reading. Nothing a solver can call touches them. The test suite checks the solver-facing responses for a planted marker string.

## What solvers see (GRD-47)

`GET …/problems/{slug}` returns the statement, limits, languages and the sample tests with their content, and nothing else: no hidden test (not even a count or a hash), no solution. A draft is a 404 for solvers; owners and editors get the same response as a preview. The list shows published problems to everyone; owners and editors can also ask for drafts, archived problems, or only their own. Author endpoints check the permission **before** looking the problem up, so a solver cannot tell a draft from a missing problem by the status code (403 either way).

## Submissions (GRD-43 to GRD-46)

```
POST …/submissions  ──► row `queued` ──► 202 {id}
                              │
                  background hand-over to Judge (signed POST /internal/jobs)
                              │   Judge down? the row stays queued, retried with backoff
                              ▼
        Judge runs it ──► signed POST /internal/judge/result ──► row `completed`
```

- **Nothing is lost.** The row exists before Judge is asked. If Judge is down or answers 5xx/401/429, `next_dispatch_at` moves out with exponential backoff (1 s doubling to 60 s) and a loop (`JudgeDispatcher`, every 5 s) tries again. After 30 minutes without success the submission becomes an ISE with `JUDGE_UNAVAILABLE`; a job Judge refuses for good (400, 409, 413, 422) becomes an ISE with `JUDGE_REJECTED`. The job id is stored before the request goes out, so a fast callback always finds its submission.
- **The callback** (`src/services/judge/judge-result.service.ts`) checks key id, timestamp (±300 s) and HMAC on the raw bytes before parsing anything; applies a result once per job id; answers 204 to an exact duplicate and changes nothing; answers 409 to a _different_ verdict for a job that already finished (and keeps the stored one); answers 404 to a job it does not know, which is also how the late result of a job replaced by a re-judge is refused; answers 422 to a test that is not part of the version, an unknown verdict or a job that is not a `submission`. Whether a test is a sample comes from Core's own record, never from the result, and previews of hidden tests are dropped even if Judge sends them.
- **ISE** (internal system error) is never the submitter's fault: it is stored as such, shown as such, and `POST /api/v1/submissions/{id}/rejudge` (the author, or an owner or editor) queues it again under a new job id. Judge's free-text error message is not stored (it may name internal paths); only its code.
- **Who can read a submission** (decision, GRD-46): its author, and owners and editors of the Space. Everyone else gets 404. Previews are stored and sent for sample tests only.
- **Live status**: `GET /api/v1/submissions/{id}/events` is Server-Sent Events. Every connection starts with the current state, so a dropped connection loses nothing and the browser's reconnect needs no bookkeeping; the stream ends at the final state. While a dispatched job has not reported, Core asks Judge `GET /internal/jobs/{id}` about every two seconds, so "running" shows. `GET /api/v1/submissions/{id}` is the polling fallback.
- **Rate limit**: 10 submissions per minute per user, shared with re-checks, in memory per process (the same caveat as the other limits, see decisions.md).

## Testcases page and Generate (GRD-108)

The page saves everything at once. Files are uploaded first (`POST …/tests/files`, multipart or pasted text) and stored by hash; `PUT …/tests` then lists the testcases the problem should have, in order, with the `revision` the page started from (409 `TESTS_CHANGED` if someone else saved meanwhile) and either all changes apply or none. A testcase may have no expected output yet (`output_sha256` null); the publish gate's `outputs` check, and a database trigger behind it, block publishing until none is missing. `POST …/generate` runs a saved reference solution on the inputs (one Judge job per testcase, three at a time, 10 minutes at most) and returns outputs as hashes the author can accept in the next save; nothing changes in the problem until then. `GET/POST …/generate/{jobId}[/stop]` report and stop a job; finished jobs are kept 24 hours. `GET …/tests/{id}/files/{side}` returns a window of lines for previews.

## Running it locally with Judge

See the README. In short: Judge's `callback.allowed_url_prefixes` must contain `<CORE_INTERNAL_URL>/internal/judge/`, `JUDGE_KEY_ID` / `JUDGE_SECRET` must match Judge's `VERDALE_JUDGE_AUTH_INBOUND_KEYS`, `JUDGE_CALLBACK_KEYS` must hold Judge's callback key id and secret, and Core's `STORAGE_LOCAL_DIR` must be the directory Judge mounts as its storage.

## Not done on purpose

- Orphaned objects in storage are not cleaned up (M5).
- Creating a new draft version of a published problem and the verification run (M4). Progression already survives new versions (see tracks.md).
- Rate limits and abuse rules beyond the submission limit (GRD-55).
- Per-problem statistics, "solved" marks and leaderboards.
