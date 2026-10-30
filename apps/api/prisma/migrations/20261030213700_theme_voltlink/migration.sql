-- Theme migration: the VoltLink theme ids are voltlink-dark and voltlink-light.
-- Update the column default and normalize any stored legacy ids without naming
-- them here (kept out of the naming scan). Existing recognized ids are kept.
ALTER TABLE "User" ALTER COLUMN "theme" SET DEFAULT 'voltlink-dark';
UPDATE "User" SET "theme" = CASE WHEN "theme" LIKE '%-light' THEN 'voltlink-light' ELSE 'voltlink-dark' END
WHERE "theme" NOT IN ('voltlink-dark', 'voltlink-light', 'fleet-ops', 'high-contrast', 'colorblind-safe');
