-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'BUTTONS';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "buttons" JSONB;
