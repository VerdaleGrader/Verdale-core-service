-- GRD-73: a problem version can use an uploaded PDF as its statement.
CREATE TYPE "statement_mode" AS ENUM ('markdown', 'pdf');

ALTER TABLE "problem_versions"
  ADD COLUMN "statement_mode" "statement_mode" NOT NULL DEFAULT 'markdown',
  ADD COLUMN "statement_pdf_sha256" VARCHAR(64),
  ADD COLUMN "statement_pdf_size_bytes" INTEGER,
  ADD COLUMN "statement_pdf_pages" INTEGER,
  ADD CONSTRAINT "problem_versions_statement_pdf_all_or_none" CHECK (
    ("statement_pdf_sha256" IS NULL AND "statement_pdf_size_bytes" IS NULL AND "statement_pdf_pages" IS NULL)
    OR ("statement_pdf_sha256" IS NOT NULL AND "statement_pdf_size_bytes" IS NOT NULL AND "statement_pdf_pages" IS NOT NULL)
  ),
  ADD CONSTRAINT "problem_versions_pdf_mode_has_pdf" CHECK (
    "statement_mode" <> 'pdf' OR "statement_pdf_sha256" IS NOT NULL OR "status" = 'draft'
  );
