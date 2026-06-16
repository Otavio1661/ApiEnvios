-- DropIndex
DROP INDEX "Instance_phone_key";

-- CreateIndex
CREATE UNIQUE INDEX "Instance_apiClientId_phone_key" ON "Instance"("apiClientId", "phone");

