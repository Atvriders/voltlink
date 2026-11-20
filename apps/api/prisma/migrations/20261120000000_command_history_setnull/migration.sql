-- TI-44 (P-FAILED): command history must survive vehicle removal.
-- Drop the cascade and let vehicleId go NULL on vehicle delete.
ALTER TABLE "VehicleCommand" DROP CONSTRAINT "VehicleCommand_vehicleId_fkey";
ALTER TABLE "VehicleCommand" ALTER COLUMN "vehicleId" DROP NOT NULL;
ALTER TABLE "VehicleCommand" ADD CONSTRAINT "VehicleCommand_vehicleId_fkey"
  FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
