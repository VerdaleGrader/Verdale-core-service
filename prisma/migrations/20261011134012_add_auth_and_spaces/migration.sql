-- CreateEnum
CREATE TYPE "SpaceVisibility" AS ENUM ('public', 'private');

-- CreateEnum
CREATE TYPE "SpaceRole" AS ENUM ('owner', 'editor', 'solver');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('pending', 'accepted', 'declined', 'revoked');

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "provider_account_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(32) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "visibility" "SpaceVisibility" NOT NULL DEFAULT 'private',
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "SpaceRole" NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "invitee_id" UUID,
    "token_hash" VARCHAR(64) NOT NULL,
    "role" "SpaceRole" NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(3),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_slug_key" ON "spaces"("slug");

-- CreateIndex
CREATE INDEX "spaces_visibility_archived_at_idx" ON "spaces"("visibility", "archived_at");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_space_id_user_id_key" ON "memberships"("space_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_space_id_status_idx" ON "invites"("space_id", "status");

-- CreateIndex
CREATE INDEX "invites_invitee_id_status_idx" ON "invites"("invitee_id", "status");

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Users that exist before this migration (M1 seed data on dev branches) get
-- their personal Space and owner membership now (GRD-16). Production has no
-- users yet, so this is a no-op there. If an old username is not a valid
-- slug, the constraint below fails the migration loudly instead of leaving a
-- user without a Space.
-- ---------------------------------------------------------------------------
INSERT INTO "spaces" ("id", "created_by_id", "name", "slug", "visibility", "is_personal", "updated_at")
SELECT gen_random_uuid(), "id", "username", "username", 'private', true, CURRENT_TIMESTAMP
FROM "users";

INSERT INTO "memberships" ("id", "space_id", "user_id", "role")
SELECT gen_random_uuid(), "id", "created_by_id", 'owner' FROM "spaces" WHERE "is_personal";

-- ---------------------------------------------------------------------------
-- Rules Prisma cannot express. Application code enforces them too (clear
-- errors); these make them impossible to bypass.
-- ---------------------------------------------------------------------------

-- Case-insensitive uniqueness: identifiers are stored lower-case.
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_username_lowercase" CHECK ("username" = lower("username"));
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9_-]{2,31}$');

-- Link and username invitations never grant owner (promote after joining).
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_not_owner" CHECK ("role" <> 'owner');

-- Exactly one personal Space per user.
CREATE UNIQUE INDEX "spaces_one_personal_per_user" ON "spaces" ("created_by_id") WHERE "is_personal";

-- A personal Space is never deleted and never archived (GRD-16).
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_personal_not_archived" CHECK (NOT "is_personal" OR "archived_at" IS NULL);

CREATE FUNCTION "forbid_personal_space_delete"() RETURNS trigger AS $$
BEGIN
  IF OLD."is_personal" THEN
    RAISE EXCEPTION 'a personal Space cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "spaces_forbid_personal_delete"
  BEFORE DELETE ON "spaces"
  FOR EACH ROW EXECUTE FUNCTION "forbid_personal_space_delete"();

-- Every Space keeps at least one owner (GRD-14). Checked at commit, so a
-- transaction may create the Space and its first owner, or hand ownership
-- over, in any order.
CREATE FUNCTION "enforce_space_has_owner"() RETURNS trigger AS $$
DECLARE
  target_space uuid;
BEGIN
  IF TG_TABLE_NAME = 'spaces' THEN
    target_space := NEW."id";
  ELSE
    target_space := OLD."space_id";
  END IF;

  IF EXISTS (SELECT 1 FROM "spaces" WHERE "id" = target_space)
     AND NOT EXISTS (
       SELECT 1 FROM "memberships" WHERE "space_id" = target_space AND "role" = 'owner'
     ) THEN
    RAISE EXCEPTION 'space % must keep at least one owner', target_space USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "spaces_require_owner"
  AFTER INSERT ON "spaces"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_space_has_owner"();

CREATE CONSTRAINT TRIGGER "memberships_keep_owner"
  AFTER UPDATE OF "role" OR DELETE ON "memberships"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_space_has_owner"();
