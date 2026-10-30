-- Legacy-state fixture for the tenancy migration test (guide 05 §3): three
-- users as the pre-tenancy schema had them. Applied AFTER the three legacy
-- migrations and BEFORE the tenancy migration.
-- u1: healthy owner with TOTP and a vehicle + drive + telemetry.
-- u2: soft-deleted user with a vehicle, a place and telemetry (must be purged).
-- u3: holds a legacy `driver` VehiclePermission on u1's vehicle.

INSERT INTO "User" (id, email, name, "passwordHash", role, "totpSecret", "totpEnabled", "createdAt") VALUES
  ('u1', 'owner@legacy.test', 'Legacy Owner', '$argon2id$v=19$m=19456,t=2,p=1$legacy$legacy', 'OWNER', 'AAAAAAAAAAAAAAAA', true, '2026-01-01T00:00:00Z'),
  ('u2', 'deleted@legacy.test', 'Deleted User', '$argon2id$v=19$m=19456,t=2,p=1$legacy$legacy', 'OWNER', NULL, false, '2026-01-02T00:00:00Z'),
  ('u3', 'driver@legacy.test', 'Granted Driver', '$argon2id$v=19$m=19456,t=2,p=1$legacy$legacy', 'DRIVER', NULL, false, '2026-01-03T00:00:00Z');

UPDATE "User" SET "deletedAt" = '2026-01-10T00:00:00Z' WHERE id = 'u2';

INSERT INTO "UserSession" (id, "userId", "tokenHash", "expiresAt", "createdAt") VALUES
  ('s1', 'u1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT INTO "ProviderAccount" (id, "userId", provider, label, status) VALUES
  ('pa1', 'u1', 'demo', 'Demo u1', 'connected'),
  ('pa2', 'u2', 'demo', 'Demo u2', 'connected');

INSERT INTO "Vehicle" (id, "ownerId", "providerAccountId", provider, "providerVehicleId", "displayName", "createdAt", "updatedAt") VALUES
  ('v1', 'u1', 'pa1', 'demo', 'demo-v1', 'Owner Car', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z'),
  ('v2', 'u2', 'pa2', 'demo', 'demo-v2', 'Deleted Car', '2026-01-06T00:00:00Z', '2026-01-06T00:00:00Z');

INSERT INTO "Place" (id, "userId", name, lat, lon) VALUES
  ('pl1', 'u1', 'Home u1', 35.0, -90.0),
  ('pl2', 'u2', 'Home u2', 36.0, -91.0);

INSERT INTO "VehiclePermission" (id, "ownerId", "vehicleId", "userId", level, "createdAt") VALUES
  ('vp1', 'u1', 'v1', 'u3', 'driver', '2026-01-07T00:00:00Z');

INSERT INTO "Drive" (id, "vehicleId", "startAt", "endAt", "distanceKm", "durationSec", "avgSpeedKmh", "maxSpeedKmh", "energyKwh", "efficiencyWhPerKm") VALUES
  ('d1', 'v1', '2026-10-15T08:00:00Z', '2026-10-15T08:30:00Z', 12.5, 1800, 25.0, 60.0, 2.1, 168.0),
  ('d2', 'v2', '2026-10-16T09:00:00Z', '2026-10-16T09:20:00Z', 5.0, 1200, 15.0, 50.0, 0.9, 180.0);

INSERT INTO "DriveRoutePoint" (id, "driveId", seq, ts, lat, lon, "speedKmh") VALUES
  ('rp1', 'd1', 1, '2026-10-15T08:00:00Z', 35.0, -90.0, 0),
  ('rp2', 'd1', 2, '2026-10-15T08:30:00Z', 35.2, -90.1, 40);

SELECT voltlank_ensure_partition('2026-10-15T00:00:00Z');

INSERT INTO public.telemetry_reading (vehicle_id, ts, data) VALUES
  ('v1', '2026-10-15T08:00:00Z', '{"b":80,"lt":35.0,"ln":-90.0}'),
  ('v1', '2026-10-15T08:15:00Z', '{"b":79,"lt":35.1,"ln":-90.05}'),
  ('v2', '2026-10-16T09:00:00Z', '{"b":50,"lt":36.0,"ln":-91.0}');
