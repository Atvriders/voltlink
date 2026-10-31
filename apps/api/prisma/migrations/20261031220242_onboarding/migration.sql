-- AlterTable
ALTER TABLE "User" ADD COLUMN     "onboardingCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "onboardingSkipped" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "onboardingStep" TEXT NOT NULL DEFAULT 'welcome';

