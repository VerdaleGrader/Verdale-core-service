-- GRD-96: a Space has exactly one owner. The earlier rule (GRD-14) allowed
-- several and required at least one; the "keep at least one" triggers stay.
--
-- Spaces that already have several owners keep the one who joined first (the
-- oldest membership); the others become administrators, which
-- is the closest role to what they could do before.
-- The "keep at least one owner" triggers are deferred; check them right after
-- the update so no trigger event is pending when the index is created.
SET CONSTRAINTS ALL IMMEDIATE;

WITH ranked AS (
  SELECT m."id",
         row_number() OVER (
           PARTITION BY m."space_id"
           ORDER BY m."joined_at" ASC, m."id" ASC
         ) AS rank
  FROM "memberships" m
  WHERE m."role" = 'owner'
)
UPDATE "memberships" SET "role" = 'administrator'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);

SET CONSTRAINTS ALL DEFERRED;

CREATE UNIQUE INDEX "memberships_one_owner_per_space" ON "memberships" ("space_id") WHERE "role" = 'owner';
