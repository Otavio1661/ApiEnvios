-- Campanhas (lotes de envio em massa) + vínculo opcional na mensagem.
CREATE TABLE "Campaign" (
  "id" TEXT NOT NULL,
  "name" TEXT,
  "apiClientId" TEXT NOT NULL,
  "instanceId" TEXT,
  "createdByUserId" TEXT,
  "total" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Campaign_apiClientId_createdAt_idx" ON "Campaign"("apiClientId", "createdAt");

ALTER TABLE "Message" ADD COLUMN "campaignId" TEXT;
CREATE INDEX "Message_campaignId_idx" ON "Message"("campaignId");

ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_apiClientId_fkey"
  FOREIGN KEY ("apiClientId") REFERENCES "ApiClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_instanceId_fkey"
  FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
