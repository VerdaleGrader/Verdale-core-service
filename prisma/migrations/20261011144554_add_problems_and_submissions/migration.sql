-- CreateEnum
CREATE TYPE "Language" AS ENUM ('c', 'cpp', 'python');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "ProblemVersionStatus" AS ENUM ('draft', 'published');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('queued', 'running', 'completed');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'ISE');

-- CreateEnum
CREATE TYPE "TestVerdict" AS ENUM ('AC', 'WA', 'TLE', 'MLE', 'RE', 'OLE', 'ISE', 'SKIPPED');

-- CreateTable
CREATE TABLE "problems" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "status" "ProblemStatus" NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "problems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "problem_versions" (
    "id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "ProblemVersionStatus" NOT NULL DEFAULT 'draft',
    "title" VARCHAR(200) NOT NULL,
    "statement" TEXT NOT NULL DEFAULT '',
    "time_limit_ms" INTEGER NOT NULL,
    "memory_limit_kb" INTEGER NOT NULL,
    "allowed_languages" "Language"[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "problem_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "input_sha256" VARCHAR(64) NOT NULL,
    "output_sha256" VARCHAR(64) NOT NULL,
    "input_size_bytes" INTEGER NOT NULL,
    "output_size_bytes" INTEGER NOT NULL,
    "is_sample" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_solutions" (
    "id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "language" "Language" NOT NULL,
    "source" TEXT NOT NULL,
    "source_bytes" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reference_solutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "language" "Language" NOT NULL,
    "source" TEXT NOT NULL,
    "source_bytes" INTEGER NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'queued',
    "verdict" "Verdict",
    "time_ms" INTEGER,
    "memory_kb" INTEGER,
    "tests_passed" INTEGER,
    "tests_total" INTEGER,
    "compile_message" VARCHAR(8192),
    "error_code" VARCHAR(64),
    "judge_version" VARCHAR(64),
    "judge_job_id" UUID,
    "dispatch_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_dispatch_at" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "judged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_test_results" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "test_case_id" UUID,
    "is_sample" BOOLEAN NOT NULL,
    "verdict" "TestVerdict" NOT NULL,
    "time_ms" INTEGER NOT NULL,
    "memory_kb" INTEGER NOT NULL,
    "exit_code" INTEGER,
    "signal" INTEGER,
    "stdout_preview" VARCHAR(1024),
    "checker_message" VARCHAR(256),

    CONSTRAINT "submission_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "problems_current_version_id_key" ON "problems"("current_version_id");

-- CreateIndex
CREATE INDEX "problems_space_id_status_updated_at_idx" ON "problems"("space_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "problems_created_by_id_status_idx" ON "problems"("created_by_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "problems_space_id_slug_key" ON "problems"("space_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "problem_versions_problem_id_version_number_key" ON "problem_versions"("problem_id", "version_number");

-- CreateIndex
CREATE INDEX "test_cases_problem_version_id_position_idx" ON "test_cases"("problem_version_id", "position");

-- CreateIndex
CREATE INDEX "reference_solutions_problem_version_id_idx" ON "reference_solutions"("problem_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_judge_job_id_key" ON "submissions"("judge_job_id");

-- CreateIndex
CREATE INDEX "submissions_user_id_problem_id_created_at_idx" ON "submissions"("user_id", "problem_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "submissions_problem_id_created_at_idx" ON "submissions"("problem_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "submissions_status_next_dispatch_at_idx" ON "submissions"("status", "next_dispatch_at");

-- CreateIndex
CREATE UNIQUE INDEX "submission_test_results_submission_id_position_key" ON "submission_test_results"("submission_id", "position");

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problems" ADD CONSTRAINT "problems_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "problem_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_test_results" ADD CONSTRAINT "submission_test_results_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Rules Prisma cannot express. Services enforce them too (clear errors);
-- these make them impossible to bypass.
-- ---------------------------------------------------------------------------

-- Problem slugs: the URL part, unique per Space. "new", "edit" and the other
-- reserved words are refused in the service (src/constants/identifiers.ts).
ALTER TABLE "problems" ADD CONSTRAINT "problems_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
ALTER TABLE "problems" ADD CONSTRAINT "problems_archived_matches_status" CHECK (("status" = 'archived') = ("archived_at" IS NOT NULL));

-- Limits are the Judge contract's hard bounds (time 100 ms to 20 s, memory
-- 16 MB to 2 GB). The narrower range the product allows is in the service.
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_limits" CHECK (
  "time_limit_ms" BETWEEN 100 AND 20000 AND "memory_limit_kb" BETWEEN 16384 AND 2097152
);
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_has_language" CHECK (cardinality("allowed_languages") >= 1);
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_version_positive" CHECK ("version_number" >= 1);
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_published_at" CHECK (("status" = 'published') = ("published_at" IS NOT NULL));

-- A problem has at most one draft version at a time.
CREATE UNIQUE INDEX "problem_versions_one_draft_per_problem" ON "problem_versions" ("problem_id") WHERE "status" = 'draft';

ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_hashes" CHECK (
  "input_sha256" ~ '^[a-f0-9]{64}$' AND "output_sha256" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_sizes" CHECK ("input_size_bytes" >= 0 AND "output_size_bytes" >= 0 AND "position" >= 1);

-- At most one primary reference solution per version; sources fit Judge's limit.
CREATE UNIQUE INDEX "reference_solutions_one_primary_per_version" ON "reference_solutions" ("problem_version_id") WHERE "is_primary";
ALTER TABLE "reference_solutions" ADD CONSTRAINT "reference_solutions_size" CHECK ("source_bytes" BETWEEN 1 AND 65536);

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_size" CHECK ("source_bytes" BETWEEN 1 AND 65536);
-- A verdict exists exactly when judging has finished.
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_verdict_matches_status" CHECK (("status" = 'completed') = ("verdict" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- A published version never changes (GRD-21). The service refuses first with a
-- clear 409; the database refuses everything that gets past it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "forbid_published_version_edit"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'published' AND (
       NEW."problem_id" IS DISTINCT FROM OLD."problem_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."statement" IS DISTINCT FROM OLD."statement"
    OR NEW."time_limit_ms" IS DISTINCT FROM OLD."time_limit_ms"
    OR NEW."memory_limit_kb" IS DISTINCT FROM OLD."memory_limit_kb"
    OR NEW."allowed_languages" IS DISTINCT FROM OLD."allowed_languages"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  ) THEN
    RAISE EXCEPTION 'a published problem version cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "problem_versions_immutable_when_published"
  BEFORE UPDATE ON "problem_versions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_published_version_edit"();

-- A published version cannot be deleted either (this also stops a cascade from deleting its problem).
CREATE FUNCTION "forbid_published_version_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'published' THEN
    RAISE EXCEPTION 'a published problem version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "problem_versions_no_delete_when_published"
  BEFORE DELETE ON "problem_versions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_published_version_delete"();

-- Tests and reference solutions belong to a version: frozen with it.
CREATE FUNCTION "forbid_published_version_children_change"() RETURNS trigger AS $$
DECLARE
  target uuid;
  version_status "ProblemVersionStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    target := NEW."problem_version_id";
  ELSE
    target := OLD."problem_version_id";
  END IF;
  SELECT "status" INTO version_status FROM "problem_versions" WHERE "id" = target;
  IF version_status = 'published' THEN
    RAISE EXCEPTION 'the tests and solutions of a published problem version cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_cases_frozen_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "test_cases"
  FOR EACH ROW EXECUTE FUNCTION "forbid_published_version_children_change"();

CREATE TRIGGER "reference_solutions_frozen_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "reference_solutions"
  FOR EACH ROW EXECUTE FUNCTION "forbid_published_version_children_change"();
