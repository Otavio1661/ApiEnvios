-- Teto de mensagens para o mesmo número de destino por hora (anti-flood), por conta.
-- 0 = ilimitado. Default 10 cobre as linhas existentes com segurança.
ALTER TABLE "ApiClient" ADD COLUMN "maxPerRecipientPerHour" INTEGER NOT NULL DEFAULT 10;
