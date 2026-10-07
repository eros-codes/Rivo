# Rivo

A real-time messenger: Express 5 + Socket.IO + Prisma (PostgreSQL) on the server, React 19 +
TypeScript in the browser. Both sides are TypeScript and read from one shared contract (`shared/`:
the shape of the data, the live events, and the zod schemas the server checks every input against).

## Getting started

```bash
cp .env.example .env          # (or copy your previous .env) and fill in the values
npm install
npx prisma migrate deploy
npm run build
npm start                      # http://localhost:3000
```

For development: `npm run dev` (continuous client build + server restarts). Test data:
`npm run db:seed` (16 people with their chats; `-- --wipe` deletes everything first).

## Tests and checks

```bash
npm run check                      # everything below, one after another (before a commit)
npm run typecheck && npm run lint
npm run test:unit                  # no database needed
npm run test:api                   # needs TEST_DATABASE_URL (a database used only for tests)
npm run build && npm run test:e2e  # in a browser (once: npx playwright install chromium)
npm run loadtest                   # many people chatting at once, measured (not part of check)
```

The tests are TypeScript too and are checked against the same `shared/` contract (unit 34,
api 42, browser 37). They also run on every push to GitHub, in GitHub Actions
(`.github/workflows/ci.yml`), where the browser tests run in Firefox and WebKit (Safari) as well.

## Operations

`GET /api/health` for monitoring, `npm run db:backup` / `db:restore` for backups, and
`npm run db:check` before migrations. Details: sections 7 to 9 of the docs. Encryption keys,
key rotation and Vault: [`server/ENCRYPTION.md`](server/ENCRYPTION.md). Putting Rivo on a server
(Ubuntu, nginx, HTTPS) and updating it there: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Documentation

Everything else (the folder map, the sync protocol, sessions and CSRF, rate limits, privacy,
the outbox and undo, upgrade notes from the previous version, and the tests) is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
