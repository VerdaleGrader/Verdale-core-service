-- The publish gate (GRD-50): a draft is verified on Judge before it can be
-- published. A new enum value cannot be used in the transaction that adds it,
-- so the values are added here and used by the next migration.
ALTER TYPE "ProblemVersionStatus" ADD VALUE IF NOT EXISTS 'verifying';
ALTER TYPE "ProblemVersionStatus" ADD VALUE IF NOT EXISTS 'verified';
