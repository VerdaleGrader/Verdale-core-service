-- Publish gate and versions (GRD-50 to GRD-54, GRD-116, GRD-117).

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('queued', 'running', 'passed', 'failed', 'error');

-- CreateEnum
CREATE TYPE "ProblemHistoryType" AS ENUM ('minor_update', 'major_draft_created', 'major_draft_discarded', 'state_change');

-- AlterTable: `version_number` is the Major; `minor` is bumped by each Minor update of a published version.
ALTER TABLE "problem_versions" ADD COLUMN "minor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "verification_runs" (
    "id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'queued',
    -- SHA-256 over the tests, reference solutions, limits and languages the run was started with.
    "content_hash" VARCHAR(64) NOT NULL,
    "judge_job_id" UUID,
    "verdict" "Verdict",
    "reason" VARCHAR(500),
    "results" JSONB NOT NULL DEFAULT '[]',
    "tests_total" INTEGER NOT NULL,
    "tests_passed" INTEGER,
    "max_time_ms" INTEGER,
    "max_memory_kb" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_dispatch_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_history" (
    "id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "problem_version_id" UUID,
    "type" "ProblemHistoryType" NOT NULL,
    "actor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" VARCHAR(32) NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "state_from" "ProblemVersionStatus",
    "state_to" "ProblemVersionStatus",

    CONSTRAINT "problem_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verification_runs_judge_job_id_key" ON "verification_runs"("judge_job_id");

-- CreateIndex
CREATE INDEX "verification_runs_problem_version_id_created_at_idx" ON "verification_runs"("problem_version_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "verification_runs_status_next_dispatch_at_idx" ON "verification_runs"("status", "next_dispatch_at");

-- CreateIndex
CREATE INDEX "verification_runs_status_deadline_at_idx" ON "verification_runs"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "problem_history_problem_id_at_idx" ON "problem_history"("problem_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_history" ADD CONSTRAINT "problem_history_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a discarded draft keeps its history entries.
ALTER TABLE "problem_history" ADD CONSTRAINT "problem_history_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_history" ADD CONSTRAINT "problem_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Rules Prisma cannot express (services enforce them first with clear errors).
-- ---------------------------------------------------------------------------

ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_minor_not_negative" CHECK ("minor" >= 0);
ALTER TABLE "verification_runs" ADD CONSTRAINT "verification_runs_hash" CHECK ("content_hash" ~ '^[a-f0-9]{64}$');

-- A problem has at most one version in progress (draft, verifying or verified).
DROP INDEX "problem_versions_one_draft_per_problem";
CREATE UNIQUE INDEX "problem_versions_one_draft_per_problem" ON "problem_versions" ("problem_id") WHERE "status" IN ('draft', 'verifying', 'verified');

-- A version has at most one verification run in progress.
CREATE UNIQUE INDEX "verification_runs_one_open_per_version" ON "verification_runs" ("problem_version_id") WHERE "status" IN ('queued', 'running');

-- A published version can still change its Minor fields (title, statement,
-- statement mode and PDF) and its `minor` number, through a Minor update, and
-- nothing else. Its Major fields (limits, languages, version number) are
-- frozen; its tests and reference solutions stay frozen by their own triggers.
CREATE OR REPLACE FUNCTION "forbid_published_version_edit"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'published' THEN
    IF NEW."problem_id" IS DISTINCT FROM OLD."problem_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."time_limit_ms" IS DISTINCT FROM OLD."time_limit_ms"
    OR NEW."memory_limit_kb" IS DISTINCT FROM OLD."memory_limit_kb"
    OR NEW."allowed_languages" IS DISTINCT FROM OLD."allowed_languages"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
    THEN
      RAISE EXCEPTION 'a published problem version cannot change its Major fields' USING ERRCODE = '23514';
    END IF;
    IF NEW."minor" < OLD."minor" THEN
      RAISE EXCEPTION 'the Minor number of a published problem version cannot go back' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A new version always has a higher Major than every version the problem has (no duplicates, no going back).
CREATE FUNCTION "problem_version_major_increases"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "problem_versions"
    WHERE "problem_id" = NEW."problem_id" AND "version_number" >= NEW."version_number"
  ) THEN
    RAISE EXCEPTION 'a new problem version needs a higher Major than the existing ones' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "problem_versions_major_increases_check"
  BEFORE INSERT ON "problem_versions"
  FOR EACH ROW EXECUTE FUNCTION "problem_version_major_increases"();

-- The open version only moves forward: publishing a Major makes a higher Major current, never a lower one.
CREATE FUNCTION "problem_current_version_moves_forward"() RETURNS trigger AS $$
BEGIN
  IF OLD."current_version_id" IS NOT NULL
     AND NEW."current_version_id" IS NOT NULL
     AND NEW."current_version_id" <> OLD."current_version_id"
     AND (SELECT "version_number" FROM "problem_versions" WHERE "id" = NEW."current_version_id")
       <= (SELECT "version_number" FROM "problem_versions" WHERE "id" = OLD."current_version_id")
  THEN
    RAISE EXCEPTION 'the open version of a problem cannot go back to an older Major' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "problems_current_version_moves_forward_check"
  BEFORE UPDATE OF "current_version_id" ON "problems"
  FOR EACH ROW EXECUTE FUNCTION "problem_current_version_moves_forward"();
