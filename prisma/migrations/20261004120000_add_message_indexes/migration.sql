-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_id_idx" ON "Message"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Message_isTimeCapsule_scheduledFor_idx" ON "Message"("isTimeCapsule", "scheduledFor");
