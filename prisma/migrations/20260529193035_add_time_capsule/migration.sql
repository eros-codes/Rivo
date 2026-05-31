-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "isTimeCapsule" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledFor" TIMESTAMP(3);
