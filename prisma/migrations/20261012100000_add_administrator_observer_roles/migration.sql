-- GRD-96, GRD-97: two new Space roles. Postgres cannot use a new enum value in
-- the transaction that adds it, so the rules that use them are in the next migration.
ALTER TYPE "SpaceRole" ADD VALUE 'administrator';
ALTER TYPE "SpaceRole" ADD VALUE 'observer';
