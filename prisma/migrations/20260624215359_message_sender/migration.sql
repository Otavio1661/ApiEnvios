-- Rastreia o usuário humano que disparou a mensagem (null = API key/token).
ALTER TABLE "Message" ADD COLUMN "createdByUserId" TEXT;
CREATE INDEX "Message_createdByUserId_idx" ON "Message"("createdByUserId");
ALTER TABLE "Message" ADD CONSTRAINT "Message_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
