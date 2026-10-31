-- §2.8 vehicle selection: server-persisted favorites.
ALTER TABLE "User" ADD COLUMN "favoriteVehicleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
