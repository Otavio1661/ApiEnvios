-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('EVOLUTION', 'WAHA', 'CLOUD_API');

-- CreateEnum
CREATE TYPE "NumberStatus" AS ENUM ('ACTIVE', 'WARMING', 'BANNED', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ClientRole" AS ENUM ('ADMIN', 'CLIENT');

-- CreateEnum
CREATE TYPE "InstanceConnState" AS ENUM ('DISCONNECTED', 'QR_PENDING', 'CONNECTED', 'BANNED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SCHEDULED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER');

-- CreateEnum
CREATE TYPE "RotationReason" AS ENUM ('BAN', 'LIMIT_REACHED', 'MANUAL', 'SCHEDULED', 'ERROR_RATE');

-- CreateTable
CREATE TABLE "Instance" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "label" TEXT,
    "provider" "Provider" NOT NULL,
    "instanceId" TEXT,
    "status" "NumberStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "token" TEXT NOT NULL,
    "connectionState" "InstanceConnState" NOT NULL DEFAULT 'DISCONNECTED',
    "qrCode" TEXT,
    "qrExpiresAt" TIMESTAMP(3),
    "apiClientId" TEXT NOT NULL,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTotal" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bannedAt" TIMESTAMP(3),
    "banReason" TEXT,
    "bannedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "apiClientId" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "caption" TEXT,
    "providerId" TEXT,
    "instanceId" TEXT,
    "provider" "Provider",
    "providerAttempt" INTEGER NOT NULL DEFAULT 1,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttempt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "instanceId" TEXT,
    "attempt" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "errorMsg" TEXT,
    "duration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NumberRotation" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "reason" "RotationReason" NOT NULL,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NumberRotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "role" "ClientRole" NOT NULL DEFAULT 'CLIENT',
    "fallbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rateLimit" INTEGER NOT NULL DEFAULT 100,
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "secret" TEXT,
    "apiClientId" TEXT,
    "lastCalledAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instance_phone_key" ON "Instance"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_token_key" ON "Instance"("token");

-- CreateIndex
CREATE INDEX "Instance_status_priority_idx" ON "Instance"("status", "priority");

-- CreateIndex
CREATE INDEX "Instance_provider_idx" ON "Instance"("provider");

-- CreateIndex
CREATE INDEX "Instance_apiClientId_status_idx" ON "Instance"("apiClientId", "status");

-- CreateIndex
CREATE INDEX "Message_status_idx" ON "Message"("status");

-- CreateIndex
CREATE INDEX "Message_toPhone_idx" ON "Message"("toPhone");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "Message_scheduledAt_idx" ON "Message"("scheduledAt");

-- CreateIndex
CREATE INDEX "Message_apiClientId_createdAt_idx" ON "Message"("apiClientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_apiClientId_externalId_key" ON "Message"("apiClientId", "externalId");

-- CreateIndex
CREATE INDEX "MessageAttempt_messageId_idx" ON "MessageAttempt"("messageId");

-- CreateIndex
CREATE INDEX "NumberRotation_instanceId_idx" ON "NumberRotation"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiClient_apiKey_key" ON "ApiClient"("apiKey");

-- CreateIndex
CREATE INDEX "ApiClient_apiKey_idx" ON "ApiClient"("apiKey");

-- CreateIndex
CREATE INDEX "Webhook_apiClientId_idx" ON "Webhook"("apiClientId");

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttempt" ADD CONSTRAINT "MessageAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberRotation" ADD CONSTRAINT "NumberRotation_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_apiClientId_fkey" FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
