-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "track_id" UUID;

-- CreateTable
CREATE TABLE "submission_test_outputs" (
    "result_id" UUID NOT NULL,
    "stdout" TEXT,
    "stdout_size_bytes" BIGINT,
    "stderr" TEXT,
    "stderr_size_bytes" BIGINT,

    CONSTRAINT "submission_test_outputs_pkey" PRIMARY KEY ("result_id")
);

-- CreateIndex
CREATE INDEX "submissions_track_id_created_at_idx" ON "submissions"("track_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_test_outputs" ADD CONSTRAINT "submission_test_outputs_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "submission_test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

