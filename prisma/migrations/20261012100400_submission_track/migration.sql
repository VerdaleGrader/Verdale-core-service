-- GRD-93: a submission remembers the Track it was made from.

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "track_id" UUID;

-- CreateIndex
CREATE INDEX "submissions_track_id_created_at_idx" ON "submissions"("track_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
