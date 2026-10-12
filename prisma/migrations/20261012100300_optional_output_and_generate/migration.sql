-- CreateEnum
CREATE TYPE "GenerateJobStatus" AS ENUM ('running', 'completed', 'stopped', 'timed_out', 'failed');

-- CreateEnum
CREATE TYPE "GenerateRunStatus" AS ENUM ('queued', 'running', 'done', 'failed');

-- AlterTable
ALTER TABLE "test_cases" ALTER COLUMN "output_sha256" DROP NOT NULL,
ALTER COLUMN "output_size_bytes" DROP NOT NULL;

-- CreateTable
CREATE TABLE "generate_jobs" (
    "id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "language" "Language" NOT NULL,
    "source" TEXT NOT NULL,
    "status" "GenerateJobStatus" NOT NULL DEFAULT 'running',
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(300),
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "generate_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generate_runs" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "test_case_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "GenerateRunStatus" NOT NULL DEFAULT 'queued',
    "judge_job_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_dispatch_at" TIMESTAMPTZ(3),
    "verdict" "TestVerdict",
    "time_ms" INTEGER,
    "memory_kb" INTEGER,
    "stderr" VARCHAR(4096),
    "output_sha256" VARCHAR(64),
    "output_size_bytes" INTEGER,
    "same_as_current" BOOLEAN,
    "error_code" VARCHAR(64),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "generate_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generate_jobs_problem_version_id_status_idx" ON "generate_jobs"("problem_version_id", "status");

-- CreateIndex
CREATE INDEX "generate_jobs_created_at_idx" ON "generate_jobs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "generate_runs_judge_job_id_key" ON "generate_runs"("judge_job_id");

-- CreateIndex
CREATE INDEX "generate_runs_job_id_position_idx" ON "generate_runs"("job_id", "position");

-- AddForeignKey
ALTER TABLE "generate_jobs" ADD CONSTRAINT "generate_jobs_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generate_jobs" ADD CONSTRAINT "generate_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generate_runs" ADD CONSTRAINT "generate_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generate_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generate_runs" ADD CONSTRAINT "generate_runs_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "test_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A testcase may wait for its expected output (GRD-108): both columns are null
-- together, and a version cannot be published while any testcase lacks one.
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_hashes";
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_sizes";
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_hashes" CHECK (
  "input_sha256" ~ '^[a-f0-9]{64}$' AND ("output_sha256" IS NULL OR "output_sha256" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_sizes" CHECK (
  "input_size_bytes" >= 0 AND ("output_size_bytes" IS NULL OR "output_size_bytes" >= 0) AND "position" >= 1
);
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_output_pair" CHECK (("output_sha256" IS NULL) = ("output_size_bytes" IS NULL));

CREATE FUNCTION "require_outputs_when_published"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'published' AND OLD."status" IS DISTINCT FROM 'published' AND EXISTS (
    SELECT 1 FROM "test_cases" WHERE "problem_version_id" = NEW."id" AND "output_sha256" IS NULL
  ) THEN
    RAISE EXCEPTION 'version % has testcases without an expected output', NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "problem_versions_need_outputs_to_publish"
  BEFORE UPDATE ON "problem_versions"
  FOR EACH ROW EXECUTE FUNCTION "require_outputs_when_published"();

ALTER TABLE "generate_runs" ADD CONSTRAINT "generate_runs_position" CHECK ("position" >= 1);
