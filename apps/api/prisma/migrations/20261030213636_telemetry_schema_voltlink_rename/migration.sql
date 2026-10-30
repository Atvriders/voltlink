-- Migration A: rename migration. Moves the partitioned telemetry table and its
-- partitions into a `telemetry` schema (which Prisma never diffs), normalizes
-- any pre-existing partition bounds to UTC months, replaces the voltlank-named
-- partition function with voltlink_ensure_partition (UTC months,
-- advisory-locked, concurrency-safe), and drops the old function and the dead
-- voltlank_migrations table.
--
-- The old function's input parameter is named `ts`; PostgreSQL cannot change an
-- input parameter's name, so this migration creates the new function instead of
-- using ALTER FUNCTION ... RENAME (whose CREATE OR REPLACE would fail).

-- Prisma resets only "public" when it re-uses a shadow DB or runs `migrate reset`, which can leave a stale EMPTY
-- telemetry schema (seen locally: P3006 "relation already exists in schema telemetry"). A real deployment never
-- reaches this branch: only this migration creates telemetry.telemetry_reading.
DO $$ BEGIN
  IF to_regclass('public.telemetry_reading') IS NOT NULL AND to_regclass('telemetry.telemetry_reading') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM telemetry.telemetry_reading LIMIT 1) THEN
      RAISE EXCEPTION 'telemetry.telemetry_reading already exists with rows; drop schema telemetry manually (dev only)';
    END IF;
    DROP SCHEMA telemetry CASCADE;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS telemetry;
ALTER TABLE public.telemetry_reading SET SCHEMA telemetry;
DO $$ DECLARE r record; BEGIN   -- partitions are separate relations: move each one
  FOR r IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE i.inhparent = 'telemetry.telemetry_reading'::regclass AND n.nspname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA telemetry', r.relname);
  END LOOP;
END $$;
-- One parent index: existing telemetry_YYYY_MM_idx get attached (verified); future partitions inherit it.
CREATE INDEX IF NOT EXISTS telemetry_reading_vehicle_ts_idx ON telemetry.telemetry_reading (vehicle_id, ts);

-- The old partition function took month bounds from the session TimeZone, so on
-- servers not set to UTC its partitions cover the wrong instants and would
-- overlap the UTC partitions the new function creates (SQLSTATE 42P17). Rebuild
-- any existing partition onto exact UTC month bounds before continuing.
-- make_timestamptz(...) interprets the date/time fields in the given zone, so no
-- interval arithmetic on timestamptz is involved.
DO $$ DECLARE
  r        record;
  legacy   text;
  start_ts timestamptz;
  end_ts   timestamptz;
  y        int;
  m        int;
BEGIN
  FOR r IN SELECT c.relname AS part
           FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE i.inhparent = 'telemetry.telemetry_reading'::regclass AND n.nspname = 'telemetry' LOOP
    y := substring(r.part from 'telemetry_(\d{4})_\d{2}')::int;
    m := substring(r.part from 'telemetry_\d{4}_(\d{2})')::int;
    IF y IS NULL OR m IS NULL THEN CONTINUE; END IF;
    start_ts := make_timestamptz(y, m, 1, 0, 0, 0, 'UTC');
    end_ts   := make_timestamptz(CASE WHEN m = 12 THEN y + 1 ELSE y END,
                                CASE WHEN m = 12 THEN 1 ELSE m + 1 END, 1, 0, 0, 0, 'UTC');
    legacy := r.part || '_legacy';
    EXECUTE format('ALTER TABLE telemetry.telemetry_reading DETACH PARTITION telemetry.%I', r.part);
    EXECUTE format('ALTER TABLE telemetry.%I RENAME TO %I', r.part, legacy);
    EXECUTE format('CREATE TABLE telemetry.%I PARTITION OF telemetry.telemetry_reading FOR VALUES FROM (%L) TO (%L)',
                   r.part, start_ts, end_ts);
    EXECUTE format('INSERT INTO telemetry.telemetry_reading (id, vehicle_id, ts, data) OVERRIDING SYSTEM VALUE SELECT id, vehicle_id, ts, data FROM telemetry.%I', legacy);
    EXECUTE format('DROP TABLE telemetry.%I', legacy);
  END LOOP;
  PERFORM setval(pg_get_serial_sequence('telemetry.telemetry_reading', 'id'),
                 GREATEST((SELECT COALESCE(max(id), 1) FROM telemetry.telemetry_reading), 1), true);
END $$;

CREATE OR REPLACE FUNCTION public.voltlink_ensure_partition(p_ts timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  start_ts timestamptz := date_trunc('month', p_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';  -- UTC months only
  -- Calendar arithmetic happens on a plain timestamp (no time zone), so the end
  -- instant is exact regardless of the session TimeZone.
  end_ts   timestamptz := (date_trunc('month', p_ts AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
  part     text        := 'telemetry_' || to_char(start_ts AT TIME ZONE 'UTC', 'YYYY_MM');
BEGIN
  IF to_regclass(format('telemetry.%I', part)) IS NOT NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('voltlink:telemetry-partition:' || part)); -- concurrent first readings
  BEGIN
    IF to_regclass(format('telemetry.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE telemetry.%I PARTITION OF telemetry.telemetry_reading FOR VALUES FROM (%L) TO (%L)',
                     part, start_ts, end_ts);
    END IF;
  EXCEPTION WHEN duplicate_table THEN
    -- A concurrent creator won the race; this transaction's snapshot may predate
    -- its commit, so treat "already exists" as success.
    NULL;
  END;
END $$;
DROP FUNCTION IF EXISTS public.voltlank_ensure_partition(timestamptz);
DROP TABLE IF EXISTS public.voltlank_migrations;
