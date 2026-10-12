-- GRD-96: a Space has exactly one owner. The earlier rule (GRD-14) allowed
-- several and required at least one; the "keep at least one" triggers stay.
--
-- Spaces that already have several owners keep the one who created the Space
-- (or, failing that, who joined first); the others become administrators,
-- which is the closest role to what they could do before.
WITH ranked AS (
  SELECT m."id",
         row_number() OVER (
           PARTITION BY m."space_id"
           ORDER BY (m."user_id" = s."created_by_id") DESC, m."joined_at" ASC, m."id" ASC
         ) AS rank
  FROM "memberships" m
  JOIN "spaces" s ON s."id" = m."space_id"
  WHERE m."role" = 'owner'
)
UPDATE "memberships" SET "role" = 'administrator'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);

CREATE UNIQUE INDEX "memberships_one_owner_per_space" ON "memberships" ("space_id") WHERE "role" = 'owner';
