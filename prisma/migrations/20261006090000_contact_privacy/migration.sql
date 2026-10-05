-- A contact row the server made on its own (the other person added this
-- user, or wrote to them after being removed) does not count as "saved by
-- the owner" for the "Contacts" privacy settings until the owner writes in
-- the chat, adds the person themselves or gives them a name.
ALTER TABLE "Contact" ADD COLUMN "addedByOwner" BOOLEAN NOT NULL DEFAULT true;

-- Existing rows: of the two rows of a chat, the later one was made by the
-- server when the other person added this user. It stays "saved" only if its
-- owner has written in the chat or named the person.
UPDATE "Contact" AS c
SET "addedByOwner" = false
WHERE c."isSaved" = false
  AND c."nickname" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Contact" AS o
    WHERE o."conversationId" = c."conversationId"
      AND o."ownerId" = c."contactId"
      AND o."contactId" = c."ownerId"
      AND o."id" < c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Message" AS m
    WHERE m."conversationId" = c."conversationId"
      AND m."senderId" = c."ownerId"
  );

-- Email addresses are visible to contacts only, unless a user chooses
-- otherwise in Settings → Privacy (it was "everyone" by default).
ALTER TABLE "User" ALTER COLUMN "privacyEmail" SET DEFAULT 'contacts';
UPDATE "User" SET "privacyEmail" = 'contacts' WHERE "privacyEmail" = 'everyone';
