-- AI testcase generation, bring your own key (GRD-124).
-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('gemini', 'claude');

-- CreateEnum
CREATE TYPE "AiTestJobStatus" AS ENUM ('generating', 'computing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "AiTestItemStatus" AS ENUM ('pending', 'ok', 'skipped');

-- CreateTable
CREATE TABLE "user_ai_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "key_ciphertext" BYTEA NOT NULL,
    "key_nonce" BYTEA NOT NULL,
    "key_tag" BYTEA NOT NULL,
    "key_id" VARCHAR(64) NOT NULL,
    "last4" VARCHAR(4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_test_jobs" (
    "id" UUID NOT NULL,
    "problem_version_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "requested_count" INTEGER NOT NULL,
    "categories" TEXT[],
    "include_solution" BOOLEAN NOT NULL DEFAULT false,
    "judge_job_id" UUID,
    "status" "AiTestJobStatus" NOT NULL DEFAULT 'generating',
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(300),
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_test_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_test_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "AiTestItemStatus" NOT NULL DEFAULT 'pending',
    "input_sha256" VARCHAR(64),
    "input_size_bytes" INTEGER,
    "output_sha256" VARCHAR(64),
    "output_size_bytes" INTEGER,
    "skip_reason" VARCHAR(200),

    CONSTRAINT "ai_test_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_ai_credentials_user_id_provider_key" ON "user_ai_credentials"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ai_test_jobs_judge_job_id_key" ON "ai_test_jobs"("judge_job_id");

-- CreateIndex
CREATE INDEX "ai_test_jobs_problem_version_id_status_idx" ON "ai_test_jobs"("problem_version_id", "status");

-- CreateIndex
CREATE INDEX "ai_test_jobs_created_at_idx" ON "ai_test_jobs"("created_at");

-- CreateIndex
CREATE INDEX "ai_test_items_job_id_position_idx" ON "ai_test_items"("job_id", "position");

-- AddForeignKey
ALTER TABLE "user_ai_credentials" ADD CONSTRAINT "user_ai_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_test_jobs" ADD CONSTRAINT "ai_test_jobs_problem_version_id_fkey" FOREIGN KEY ("problem_version_id") REFERENCES "problem_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_test_jobs" ADD CONSTRAINT "ai_test_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_test_items" ADD CONSTRAINT "ai_test_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_test_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

