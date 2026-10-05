-- Two columns nothing uses any more:
--   Message.text                 the plaintext of messages from before encryption
--                                (20260518192525_add_message_encryption); every
--                                message since is stored encrypted only
--   Conversation.participantsKey  from an older way of finding a chat
--
-- A database that still has a message whose text exists only as plaintext (or
-- a plaintext quote / forwarded text) stops here, before anything changes,
-- instead of losing it. On a database whose data does not matter (test data),
-- `npm run db:seed -- --wipe` empties it; then run `npx prisma migrate deploy`
-- again (after `npx prisma migrate resolve --rolled-back 20261008090000_drop_legacy_columns`).
DO $$
DECLARE
  plain integer;
BEGIN
  SELECT count(*) INTO plain FROM "Message"
  WHERE NOT "isDeleted"
    AND (("text" IS NOT NULL AND "ciphertext" IS NULL)
      OR ("replyToText" IS NOT NULL AND left("replyToText", 1) <> '{')
      OR ("forwardedText" IS NOT NULL AND left("forwardedText", 1) <> '{'));
  IF plain > 0 THEN
    RAISE EXCEPTION '% message(s) are still stored as plaintext; this migration would lose them. Nothing was changed.', plain;
  END IF;
END $$;

-- DropIndex
DROP INDEX "Conversation_participantsKey_key";

-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "participantsKey";

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "text";
