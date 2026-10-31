-- AlterTable
ALTER TABLE "VehicleCommand" ADD COLUMN     "confirmation" TEXT,
ADD COLUMN     "responseCategory" TEXT;

-- CreateTable
CREATE TABLE "VehiclePollState" (
    "vehicleId" TEXT NOT NULL,
    "connectivity" TEXT NOT NULL DEFAULT 'unknown',
    "activity" JSONB,
    "lastVehicleDataAt" TIMESTAMPTZ(3),
    "lastActivityAt" TIMESTAMPTZ(3),
    "nextPollAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAction" TEXT NOT NULL DEFAULT 'vehicle_data',
    "mode" TEXT NOT NULL DEFAULT 'idle',
    "pendingCommandUntil" TIMESTAMPTZ(3),
    "userActiveUntil" TIMESTAMPTZ(3),
    "suspendedUntil" TIMESTAMPTZ(3),
    "backoffUntil" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "VehiclePollState_pkey" PRIMARY KEY ("vehicleId")
);

-- AddForeignKey
ALTER TABLE "VehiclePollState" ADD CONSTRAINT "VehiclePollState_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- DropTable (hand-appended: `prisma migrate diff` 6.19.3 does not emit the DROP
-- for BackgroundJob even from a fresh shadow DB; see ARCHITECTURE_DECISIONS.md)
DROP TABLE IF EXISTS "BackgroundJob";
