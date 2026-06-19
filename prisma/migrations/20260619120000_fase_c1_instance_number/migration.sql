-- Fase C1 — novo modelo InstanceNumber (Instância como pool de números). ADITIVO.
-- Nenhuma coluna da Instance é removida; o roteamento/QR/envio continua usando a Instance.
-- Este migration apenas cria a tabela e faz backfill (1 número filho por instância).

-- CreateTable
CREATE TABLE "InstanceNumber" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "providerInstanceId" TEXT,
    "phone" TEXT,
    "label" TEXT,
    "status" "NumberStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "connectionState" "InstanceConnState" NOT NULL DEFAULT 'DISCONNECTED',
    "qrCode" TEXT,
    "qrExpiresAt" TIMESTAMP(3),
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTotal" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bannedAt" TIMESTAMP(3),
    "banReason" TEXT,
    "bannedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstanceNumber_instanceId_idx" ON "InstanceNumber"("instanceId");

-- CreateIndex
CREATE INDEX "InstanceNumber_status_priority_idx" ON "InstanceNumber"("status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceNumber_instanceId_phone_key" ON "InstanceNumber"("instanceId", "phone");

-- AddForeignKey
ALTER TABLE "InstanceNumber" ADD CONSTRAINT "InstanceNumber_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: cria 1 InstanceNumber por Instance existente, copiando os campos espelhados.
-- ID gerado em SQL com md5(random()::text || clock_timestamp()::text) — não depende de extensão.
-- Idempotente: só insere para instâncias que ainda NÃO possuem nenhum número (NOT EXISTS),
-- então reexecutar não duplica.
INSERT INTO "InstanceNumber" (
    "id", "instanceId", "provider", "providerInstanceId", "phone", "label",
    "status", "priority", "connectionState", "qrCode", "qrExpiresAt",
    "sentToday", "sentTotal", "lastSentAt", "lastResetAt",
    "bannedAt", "banReason", "bannedCount", "createdAt", "updatedAt"
)
SELECT
    md5(random()::text || clock_timestamp()::text),
    i."id",
    i."provider",
    i."instanceId",          -- providerInstanceId
    i."phone",
    i."label",
    i."status",
    i."priority",
    i."connectionState",
    i."qrCode",
    i."qrExpiresAt",
    i."sentToday",
    i."sentTotal",
    i."lastSentAt",
    i."lastResetAt",
    i."bannedAt",
    i."banReason",
    i."bannedCount",
    i."createdAt",
    CURRENT_TIMESTAMP        -- updatedAt
FROM "Instance" i
WHERE NOT EXISTS (
    SELECT 1 FROM "InstanceNumber" n WHERE n."instanceId" = i."id"
);
