-- GRD-93: what a program printed on each test, kept for staff only.

-- CreateTable
CREATE TABLE "submission_test_outputs" (
    "result_id" UUID NOT NULL,
    "stdout" TEXT,
    "stdout_size_bytes" BIGINT,
    "stderr" TEXT,
    "stderr_size_bytes" BIGINT,

    CONSTRAINT "submission_test_outputs_pkey" PRIMARY KEY ("result_id")
);

-- AddForeignKey
ALTER TABLE "submission_test_outputs" ADD CONSTRAINT "submission_test_outputs_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "submission_test_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;
