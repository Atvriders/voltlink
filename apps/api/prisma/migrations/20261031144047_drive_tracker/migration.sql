-- CreateTable
CREATE TABLE "DriveTracker" (
    "vehicleId" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedPct" DOUBLE PRECISION,
    "maxSpeed" DOUBLE PRECISION NOT NULL,
    "points" JSONB NOT NULL DEFAULT '[]',
    "lastMoving" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DriveTracker_pkey" PRIMARY KEY ("vehicleId")
);

