-- Fase C3 — roteamento de envio religado aos NÚMEROS do pool (InstanceNumber). ADITIVO.
-- Nenhuma coluna é removida. Apenas adiciona FKs opcionais/nullable:
--   - Message.numberId    → InstanceNumber (qual número efetivou o envio)
--   - NumberRotation.numberId → InstanceNumber (qual número foi rotacionado/banido)
-- onDelete SET NULL: remover um número do pool não apaga o histórico de mensagens/rotações.

-- AlterTable: Message.numberId
ALTER TABLE "Message" ADD COLUMN "numberId" TEXT;

-- AlterTable: NumberRotation.numberId
ALTER TABLE "NumberRotation" ADD COLUMN "numberId" TEXT;

-- CreateIndex
CREATE INDEX "Message_numberId_idx" ON "Message"("numberId");

-- CreateIndex
CREATE INDEX "NumberRotation_numberId_idx" ON "NumberRotation"("numberId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "InstanceNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NumberRotation" ADD CONSTRAINT "NumberRotation_numberId_fkey" FOREIGN KEY ("numberId") REFERENCES "InstanceNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
