/*
  Warnings:

  - A unique constraint covering the columns `[participantsKey]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "participantsKey" TEXT;

-- CreateIndex
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_participantsKey_key" ON "Conversation"("participantsKey");
