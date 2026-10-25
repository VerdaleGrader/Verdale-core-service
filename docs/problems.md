# Problems, tests and submissions (Milestone 3)

How a problem is written, frozen, solved and judged. API details live in `contracts/core-public.openapi.yaml`; who may do what is in the permission table of [auth.md](auth.md).

## The shape of the data

```
space ─< problem ─< problem_version ─< test_case          (files in the private bucket, by SHA-256)
                          │        └─< reference_solution
                          └──────────< submission ─< submission_test_result
```

- **problem**: belongs to a Space; slug unique inside the Space (`/spaces/<space>/problems/<slug>`); status `draft` (never published), `published`, or `archived`; `current_version_id` is the version solvers see.
- **problem_version**: title, Markdown statement, time limit, memory limit, allowed languages, status `draft`, `verifying`, `verified` or `published`, and its number `vMajor.Minor` (`version_number` is the Major, `minor` the Minor; the first publish is v1.0). A problem has at most one version in progress (draft, verifying or verified; partial unique index) next to its published ones. Older Majors stay as immutable rows; `current_version_id` is the open one.
- **verification_run**: one run of the primary reference solution against every test on Judge (see "The publish gate"). **problem_history**: Minor updates, Major drafts and every state change, with who and when.
- **test_case**: position (judging order), SHA-256 and size of the input and output, `is_sample`. The files themselves are in the private bucket at `tests/<sha256>`, the same key Judge reads.
- **reference_solution**: language, source, `is_primary` (at most one per version).
- **submission**: who, which exact version, language, source (kept in Postgres, at most 64 KiB), `status` (`queued`, `running`, `completed`), `verdict` (set exactly when completed), time and memory (maximum over the tests that ran), the current Judge job id. **submission_test_result**: one row per reported test; previews exist for sample tests only.

### A published version's Major fields never change

The service refuses first (409 `VERSION_PUBLISHED`, `MAJOR_FIELD_LOCKED`, or `PROBLEM_ARCHIVED`); a trigger in the database refuses everything that gets past it: changing the **Major fields** of a published version (time and memory limit, allowed languages, version number, status, `published_at`), lowering its `minor`, adding, changing or deleting its tests and solutions, and deleting it (which also stops a cascade from deleting its problem). Its **Minor fields** (title, statement, statement mode and PDF) and its `minor` number can change, and only a Minor update does that. Two more triggers keep the numbers honest: a new version needs a higher Major than every version the problem has, and the open version (`current_version_id`) can only move to a higher Major. `src/services/problem/publish-gate.test.ts` and `problem.test.ts` test the layers. A submission points at the exact version (Major) it was sent to, so a later Major can never change an old result.

## The publish gate (GRD-50 to GRD-52)

States of a version, in one table with the permission of each move (`src/services/problem/transitions.ts`, unit-tested):

```
draft ──verify──> verifying ──all AC──> verified ──publish──> published ──archive──> archived
  ^                   │                    │
  └── failed/error ───┘                    │
  ^                                        │
  └──── tests, solutions, limits or languages changed ────┘
```

Publish is for owners, administrators and editors (`problem.publish`); observers only read. Every move is written to `problem_history` (who, when, from, to).

**Verify** (`POST …/verify`, 202; poll `GET …/verify`): the cheap checks (statement, languages, limits, tests, hidden tests, outputs, sample, solution) must be ok, else 409 `VERIFY_BLOCKED` with a detail per check; 409 `VERIFY_IN_PROGRESS` while a run is open. A `verification_run` is created (`queued`), the version becomes `verifying`, and one Judge job of kind `verify` is sent (the primary reference solution and **every** test, hidden ones included) built by the same code and limits as a submission job (`src/services/judge/job-builder.ts`). The hand-over uses the dispatcher's loop: retry with backoff while Judge is down, and a **deadline** (5 to 30 minutes, from the number of tests and the time limit) after which the run is closed as `error` ("Judge did not answer in time") and the version goes back to `draft`, so nothing sticks in `verifying`. The result arrives at the same signed callback, routed by job id, applied once (a duplicate is acknowledged): it passes only if every test is AC; otherwise `failed` with a reason like "Test 4 is WA" or the compile error; a Judge system error is `error`. Per-test verdict, time and memory and the slowest/peak figures are stored. Passed: version `verified`; else `draft`.

**The run is bound to a content hash** (`content-hash.ts`): SHA-256 over the ordered test input/output hashes and sample flags, the reference solutions, the limits and the allowed languages. Editing any of them on a `verified` version (test endpoints, solutions, PATCH limits or languages, the testcases page save, generate accepted through it) puts the version back to `draft` and `valid` becomes false; editing is refused with 409 `VERIFY_IN_PROGRESS` while verifying. Title and statement are not part of the hash.

**Publish rules** (`publish-checks.ts`): statement (or PDF), languages, `limits` within range, `tests`, `outputs`, at least one sample, `hidden_tests` (non-sample tests >= `PUBLISH_MIN_HIDDEN_TESTS`, default 1; sent as `constraints.publish.min_hidden_tests`), a primary solution, and `verified` (the latest passing run still matches the hash). A failed check is a 409 `PUBLISH_BLOCKED` with one detail per check and its message.

## Versions, Minor and Major updates (GRD-116, GRD-117, GRD-54)

The fields of a version are in two groups defined once in `src/constants/version-fields.ts` and sent as `constraints.version_fields`: **Major** = time limit, memory limit, allowed languages, tests (input/output, order, Visible to solvers) and reference solutions; **Minor** = title, statement, statement mode (and its PDF). Any new field must be added to a group.

`POST …/updates` (owner, administrator, editor): Core decides the type from the fields that really change compared with the open version (`version-classifier.ts`, a pure function); the client never picks it, and a value equal to the current one is not a change. One changed Major field makes the whole update Major, with any Minor fields riding along; `force_major: true` makes it Major always, is recorded as `forced` in the history and is never remembered.

- **Minor**: edits the open version in place, effective at once, no draft, no verification; `minor` + 1; one history entry with a change per field (who, when, field, old, new; text cut at 2000 characters). The basic rules run first (non-empty statement unless PDF mode, the PDF must already be uploaded) and a failure changes nothing. `expected_version` is an optimistic lock: a mismatch is 409 `VERSION_CONFLICT` with the current label in `details`. If a Major draft is open, each changed Minor field is also copied into it, but only where the draft still has the open version's old value.
- **Major**: 409 `DRAFT_EXISTS` if a draft is open, else a draft of Major + 1 (Minor 0) is created with everything copied (test rows, solutions, statement, PDF, limits, languages) and the submitted fields applied; history `major_draft_created`. `POST …/draft` is the same copy with no changes (forced implied); `DELETE …/draft` discards it (409 `NO_DRAFT`, `VERIFY_IN_PROGRESS`). The draft is edited with the usual endpoints, verified and published; publishing makes it `current_version_id` (v2.1 -> v3.0 is a new row, the old one stays published and immutable).
- While a draft exists solvers, the problem list, tracks, collections, progress and "submit" all use `current_version_id`, the open version; the editor GET returns the draft as `version` and the open one as `open_version`. Submissions stay bound to the Major they were sent to; `outdated` is true when a newer Major is open; nothing is re-judged.
- `GET …/history` (owner, administrator, editor, observer; solvers and visitors get 403/404) lists updates and state changes.
- Limitation: the PDF statement of a published version cannot be replaced by a Minor update (the contract has no file field there); upload it into a Major draft.

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
4. Trailing blank lines are kept (an input may end with one) and a non-empty file ends with an LF. Trailing spaces inside lines are kept (an input may need them); Judge's line checker ignores both when comparing outputs. An empty file, or one with only newlines, becomes empty.

The SHA-256 and the size are of the normalised content, so the same test saved with different line endings is stored once. The raw upload is capped at the file limit before normalising.

Storing order: validate, write the objects (skipping any that already exist: content-addressed), then insert the row under a lock on the problem. A failure between the two leaves an orphan object, which is harmless; removing a test keeps its objects because another test may share them. Cleaning orphans is a later job (M5).

## Storage (GRD-23)

`src/libs/storage` hides the provider behind `FileStorage` (`put`, `get`, `head`, `delete`, streams). Implementations: Cloudflare R2 over the S3 API (`@aws-sdk/client-s3`), a local directory, and memory (tests). `RetryingFileStorage` gives every provider the same behaviour: a per-call timeout, retries with exponential backoff for "unavailable" errors only, and a 503 for the caller when it gives up. Not-found and refused requests are answered at once. Two buckets: **private** for test files (Judge has a read-only token) and **public** for statement pictures (random names, content type read from the bytes). In development, picture URLs point at `GET /api/v1/assets/<name>`; in production set `PUBLIC_ASSET_BASE_URL` to the public bucket's domain.

The integration test against a real bucket (`src/libs/storage/storage.test.ts`) runs when `R2_TEST_ENDPOINT`, `R2_TEST_ACCESS_KEY_ID`, `R2_TEST_SECRET_ACCESS_KEY` and `R2_TEST_BUCKET` are set (point them at the staging bucket); it writes under a random prefix and removes what it wrote. Without them it is skipped.

## Publishing

`POST …/publish` makes the verified version the published one: see "The publish gate" above. The first publish gives v1.0; publishing a Major draft makes it the open version. Archiving closes a published problem to submissions but keeps it readable; a never-published draft is deleted instead.

## Reference solutions (GRD-26)

Every endpoint goes through `problem.view_private` or `problem.update`: the staff only (owners, administrators, editors, and observers for reading), in every Space type, and also in an archived Space for reading. Nothing a solver can call touches them. The test suite checks the solver-facing responses for a planted marker string.

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
- **ISE** (internal system error) is never the submitter's fault: it is stored as such, shown as such, and `POST /api/v1/submissions/{id}/rejudge` (the author, or an owner, administrator or editor; observers cannot) queues it again under a new job id. Judge's free-text error message is not stored (it may name internal paths); only its code.
- **Who can read a submission** (decision, GRD-46): its author, and the Space's staff (owners, administrators, editors, observers). Everyone else gets 404. Previews are stored and sent for sample tests only.
- **Live status**: `GET /api/v1/submissions/{id}/events` is Server-Sent Events. Every connection starts with the current state, so a dropped connection loses nothing and the browser's reconnect needs no bookkeeping; the stream ends at the final state. While a dispatched job has not reported, Core asks Judge `GET /internal/jobs/{id}` about every two seconds, so "running" shows. `GET /api/v1/submissions/{id}` is the polling fallback.
- **Rate limit**: 10 submissions per minute per user, shared with re-checks, in memory per process (the same caveat as the other limits, see decisions.md).

## Space-wide submissions for staff (GRD-93)

Owners, administrators, editors and observers (`submission.view_all`) get one list of every submission of a Space (filters, sorting, paging) and rollups by member, Track and problem, in `src/services/submission/submission-review.service.ts`; solvers never reach them (403, 404 for outsiders). A submission remembers the Track it was made from, see [tracks.md](tracks.md). "Members" of a Track in the rollups are the solvers who can see it, counted the same way as progress. Core asks Judge to capture the start of each test's stdout (64 KiB) and stderr (8 KiB), hidden tests included, and stores it apart from the results (`submission_test_outputs`); `GET /submissions/{id}/tests/{position}` serves the input, expected output, output and stderr of one test as windows of lines, only to people who may read hidden tests. Verdict statistics ignore ISE.

## Testcases page and Generate (GRD-108)

The page saves everything at once. Files are uploaded first (`POST …/tests/files`, multipart or pasted text) and stored by hash; `PUT …/tests` then lists the testcases the problem should have, in order, with the `revision` the page started from (409 `TESTS_CHANGED` if someone else saved meanwhile) and either all changes apply or none. A testcase may have no expected output yet (`output_sha256` null); the publish gate's `outputs` check, and a database trigger behind it, block publishing until none is missing. `POST …/generate` runs a saved reference solution on the inputs (one Judge job per testcase, three at a time, 10 minutes at most, one running job per problem) and returns outputs as hashes the author can accept in the next save; nothing changes in the problem until then. `GET/POST …/generate/{jobId}[/stop]` report and stop a job; finished jobs are kept 24 hours. `GET …/tests/{id}/files/{side}` returns a window of lines for previews.

## Running it locally with Judge

See the README. In short: Judge's `callback.allowed_url_prefixes` must contain `<CORE_INTERNAL_URL>/internal/judge/`, `JUDGE_KEY_ID` / `JUDGE_SECRET` must match Judge's `VERDALE_JUDGE_AUTH_INBOUND_KEYS`, `JUDGE_CALLBACK_KEYS` must hold Judge's callback key id and secret, and Core's `STORAGE_LOCAL_DIR` must be the directory Judge mounts as its storage.

## Not done on purpose

- Orphaned objects in storage are not cleaned up (M5).
- Re-judging old submissions against a new Major: submissions keep their result and are shown as outdated (GRD-54). Progression survives new versions (see tracks.md).
- Rate limits and abuse rules beyond the submission limit (GRD-55).
- Per-problem statistics, "solved" marks and leaderboards.
