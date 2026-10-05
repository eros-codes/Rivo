-- Rules the server already followed, now guaranteed by the database itself
-- (a bug, a race between two requests or a second server process can no
-- longer break them). Rows that already break them are cleaned up first;
-- no message is deleted. `npm run db:check` shows beforehand what, if
-- anything, this changes.

-- ─── A person is a member of a chat once ────────────────────────────────
DELETE FROM "ConversationMember" a
USING "ConversationMember" b
WHERE a."conversationId" = b."conversationId"
  AND a."userId" = b."userId"
  AND a."id" > b."id";

CREATE UNIQUE INDEX "ConversationMember_conversationId_userId_key"
  ON "ConversationMember"("conversationId", "userId");

-- ─── One Saved Messages per user ────────────────────────────────────────
-- (two could be made at the same moment by an older version). The messages
-- of the extra ones move into the oldest one, then the extra chats go.
CREATE TEMP TABLE "_saved_extra" AS
SELECT c."id" AS "contactId", c."conversationId" AS "fromConv", k."conversationId" AS "toConv"
FROM "Contact" c
JOIN LATERAL (
  SELECT k."conversationId" FROM "Contact" k
  WHERE k."ownerId" = c."ownerId" AND k."isSaved" = true
  ORDER BY k."id" ASC LIMIT 1
) k ON true
WHERE c."isSaved" = true
  AND c."id" <> (SELECT min(x."id") FROM "Contact" x WHERE x."ownerId" = c."ownerId" AND x."isSaved" = true);

UPDATE "Message" m SET "conversationId" = e."toConv"
FROM "_saved_extra" e
WHERE m."conversationId" = e."fromConv" AND e."fromConv" <> e."toConv";

UPDATE "Conversation" v
SET "lastMessageAt" = (SELECT max(m."createdAt") FROM "Message" m WHERE m."conversationId" = v."id")
WHERE v."id" IN (SELECT "toConv" FROM "_saved_extra");

DELETE FROM "Contact" WHERE "id" IN (SELECT "contactId" FROM "_saved_extra");

DELETE FROM "ConversationMember"
WHERE "conversationId" IN (SELECT "fromConv" FROM "_saved_extra" WHERE "fromConv" <> "toConv")
  AND NOT EXISTS (SELECT 1 FROM "Contact" c WHERE c."conversationId" = "ConversationMember"."conversationId");

DELETE FROM "Conversation" v
WHERE v."id" IN (SELECT "fromConv" FROM "_saved_extra" WHERE "fromConv" <> "toConv")
  AND NOT EXISTS (SELECT 1 FROM "Contact" c WHERE c."conversationId" = v."id")
  AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."conversationId" = v."id");

DROP TABLE "_saved_extra";

-- ─── A person is in someone's list once ─────────────────────────────────
-- Of two rows for the same person, the one whose chat was used most recently
-- stays. The other chat's messages are not touched (they stay on the server,
-- and the other person still has the chat).
DELETE FROM "Contact" c
USING (
  SELECT c2."id", ROW_NUMBER() OVER (
    PARTITION BY c2."ownerId", c2."contactId"
    ORDER BY v."lastMessageAt" DESC NULLS LAST, c2."id" ASC
  ) AS "rn"
  FROM "Contact" c2
  JOIN "Conversation" v ON v."id" = c2."conversationId"
  WHERE c2."isSaved" = false
) r
WHERE c."id" = r."id" AND r."rn" > 1;

CREATE UNIQUE INDEX "Contact_ownerId_contactId_isSaved_key"
  ON "Contact"("ownerId", "contactId", "isSaved");
