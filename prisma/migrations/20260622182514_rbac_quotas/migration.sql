-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';

-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "maxInstances" INTEGER NOT NULL DEFAULT 1;
