-- GRD-68: the profile picture URL the sign-in provider gave us (refreshed at every sign-in).
ALTER TABLE "users" ADD COLUMN "avatar_url" VARCHAR(512);
