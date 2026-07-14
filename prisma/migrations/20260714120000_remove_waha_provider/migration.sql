-- Remove o valor WAHA do enum Provider.
-- Postgres não suporta remover valor de enum diretamente; recria o tipo.
-- Pré-condição verificada: nenhuma linha usa 'WAHA' em Instance/InstanceNumber/Message/MessageAttempt.

ALTER TYPE "Provider" RENAME TO "Provider_old";

CREATE TYPE "Provider" AS ENUM ('EVOLUTION', 'WUZAPI', 'CLOUD_API');

ALTER TABLE "Instance"       ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::text::"Provider");
ALTER TABLE "InstanceNumber" ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::text::"Provider");
ALTER TABLE "Message"        ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::text::"Provider");
ALTER TABLE "MessageAttempt" ALTER COLUMN "provider" TYPE "Provider" USING ("provider"::text::"Provider");

DROP TYPE "Provider_old";
