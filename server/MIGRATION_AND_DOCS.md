Migration and server notes

1) What changed
- `prisma/schema.prisma`: added `participantsKey` (unique) to `Conversation` and an index on `Contact.ownerId` to improve contact queries.
- `server/routes/contacts.js`: uses a deterministic `participantsKey` and `upsert` to avoid duplicate conversations in races.
- `server/middleware/auth.js`: added a short-lived in-memory cache for `passwordChangedAt` and returns 503 if the DB/cache read fails. This reduces per-request DB load and makes auth fail-closed on DB errors.
- `server/routes/users.js`: added a `bio` max-length validation (2000 chars) to prevent large payload abuse.

2) Migration steps (required)
- These schema changes require a Prisma migration to be applied to your database and the Prisma client regenerated.

Run locally (example):

```bash
# from project root
npx prisma migrate dev --name add-participantsKey-and-contact-owner-index
npx prisma generate
# then restart your server
node server/index.js
```

If your environment uses a production DB, follow your normal migration workflow (backups, run in CI, etc.).

3) Notes on `requireAuth` behavior
- The middleware now uses a small in-memory cache for `passwordChangedAt` (30s TTL) to reduce DB lookups. If the cache or DB lookup fails, the middleware returns `503 Service Unavailable` (fail-closed) instead of allowing the request to continue. This is intentional to avoid accepting tokens when we can't validate them.
- After applying the migration, monitor DB load and adjust `PWD_CACHE_TTL_MS` in `server/middleware/auth.js` as needed.

4) Post-migration checks
- Run smoke-tests that exercise: login, add contact, concurrent add-contact scenarios, delete account flow, and basic messaging.
- Verify `contacts` endpoints behave and duplicate conversations are not created when two concurrent requests are issued.

5) Local testing tips
- To simulate concurrent contact creation, run two scripts that POST to `/api/contacts` at the same time and verify only one conversation is created.
- To inspect the DB, use `psql` or your DB client and check `SELECT * FROM "Conversation" WHERE "participantsKey" LIKE '%%';` to ensure uniqueness.

6) Rollback
- If you need to rollback after applying the migration, follow your DB backup/restore process; Prisma migrations can be reverted in development but require manual DB restore in production.
