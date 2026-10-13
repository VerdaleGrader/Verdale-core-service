-- GRD-113: "my best submission of this problem" without scanning the whole history.

-- CreateIndex
CREATE INDEX "submissions_user_id_problem_id_status_tests_passed_created__idx" ON "submissions"("user_id", "problem_id", "status", "tests_passed" DESC, "created_at" ASC);
