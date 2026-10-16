-- GRD-58: platform administrators, suspensions, reports of problems and the audit log of what the administrators did.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'dismissed', 'actioned');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('abuse', 'copyright', 'cheating', 'other');

-- AlterTable
ALTER TABLE "problems" ADD COLUMN     "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspension_reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspension_reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "platform_role" "PlatformRole" NOT NULL DEFAULT 'user',
ADD COLUMN     "submissions_suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "submissions_suspension_reason" VARCHAR(500),
ADD COLUMN     "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspension_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "problem_reports" (
    "id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "category" "ReportCategory" NOT NULL DEFAULT 'other',
    "reason" VARCHAR(1000) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "problem_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "target_id" UUID,
    "target_label" VARCHAR(128) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "problem_reports_status_created_at_idx" ON "problem_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "problem_reports_problem_id_created_at_idx" ON "problem_reports"("problem_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_type_target_id_created_at_idx" ON "platform_audit_logs"("target_type", "target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_actor_id_created_at_idx" ON "platform_audit_logs"("actor_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

