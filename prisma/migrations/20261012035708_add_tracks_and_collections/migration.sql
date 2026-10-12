-- CreateEnum
CREATE TYPE "StatementMode" AS ENUM ('markdown', 'pdf');

-- CreateEnum
CREATE TYPE "TrackVisibility" AS ENUM ('space', 'members');

-- AlterTable
ALTER TABLE "invites" ADD COLUMN     "track_id" UUID;

-- AlterTable
ALTER TABLE "problem_versions" ADD COLUMN     "statement_mode" "StatementMode" NOT NULL DEFAULT 'markdown',
ADD COLUMN     "statement_pdf_pages" INTEGER,
ADD COLUMN     "statement_pdf_sha256" VARCHAR(64),
ADD COLUMN     "statement_pdf_size_bytes" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_url" VARCHAR(2048);

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL,
    "visibility" "TrackVisibility" NOT NULL DEFAULT 'space',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_collections" (
    "track_id" UUID NOT NULL,
    "collection_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "track_collections_pkey" PRIMARY KEY ("track_id","collection_id")
);

-- CreateTable
CREATE TABLE "collection_problems" (
    "collection_id" UUID NOT NULL,
    "problem_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "collection_problems_pkey" PRIMARY KEY ("collection_id","problem_id")
);

-- CreateTable
CREATE TABLE "track_members" (
    "track_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_members_pkey" PRIMARY KEY ("track_id","user_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "target_id" UUID,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracks_space_id_position_idx" ON "tracks"("space_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_space_id_slug_key" ON "tracks"("space_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "collections_space_id_slug_key" ON "collections"("space_id", "slug");

-- CreateIndex
CREATE INDEX "track_collections_track_id_position_idx" ON "track_collections"("track_id", "position");

-- CreateIndex
CREATE INDEX "track_collections_collection_id_idx" ON "track_collections"("collection_id");

-- CreateIndex
CREATE INDEX "collection_problems_collection_id_position_idx" ON "collection_problems"("collection_id", "position");

-- CreateIndex
CREATE INDEX "collection_problems_problem_id_idx" ON "collection_problems"("problem_id");

-- CreateIndex
CREATE INDEX "track_members_user_id_idx" ON "track_members"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_space_id_created_at_idx" ON "audit_logs"("space_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_target_id_created_at_idx" ON "audit_logs"("target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invites_track_id_status_idx" ON "invites"("track_id", "status");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_collections" ADD CONSTRAINT "track_collections_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_collections" ADD CONSTRAINT "track_collections_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_problems" ADD CONSTRAINT "collection_problems_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_problems" ADD CONSTRAINT "collection_problems_problem_id_fkey" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_members" ADD CONSTRAINT "track_members_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_members" ADD CONSTRAINT "track_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Rules the schema language cannot express.
-- ---------------------------------------------------------------------------

ALTER TABLE "tracks" ADD CONSTRAINT "tracks_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_position_positive" CHECK ("position" >= 1);
ALTER TABLE "collections" ADD CONSTRAINT "collections_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
ALTER TABLE "track_collections" ADD CONSTRAINT "track_collections_position_positive" CHECK ("position" >= 1);
ALTER TABLE "collection_problems" ADD CONSTRAINT "collection_problems_position_positive" CHECK ("position" >= 1);

-- A Track invitation never gives more than a solver seat (GRD-80).
ALTER TABLE "invites" ADD CONSTRAINT "invites_track_is_solver" CHECK ("track_id" IS NULL OR "role" = 'solver');

-- A PDF statement carries its file (GRD-73). The file columns are all set or all empty, and the
-- PDF mode needs them; a Markdown statement may keep an uploaded PDF so switching back loses nothing.
ALTER TABLE "problem_versions" ADD CONSTRAINT "problem_versions_statement_pdf" CHECK (
  (
    "statement_pdf_sha256" IS NULL AND "statement_pdf_size_bytes" IS NULL AND "statement_pdf_pages" IS NULL
    AND "statement_mode" = 'markdown'
  ) OR (
    "statement_pdf_sha256" ~ '^[a-f0-9]{64}$'
    AND "statement_pdf_size_bytes" BETWEEN 1 AND 10485760
    AND "statement_pdf_pages" BETWEEN 1 AND 10
  )
);

-- A Track and its Collections, and a Collection and its problems, always belong to one Space.
CREATE FUNCTION "track_collections_same_space"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "space_id" FROM "tracks" WHERE "id" = NEW."track_id")
     IS DISTINCT FROM (SELECT "space_id" FROM "collections" WHERE "id" = NEW."collection_id") THEN
    RAISE EXCEPTION 'a Track and its Collections must be in the same Space' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "track_collections_same_space_check"
  BEFORE INSERT OR UPDATE ON "track_collections"
  FOR EACH ROW EXECUTE FUNCTION "track_collections_same_space"();

CREATE FUNCTION "collection_problems_same_space"() RETURNS trigger AS $$
BEGIN
  IF (SELECT "space_id" FROM "collections" WHERE "id" = NEW."collection_id")
     IS DISTINCT FROM (SELECT "space_id" FROM "problems" WHERE "id" = NEW."problem_id") THEN
    RAISE EXCEPTION 'a Collection and its problems must be in the same Space' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "collection_problems_same_space_check"
  BEFORE INSERT OR UPDATE ON "collection_problems"
  FOR EACH ROW EXECUTE FUNCTION "collection_problems_same_space"();

-- Only members of the Space can be members of its Tracks.
CREATE FUNCTION "track_members_need_space_membership"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "memberships" m
    JOIN "tracks" t ON t."space_id" = m."space_id"
    WHERE t."id" = NEW."track_id" AND m."user_id" = NEW."user_id"
  ) THEN
    RAISE EXCEPTION 'only a member of the Space can join one of its Tracks' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "track_members_need_space_membership_check"
  BEFORE INSERT ON "track_members"
  FOR EACH ROW EXECUTE FUNCTION "track_members_need_space_membership"();

-- The frozen-version rule now also covers the statement mode and PDF columns.
CREATE OR REPLACE FUNCTION "forbid_published_version_edit"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'published' AND (
       NEW."problem_id" IS DISTINCT FROM OLD."problem_id"
    OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."statement" IS DISTINCT FROM OLD."statement"
    OR NEW."statement_mode" IS DISTINCT FROM OLD."statement_mode"
    OR NEW."statement_pdf_sha256" IS DISTINCT FROM OLD."statement_pdf_sha256"
    OR NEW."statement_pdf_size_bytes" IS DISTINCT FROM OLD."statement_pdf_size_bytes"
    OR NEW."statement_pdf_pages" IS DISTINCT FROM OLD."statement_pdf_pages"
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

-- ---------------------------------------------------------------------------
-- Existing data: every Space gets a starter Track "General" (GRD-78), and the
-- problems that already exist go into a Collection "General" inside it, so
-- nothing a solver could see before disappears when Tracks become the way in.
-- ---------------------------------------------------------------------------

INSERT INTO "tracks" ("id", "space_id", "name", "slug", "description", "position", "visibility", "updated_at")
SELECT gen_random_uuid(), s."id", 'General', 'general', '', 1, 'space', CURRENT_TIMESTAMP
FROM "spaces" s;

INSERT INTO "collections" ("id", "space_id", "name", "slug", "description", "updated_at")
SELECT gen_random_uuid(), s."id", 'General', 'general', '', CURRENT_TIMESTAMP
FROM "spaces" s
WHERE EXISTS (SELECT 1 FROM "problems" p WHERE p."space_id" = s."id");

INSERT INTO "track_collections" ("track_id", "collection_id", "position")
SELECT t."id", c."id", 1
FROM "collections" c
JOIN "tracks" t ON t."space_id" = c."space_id" AND t."slug" = 'general';

INSERT INTO "collection_problems" ("collection_id", "problem_id", "position")
SELECT c."id", p."id", row_number() OVER (PARTITION BY p."space_id" ORDER BY p."created_at", p."id")
FROM "problems" p
JOIN "collections" c ON c."space_id" = p."space_id" AND c."slug" = 'general';
