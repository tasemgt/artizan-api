-- Reconciles DUMMY_CATEGORIES' per-category fee (local-only until now) onto
-- the real categories table, as part of moving the User side's matching
-- flow off local dummy categories entirely.
ALTER TABLE "categories" ADD COLUMN "platformFeeNgn" INTEGER NOT NULL DEFAULT 500;
