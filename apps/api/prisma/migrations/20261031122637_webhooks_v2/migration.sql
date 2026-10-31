-- Webhooks v2 (Phase 2, guide 03 §5/§6): Standard Webhooks secrets sealed at
-- rest (N-WHSIGN), NotificationChannel config sealed (N-CHANSECRETS), inbound
-- automation webhooks (Z-INBOUNDWH) and per-user push subscriptions (G-09).

-- DropIndex
DROP INDEX "PushSubscription_endpoint_key";

-- AlterTable
ALTER TABLE "WebhookEndpoint" DROP COLUMN "secretHash",
ADD COLUMN     "displayHint" TEXT,
ADD COLUMN     "events" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "previousSecretSealed" TEXT,
ADD COLUMN     "previousUntil" TIMESTAMPTZ(3),
ADD COLUMN     "secretSealed" TEXT;

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configCiphertext" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledReason" TEXT,
    "nextAllowedAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastFailureAt" TIMESTAMPTZ(3),
    "lastFailureKind" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundWebhook" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "secretSealed" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InboundWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundWebhookReceipt" (
    "id" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundWebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationChannel_userId_kind_idx" ON "NotificationChannel"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhook_automationId_key" ON "InboundWebhook"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhook_publicId_key" ON "InboundWebhook"("publicId");

-- CreateIndex
CREATE INDEX "InboundWebhookReceipt_hookId_createdAt_idx" ON "InboundWebhookReceipt"("hookId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhookReceipt_hookId_messageId_key" ON "InboundWebhookReceipt"("hookId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundWebhook" ADD CONSTRAINT "InboundWebhook_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundWebhook" ADD CONSTRAINT "InboundWebhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundWebhookReceipt" ADD CONSTRAINT "InboundWebhookReceipt_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "InboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
