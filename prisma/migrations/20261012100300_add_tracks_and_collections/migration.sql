-- CreateEnum
CREATE TYPE "TrackPrivacy" AS ENUM ('space', 'members');

-- AlterTable
ALTER TABLE "invites" ADD COLUMN     "track_id" UUID;

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "privacy" "TrackPrivacy" NOT NULL DEFAULT 'space',
    "position" INTEGER NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
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
    "added_by_id" UUID NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_members_pkey" PRIMARY KEY ("track_id","user_id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "track_id" UUID,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(48) NOT NULL,
    "target_user_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracks_space_id_position_idx" ON "tracks"("space_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_space_id_slug_key" ON "tracks"("space_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "collections_space_id_slug_key" ON "collections"("space_id", "slug");

-- CreateIndex
CREATE INDEX "track_collections_collection_id_idx" ON "track_collections"("collection_id");

-- CreateIndex
CREATE INDEX "collection_problems_problem_id_idx" ON "collection_problems"("problem_id");

-- CreateIndex
CREATE INDEX "track_members_user_id_idx" ON "track_members"("user_id");

-- CreateIndex
CREATE INDEX "audit_events_space_id_created_at_idx" ON "audit_events"("space_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invites_track_id_status_idx" ON "invites"("track_id", "status");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "track_members" ADD CONSTRAINT "track_members_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules Prisma cannot express ------------------------------------------------

-- A Track invitation always makes the person a solver of the Space.
ALTER TABLE "invites" ADD CONSTRAINT "invites_track_invite_is_solver" CHECK ("track_id" IS NULL OR "role" = 'solver');

ALTER TABLE "tracks" ADD CONSTRAINT "tracks_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
ALTER TABLE "collections" ADD CONSTRAINT "collections_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{1,63}$');
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_position_positive" CHECK ("position" >= 1);
ALTER TABLE "track_collections" ADD CONSTRAINT "track_collections_position_positive" CHECK ("position" >= 1);
ALTER TABLE "collection_problems" ADD CONSTRAINT "collection_problems_position_positive" CHECK ("position" >= 1);

-- Existing Spaces: one "General" Track holding one "General" Collection with all of
-- the Space's problems, so nothing that solvers could see yesterday disappears
-- when the Track rule (GRD-81) starts to apply. New Spaces get an empty "General"
-- Track from the application.
INSERT INTO "tracks" ("id", "space_id", "created_by_id", "name", "slug", "position", "updated_at")
SELECT gen_random_uuid(), s."id", s."created_by_id", 'General', 'general', 1, CURRENT_TIMESTAMP
FROM "spaces" s;

INSERT INTO "collections" ("id", "space_id", "created_by_id", "name", "slug", "updated_at")
SELECT gen_random_uuid(), s."id", s."created_by_id", 'General', 'general', CURRENT_TIMESTAMP
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
