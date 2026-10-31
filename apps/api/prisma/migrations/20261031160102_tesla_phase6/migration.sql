-- AlterTable
ALTER TABLE "ProviderAccount" ADD COLUMN     "fleetApiBaseUrl" TEXT,
ADD COLUMN     "lastErrorCode" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "tokenExpiresAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "accessType" TEXT,
ADD COLUMN     "capabilityDetails" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "hidePrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pendingCommandUntil" TIMESTAMPTZ(3),
ADD COLUMN     "userActiveUntil" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "VehicleCommandSecret" (
    "commandId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VehicleCommandSecret_pkey" PRIMARY KEY ("commandId")
);

-- CreateTable
CREATE TABLE "ProviderUsageDaily" (
    "accountId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProviderUsageDaily_pkey" PRIMARY KEY ("accountId","day","category")
);

