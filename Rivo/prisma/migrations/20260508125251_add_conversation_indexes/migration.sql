-- AlterTable
ALTER TABLE "User" ALTER COLUMN "passwordChangedAt" SET DATA TYPE TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Contact_conversationId_idx" ON "Contact"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationMember_conversationId_idx" ON "ConversationMember"("conversationId");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");
