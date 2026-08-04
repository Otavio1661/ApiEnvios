-- Segredo de autenticação dos webhooks INBOUND (ver comentário no schema em
-- Instance.webhookSecret). Adiciona como nullable primeiro, faz backfill das
-- linhas existentes com valor aleatório único, só então torna NOT NULL/UNIQUE
-- (a tabela já tem linhas — um "ADD COLUMN NOT NULL" direto falharia).

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN "webhookSecret" TEXT;

-- Backfill (função nativa do Postgres, sem depender de extensão como pgcrypto)
UPDATE "Instance" SET "webhookSecret" = md5(random()::text || clock_timestamp()::text)
WHERE "webhookSecret" IS NULL;

-- AlterTable
ALTER TABLE "Instance" ALTER COLUMN "webhookSecret" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Instance_webhookSecret_key" ON "Instance"("webhookSecret");
