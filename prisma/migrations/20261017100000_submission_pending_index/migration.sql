-- GRD-55: "how many submissions of this person are still queued or running" without scanning their history.

-- CreateIndex
CREATE INDEX "submissions_user_id_status_idx" ON "submissions"("user_id", "status");
