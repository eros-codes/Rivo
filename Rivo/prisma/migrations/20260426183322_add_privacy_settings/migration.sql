-- AlterTable
ALTER TABLE "User" ADD COLUMN     "privacyEmail" TEXT NOT NULL DEFAULT 'everyone',
ADD COLUMN     "privacyOnline" TEXT NOT NULL DEFAULT 'everyone',
ADD COLUMN     "privacyProfile" TEXT NOT NULL DEFAULT 'everyone';
