# Handoff: large inputs in "Generate with AI" (GRD-124 follow-up)

Status: written 2026-10-16. Nothing in this document is implemented yet.

## The problem

"Largest values" (`max` category) must be able to produce inputs with 100,000 to 1,000,000 lines, but the current feature asks a model to write each input out in full. That does not scale, and the prompt contradicts the category.

## What is true today (checked in the code)

- `buildPrompt` in `src/services/problem/ai-test.service.ts` tells the model "Keep each input under 60 KB", and the `max` category text says "at the largest the constraints allow (but keep one input under 60 KB)". These two instructions fight each other.
- `AI_TEST_LIMITS.max_input_bytes` (`src/constants/limits.ts`) is 64 KiB. It is our own cap. The platform limit is `TEST_LIMITS.max_file_bytes`, 8 MiB per file and 128 MiB per problem.
- `HttpAiClient` (`src/libs/ai-provider.ts`) sends `MAX_OUTPUT_TOKENS = 16384`, plain `fetch`, no streaming, 90 s timeout.
- `GET .../ai-tests/{jobId}` returns the full `input_text` of every item once the job is `completed`. With big files that response would be huge.
- The Judge `generate` job captures at most `AI_TEST_LIMITS.stdout_bytes` (512 KiB) of output per test and `total_bytes` (12 MiB) per job. These bound the expected outputs, not the inputs.

## What we learned from the author (2026-10-16)

100,000 lines of a typical input is only about 300 KB. So file size is not the obstacle: an 8 MiB cap is far more than needed.

## The real bottleneck: tokens the model must write

A line of 1 to 3 digits plus a newline is roughly 1 to 2 tokens, so 100,000 lines is roughly 100,000 to 200,000 output tokens. This is the reviewer's estimate, not measured with a tokenizer. Against that:

- our `max_tokens` of 16,384 covers roughly 8,000 to 16,000 lines;
- model output limits are usually tens of thousands of tokens up to the low hundreds of thousands, and long generations should be streamed, which Core does not do;
- every large input costs the author real quota on their own key.

Not yet verified: nobody has called Claude or Gemini with an input this large through this feature. Measure before deciding between the options below.

## Options

### A. Quick fix (small, do first)

1. Raise `AI_TEST_LIMITS.max_input_bytes` to `TEST_LIMITS.max_file_bytes` (8 MiB).
2. Replace the "under 60 KB" wording in both `buildPrompt` and `CATEGORY_TEXT.max` with "write each input out completely, never truncate".
3. Return only the first lines (about 10) of `input_text` in the job response, plus `total_lines`, and let the review step fetch the rest through the existing saved-file slice endpoint if needed. The review step's "Edit input" then works only for small inputs.
4. Optionally raise `MAX_OUTPUT_TOKENS` moderately (for example 32,000). Streaming is needed beyond that.

Result: inputs up to roughly 10,000 lines should work. 100,000 lines will not.

### B. Generator script (new feature, own card)

The model writes a short program (for example Python) that prints one large input. Judge runs it in the sandbox, and the printed output becomes the input file, which then goes through `normalizeTestFile` and the existing solution run.

- Token cost is a few hundred, not 100,000, and files up to 8 MiB are reachable.
- New work: a generator step before the solution step (a Judge `generate` job whose "solution" is the generator and has no input, with the right limits and capture); showing the script to the author in the review step (it is model-written code run on our servers); deciding who may run it (`problem.update` roles only, as today); storing the script with the item for reproducibility; time, memory and output limits for the generator.
- Open questions: one script per input or one script producing several? Python only? Should the author be able to edit and rerun the script? Does the generator get a seed so a run is reproducible?

## Recommendation

Do A now. Open a separate card for B and measure first (a real call with a 100,000-line request through each provider, and the real token count) so the card starts from facts.

## Files to read first

- `src/services/problem/ai-test.service.ts`: `buildPrompt`, `CATEGORY_TEXT`, `stageInputs`, `view`, `run`.
- `src/libs/ai-provider.ts`: `MAX_OUTPUT_TOKENS`, request builders.
- `src/constants/limits.ts`: `AI_TEST_LIMITS`, `TEST_LIMITS`.
- `src/services/problem/generate.service.ts`: how a `generate` Judge job is built (model for option B).
- `contracts/core-public.openapi.yaml`: `AiTestItem` (`input_text`) if its shape changes; bump `contracts/VERSION` and the changelog, then re-pin the frontend with `npm run contracts:sync`.
- Frontend: `features/problems/components/ai-testcase-dialog.tsx` (Review step, "Edit input") and `features/problems/ai-tests.ts`.

## Done when (option A)

- A 300 KB (100,000 short lines) input saved by the model, or a fake provider returning one, is accepted and reaches the solution run.
- The prompt no longer contains the 60 KB wording and `max` no longer contradicts it.
- The job response carries a bounded preview, and the review step still lists, keeps and adds large drafts without freezing the page.
- Tests cover an oversized input (over 8 MiB is skipped with a clear reason) and the preview truncation. `npm run check` passes in Core and the frontend.
