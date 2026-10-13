-- GRD-122: which version of the Terms and the Privacy Policy each user accepted.
-- Only the user, the document, its version (effective date) and the time.

-- CreateEnum
CREATE TYPE "LegalDocument" AS ENUM ('terms', 'privacy');

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "user_id" UUID NOT NULL,
    "document" "LegalDocument" NOT NULL,
    "version" VARCHAR(10) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("user_id","document","version")
);

-- The version is an ISO date, nothing else (it is compared as text).
ALTER TABLE "legal_acceptances"
    ADD CONSTRAINT "legal_acceptances_version_format" CHECK ("version" ~ '^\d{4}-\d{2}-\d{2}$');

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
