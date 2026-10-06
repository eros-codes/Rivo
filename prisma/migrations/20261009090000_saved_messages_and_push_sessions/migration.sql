-- Every account has its Saved Messages chat. Sign-up makes it, and the
-- server no longer makes one on the fly for accounts from before it existed:
-- those (if any are left) get theirs here.
DO $$
DECLARE
  account RECORD;
  conv INTEGER;
BEGIN
  FOR account IN
    SELECT u."id" FROM "User" u
    WHERE NOT u."isDeleted"
      AND NOT EXISTS (SELECT 1 FROM "Contact" c WHERE c."ownerId" = u."id" AND c."isSaved")
  LOOP
    INSERT INTO "Conversation" DEFAULT VALUES RETURNING "id" INTO conv;
    INSERT INTO "ConversationMember" ("userId", "conversationId") VALUES (account."id", conv);
    INSERT INTO "Contact" ("ownerId", "contactId", "conversationId", "isSaved") VALUES (account."id", account."id", conv, true);
  END LOOP;
END $$;

-- A notification subscription always belongs to a signed-in device (its
-- session): signing that device out removes it. Subscriptions from before
-- sessions existed belong to no device and are removed; the browser
-- subscribes again the next time the app opens signed in.
DELETE FROM "PushSubscription" WHERE "sessionId" IS NULL;

-- AlterTable
ALTER TABLE "PushSubscription" ALTER COLUMN "sessionId" SET NOT NULL;
