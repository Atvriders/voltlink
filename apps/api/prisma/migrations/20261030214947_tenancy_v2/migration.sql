-- Tenancy v2: organizations, memberships, grants, invitations, API keys,
-- challenges, throttles, recovery codes, OAuth state, command idempotency and
-- data tasks. Hand-ordered per guide 05 §3: new tables and nullable columns
-- first, data backfill, then NOT NULL and the old columns are dropped last
-- (Prisma's generated order would destroy ownerId/userId before the backfill
-- can read them).

-- 1. Enums
CREATE TYPE "OrgKind" AS ENUM ('PERSONAL', 'TEAM', 'OPERATOR');
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'FLEET_MANAGER', 'DRIVER', 'VIEWER', 'STATUS_MANAGER', 'SUPPORT');
CREATE TYPE "AccessScope" AS ENUM ('ALL', 'GRANTED');
CREATE TYPE "GrantLevel" AS ENUM ('VIEWER', 'DRIVER', 'MANAGER');

-- 2. New tables
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "kind" "OrgKind" NOT NULL DEFAULT 'PERSONAL',
    "name" TEXT NOT NULL,
    "telemetryRetentionDays" INTEGER,
    "locationRetentionDays" INTEGER,
    "demoDegraded" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL,
    "vehicleScope" "AccessScope" NOT NULL DEFAULT 'ALL',
    "providerScope" "AccessScope" NOT NULL DEFAULT 'ALL',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invitedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VehicleGrant" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "level" "GrantLevel" NOT NULL DEFAULT 'VIEWER',
    "allowHighRisk" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VehicleGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole",
    "vehicleId" TEXT,
    "grantLevel" "GrantLevel",
    "allowHighRisk" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "deliveredByEmail" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderAccountGrant" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "canCommand" BOOLEAN NOT NULL DEFAULT true,
    "canManage" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ProviderAccountGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL,
    "handleHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "challenge" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AuthChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthThrottle" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AuthThrottle_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthState" (
    "stateHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "verifierSealed" TEXT NOT NULL,
    "reconnectAccountId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("stateHash")
);

CREATE TABLE "CommandIdempotency" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "CommandIdempotency_pkey" PRIMARY KEY ("scope","key")
);

CREATE TABLE "DataTask" (
    "name" TEXT NOT NULL,
    "appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DataTask_pkey" PRIMARY KEY ("name")
);

-- 3. Honour past deletion requests (Z-DELETE): purge soft-deleted users' data
-- before organizations are created for the remaining users.
DELETE FROM telemetry.telemetry_reading WHERE vehicle_id IN
  (SELECT v.id FROM "Vehicle" v JOIN "User" u ON u.id = v."ownerId" WHERE u."deletedAt" IS NOT NULL);
DELETE FROM "Place" WHERE "userId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "Geofence" WHERE "userId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "PrivacyZone" WHERE "userId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "RateRule" WHERE "userId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "FleetGroup" WHERE "ownerId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "Department" WHERE "ownerId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "CostCenter" WHERE "ownerId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "Driver" WHERE "ownerId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "VehicleAssignment" WHERE "ownerId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL);
DELETE FROM "User" WHERE "deletedAt" IS NOT NULL;
DELETE FROM "VehiclePermission" WHERE "userId" NOT IN (SELECT id FROM "User");

-- 4. New columns (nullable or defaulted) on existing tables.
ALTER TABLE "User" ADD COLUMN     "deletionRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "suspendedAt" TIMESTAMPTZ(3),
ADD COLUMN     "totpEnabledAt" TIMESTAMPTZ(3),
ADD COLUMN     "totpLastStep" BIGINT,
ADD COLUMN     "totpPendingExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "totpPendingSealed" TEXT,
ADD COLUMN     "totpSecretSealed" TEXT,
ADD COLUMN     "webauthnUserId" TEXT;

ALTER TABLE "UserSession" ADD COLUMN     "stepUpAt" TIMESTAMPTZ(3),
ADD COLUMN     "stepUpMethod" TEXT;

ALTER TABLE "PasskeyCredential" ADD COLUMN     "backedUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deviceType" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMPTZ(3);

ALTER TABLE "AuditLog" ADD COLUMN     "actorKind" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "apiKeyId" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "ProviderAccount" ADD COLUMN     "commandsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "connectedById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Vehicle" ADD COLUMN     "addedById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "VehicleLocation" ADD COLUMN     "privacyZoneId" TEXT,
ALTER COLUMN "lat" DROP NOT NULL,
ALTER COLUMN "lon" DROP NOT NULL;

ALTER TABLE "Place" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Geofence" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "PrivacyZone" ADD COLUMN     "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "redactedThrough" TIMESTAMPTZ(3);

ALTER TABLE "Drive" ADD COLUMN     "endPrivacyZoneId" TEXT,
ADD COLUMN     "startPrivacyZoneId" TEXT;

ALTER TABLE "ChargingSession" ADD COLUMN     "privacyZoneId" TEXT;

ALTER TABLE "RateRule" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Automation" ADD COLUMN     "approvedActionsHash" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "highRiskApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "VehicleCommand" ADD COLUMN     "actorKind" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "apiKeyId" TEXT,
ADD COLUMN     "authzDecision" JSONB,
ADD COLUMN     "automationId" TEXT,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "sourceIp" TEXT,
ALTER COLUMN "idempotencyKey" DROP NOT NULL;

ALTER TABLE "ApiKey" ADD COLUMN     "lastUsedIp" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Incident" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "FleetGroup" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Department" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "CostCenter" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "Driver" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "VehicleAssignment" ADD COLUMN     "organizationId" TEXT;

ALTER TABLE "DataRetentionJob" ADD COLUMN     "organizationId" TEXT;

DROP INDEX "VehicleCommand_idempotencyKey_key";

-- 5. Organizations, memberships and the instance admin (earliest remaining
-- user). The first user's organization is the OPERATOR organization.
INSERT INTO "Organization" (id, kind, name, "createdById", "createdAt")
SELECT 'org_' || u.id,
       (CASE WHEN u.id = (SELECT id FROM "User" ORDER BY "createdAt", id LIMIT 1) THEN 'OPERATOR' ELSE 'PERSONAL' END)::"OrgKind",
       left(u.name, 60), u.id, now()
  FROM "User" u;

INSERT INTO "Membership" (id, "organizationId", "userId", role, "vehicleScope", "providerScope", status, "createdAt")
SELECT 'mem_' || u.id, 'org_' || u.id, u.id, 'OWNER'::"OrgRole", 'ALL'::"AccessScope", 'ALL'::"AccessScope", 'ACTIVE', now()
  FROM "User" u;

UPDATE "User" SET "isInstanceAdmin" = true WHERE id = (SELECT id FROM "User" ORDER BY "createdAt", id LIMIT 1);

INSERT INTO "AppSetting" (key, value, "updatedAt")
SELECT s.k, s.v, now() FROM (VALUES
   ('instance.bootstrappedAt', now()::text),
   ('instance.operatorOrgId', (SELECT 'org_' || id FROM "User" ORDER BY "createdAt", id LIMIT 1)),
   ('instance.registrationMode', 'invite')) AS s(k, v)
 WHERE EXISTS (SELECT 1 FROM "User")
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();

DELETE FROM "AppSetting" WHERE key IN ('telemetryRetentionDays', 'locationRetentionDays');

-- 6. Backfill ownership.
UPDATE "Vehicle" SET "organizationId" = 'org_' || "ownerId", "addedById" = "ownerId";
UPDATE "ProviderAccount" SET "organizationId" = 'org_' || "userId", "connectedById" = "userId";
UPDATE "Place" SET "organizationId" = 'org_' || "userId", "createdById" = "userId";
UPDATE "Geofence" SET "organizationId" = 'org_' || "userId", "createdById" = "userId";
UPDATE "PrivacyZone" SET "organizationId" = 'org_' || "userId", "createdById" = "userId";
UPDATE "RateRule" SET "organizationId" = 'org_' || "userId", "createdById" = "userId";
UPDATE "Automation" SET "organizationId" = 'org_' || "userId", "createdById" = "userId";
UPDATE "FleetGroup" SET "organizationId" = 'org_' || "ownerId", "createdById" = "ownerId";
UPDATE "Department" SET "organizationId" = 'org_' || "ownerId", "createdById" = "ownerId";
UPDATE "CostCenter" SET "organizationId" = 'org_' || "ownerId", "createdById" = "ownerId";
UPDATE "Driver" SET "organizationId" = 'org_' || "ownerId", "createdById" = "ownerId";
UPDATE "VehicleAssignment" SET "organizationId" = 'org_' || "ownerId";
UPDATE "VehicleCommand" c SET "organizationId" = v."organizationId" FROM "Vehicle" v WHERE v.id = c."vehicleId";
DELETE FROM "ApiKey";

-- Orphan rows whose user was hard-deleted before this migration: the new
-- organization FKs require an existing organization, so drop them.
DELETE FROM "Place" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "Place"."organizationId");
DELETE FROM "Geofence" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "Geofence"."organizationId");
DELETE FROM "PrivacyZone" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "PrivacyZone"."organizationId");
DELETE FROM "RateRule" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "RateRule"."organizationId");
DELETE FROM "FleetGroup" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "FleetGroup"."organizationId");
DELETE FROM "Department" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "Department"."organizationId");
DELETE FROM "CostCenter" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "CostCenter"."organizationId");
DELETE FROM "Driver" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "Driver"."organizationId");
DELETE FROM "VehicleAssignment" WHERE NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "VehicleAssignment"."organizationId");

-- 7. Convert per-vehicle permissions into grants. High-risk access is never
-- carried over automatically (must be re-granted with step-up).
INSERT INTO "VehicleGrant" (id, "vehicleId", "userId", level, "allowHighRisk", "grantedById", "createdAt")
SELECT p.id, p."vehicleId", p."userId", (CASE p.level WHEN 'driver' THEN 'DRIVER' ELSE 'VIEWER' END)::"GrantLevel",
       false, p."ownerId", p."createdAt"
  FROM "VehiclePermission" p WHERE EXISTS (SELECT 1 FROM "User" u WHERE u.id = p."userId");
DROP TABLE "VehiclePermission";

-- 8. Reset sessions and legacy TOTP enrolments, and backfill webauthn user ids.
UPDATE "UserSession" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;
INSERT INTO "AuditLog" (id, action, "entityType", "entityId", "actorKind", "createdAt")
SELECT 'mig_totp_' || id, 'auth.mfa.totp_reset_by_upgrade', 'user', id, 'system', now() FROM "User" WHERE "totpEnabled";
INSERT INTO "AppNotification" (id, "userId", event, severity, title, body, channel, "createdAt")
SELECT 'mig_totp_' || id, id, 'security', 'warning', 'Set up two-factor authentication again',
       'A security upgrade reset your authenticator enrollment. Open Settings, Security to enrol again.', 'in_app', now()
  FROM "User" WHERE "totpEnabled";
UPDATE "User" SET "totpEnabled" = false;
UPDATE "User" SET "webauthnUserId" = rtrim(translate(encode(convert_to(id, 'UTF8'), 'base64'), '+/', '-_'), '=');
DROP TABLE "PasskeyChallenge";

-- 9. NOT NULL after the backfill.
ALTER TABLE "ProviderAccount" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Vehicle" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Place" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Geofence" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "PrivacyZone" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "RateRule" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Automation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "VehicleCommand" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ApiKey" ALTER COLUMN "organizationId" SET NOT NULL,
ALTER COLUMN "expiresAt" SET NOT NULL;
ALTER TABLE "FleetGroup" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Department" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "CostCenter" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Driver" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "VehicleAssignment" ALTER COLUMN "organizationId" SET NOT NULL;

-- 10. Drop the old ownership columns (their FKs first).
ALTER TABLE "ProviderAccount" DROP CONSTRAINT "ProviderAccount_userId_fkey";
ALTER TABLE "ProviderAccount" DROP COLUMN "userId";
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_ownerId_fkey";
ALTER TABLE "Vehicle" DROP COLUMN "ownerId";
ALTER TABLE "Place" DROP COLUMN "userId";
ALTER TABLE "Geofence" DROP COLUMN "userId";
ALTER TABLE "PrivacyZone" DROP COLUMN "userId";
ALTER TABLE "RateRule" DROP COLUMN "userId";
ALTER TABLE "FleetGroup" DROP COLUMN "ownerId";
ALTER TABLE "Department" DROP COLUMN "ownerId";
ALTER TABLE "CostCenter" DROP COLUMN "ownerId";
ALTER TABLE "Driver" DROP COLUMN "ownerId";
ALTER TABLE "VehicleAssignment" DROP COLUMN "ownerId";
ALTER TABLE "User" DROP COLUMN "deletedAt",
DROP COLUMN "role",
DROP COLUMN "totpSecret";

-- 11. Indexes and foreign keys.
CREATE UNIQUE INDEX "AuthChallenge_handleHash_key" ON "AuthChallenge"("handleHash");
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");
CREATE UNIQUE INDEX "RecoveryCode_userId_codeHash_key" ON "RecoveryCode"("userId", "codeHash");
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");
CREATE INDEX "VehicleGrant_userId_idx" ON "VehicleGrant"("userId");
CREATE UNIQUE INDEX "VehicleGrant_vehicleId_userId_key" ON "VehicleGrant"("vehicleId", "userId");
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");
CREATE UNIQUE INDEX "ProviderAccountGrant_membershipId_providerAccountId_key" ON "ProviderAccountGrant"("membershipId", "providerAccountId");
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");
CREATE INDEX "CommandIdempotency_expiresAt_idx" ON "CommandIdempotency"("expiresAt");
CREATE UNIQUE INDEX "User_webauthnUserId_key" ON "User"("webauthnUserId");
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");
CREATE INDEX "ProviderAccount_organizationId_idx" ON "ProviderAccount"("organizationId");
CREATE INDEX "Vehicle_organizationId_idx" ON "Vehicle"("organizationId");
CREATE INDEX "Place_organizationId_idx" ON "Place"("organizationId");
CREATE INDEX "Geofence_organizationId_idx" ON "Geofence"("organizationId");
CREATE INDEX "PrivacyZone_organizationId_idx" ON "PrivacyZone"("organizationId");
CREATE INDEX "RateRule_organizationId_idx" ON "RateRule"("organizationId");
CREATE INDEX "Automation_organizationId_idx" ON "Automation"("organizationId");
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");
CREATE INDEX "FleetGroup_organizationId_idx" ON "FleetGroup"("organizationId");
CREATE INDEX "Department_organizationId_idx" ON "Department"("organizationId");
CREATE INDEX "CostCenter_organizationId_idx" ON "CostCenter"("organizationId");
CREATE INDEX "Driver_organizationId_idx" ON "Driver"("organizationId");
CREATE INDEX "VehicleAssignment_organizationId_idx" ON "VehicleAssignment"("organizationId");

ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleGrant" ADD CONSTRAINT "VehicleGrant_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleGrant" ADD CONSTRAINT "VehicleGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAccountGrant" ADD CONSTRAINT "ProviderAccountGrant_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAccountGrant" ADD CONSTRAINT "ProviderAccountGrant_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderAccount" ADD CONSTRAINT "ProviderAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Place" ADD CONSTRAINT "Place_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Geofence" ADD CONSTRAINT "Geofence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrivacyZone" ADD CONSTRAINT "PrivacyZone_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RateRule" ADD CONSTRAINT "RateRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetGroup" ADD CONSTRAINT "FleetGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VehicleAssignment" ADD CONSTRAINT "VehicleAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
