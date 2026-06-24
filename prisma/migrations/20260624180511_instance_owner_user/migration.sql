-- Dono (usuário) por instância: MEMBER só vê as suas; OWNER vê todas da conta.
-- Aditivo e nullable (instâncias existentes ficam sem dono = visíveis só ao OWNER).
ALTER TABLE "Instance" ADD COLUMN "ownerUserId" TEXT;

CREATE INDEX "Instance_ownerUserId_idx" ON "Instance"("ownerUserId");

ALTER TABLE "Instance" ADD CONSTRAINT "Instance_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
