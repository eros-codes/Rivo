# Rivo Architecture

This document explains how Rivo is built, where each part lives, and why it is designed this way.
If you just want to get the project running, start with the "Install and update" section.

---

## 1. Install and update

### Clean install (recommended)

```bash
# 1) Unzip into a new folder, then copy these over from the previous project:
#    - the .env file
#    - the public/assets/images/user-profiles folder  (uploaded profile pictures)
# 2) Install dependencies (npm install, not npm ci: the dependencies have changed and
#    package-lock.json gets updated right here with the new versions)
#    (it also builds the database client from prisma/schema.prisma: server/generated/prisma)
npm install
# 3) Database migrations (only the ones that have not run yet; see the "Migrations" section)
npx prisma migrate deploy
# 4) Build the clients
npm run build
# 5) Run (= node --import ./server/instrument.ts server/index.ts; section 9 → Error reporting)
npm start
```

> **Everyone has to log in again, once.** The session system has changed, and old tokens
> are no longer accepted. After logging in, each device shows up in Settings → Devices.

### Migrations

| migration | What it does |
|---|---|
| `20261005090000_sessions_and_sync` | `Session` table; `updatedAt` and `clientId` columns on `Message` (existing messages get `updatedAt = createdAt`); `sessionId` on `PushSubscription` |
| `20261006090000_contact_privacy` | `addedByOwner` column on `Contact` (explained in section 3 → "Contacts only" privacy); email visibility defaults to "Contacts only" |
| `20261007090000_integrity_constraints` | Rules that until now only the code enforced are now guaranteed by the database itself: each person appears once in anyone's list, one Saved Messages per user, each member once per chat (section 9) |
| `20261008090000_drop_legacy_columns` | Drops two columns that were no longer used: `Message.text` (the unencrypted text of messages from before encryption) and `Conversation.participantsKey`. If any message still exists only in unencrypted form, the migration stops before changing anything and says how many |
| `20261009090000_saved_messages_and_push_sessions` | An account that does not have Saved Messages (dating from before Saved Messages existed) gets one, once (the server no longer creates it when loading the list). Also, every push subscription must now belong to a device (session) and is deleted when that device logs out; old subscriptions without a session are deleted, and the browser re-subscribes on its own the next time the app is opened |

> ⚠️ The second migration switches the email visibility of users who were on "Everyone" to "Contacts"
> (the previous default was "Everyone", and anyone could see everyone's email by searching a username).
> Each user can switch it back in Settings → Privacy.

All of them were run on a real Postgres 16, on top of the full chain of earlier migrations, with
sample data (including duplicate rows), and compared against `schema.prisma` (columns, nullability
and unique indexes match).

> **Before `migrate deploy` on a real database:** `npm run db:check` shows whether
> the third migration will clean anything up (and what). It changes nothing.

**Changing the schema:** `npx prisma migrate dev --name <name>` creates a new migration and
runs it on the development database. Since Prisma 7 it no longer regenerates the client by itself, so
run `npx prisma generate` afterwards (so the types and the client in `server/generated/prisma` are updated).
The `prisma` command gets the database URL from `prisma.config.ts` (which reads `.env`).

### If you are copying over the previous folder

These old files/folders are no longer used and should be deleted:
`src/`, `public/js/`, `public/css/`, `public/chat/main.html`, the old files inside
`public/landing/` (such as `landing.css`/`landing.js`), and the old `public/auth/`.
`npm run build` generates all the new output in `public/`.

### Commands

| Command | What it does |
|---|---|
| `npm run build` | Production build of all clients into `public/` (file names include a content hash) |
| `npm run dev` | Continuous build on every change in `client/` + server restart with nodemon (on changes to `server/`, `shared/` or `.env`) |
| `npm start` | Run the server (`server/instrument.ts` first: error reporting, if `SENTRY_DSN` is set) |
| `npm run typecheck` | Check TypeScript types: app, service worker, server, tests (the build itself does not type-check, for speed) |
| `npm run lint` | ESLint on the JavaScript that remains (`scripts/*.mjs`); everything else is TypeScript |
| `npm run check` | Everything in sequence, stopping at the first error: typecheck → lint → build → all three test suites (before a commit; takes a few minutes) |
| `npm test` | All three test suites (section 7) |
| `npm run test:unit` / `test:api` / `test:e2e` | Each suite on its own |
| `npm run test:integration` | Manual test against a running server |
| `npm run loadtest` | Many people chatting at once on a test server, measured: how long messages take to arrive, what fails, the server's CPU and memory (section 7 → Load test; not part of `npm test`) |
| `npm run db:check` | Before migrating: the duplicate rows that the integrity migration will clean up |
| `npm run db:seed` | Test data (`-- --wipe`: deletes everything first; local database only) |
| `npm run db:backup` / `db:restore` | Backup and restore (section 9) |
| `npm run gen-kek` / `check-kek` | Generate the message key / check the keys in `.env` (or Vault) |
| `npm run gen-vapid` / `check-vapid` | Generate / check the push keys |
| `npm run verify-messages` | Can all messages be decrypted with the current keys? (changes nothing) |
| `npm run rotate-keys` | Key rotation; the full procedure is in `server/ENCRYPTION.md` |
| `npm run test:enc` | Writes an encrypted message, reads it back through the server's own read path, and deletes it |

---

## 2. Folder map

```
client/                    ← all browser code (React 19 + TypeScript strict)
  shared/                  ← shared by all pages
    api/                   ← types.ts (comes from shared/), http.ts, endpoints.ts
    lib/                   ← store, time, text/links/RTL, theme, storage, hooks, images
    ui/                    ← Icons, Avatar, Dialog, PasswordInput
    styles/global.css      ← color tokens, fonts, helpers
  chat/                    ← the main app (/chat/)
    main.tsx               ← startup: user, live connection, initial load, render
    state/                 ← stores and pure models (no UI)
    services/              ← everything that talks to the server/browser
    ui/                    ← components (people / chat / panels / dialogs / feedback)
    styles/                ← CSS (same look as before, with its bugs fixed)
  auth/                    ← login/sign-up (/auth/)
  reset/                   ← new password from the email link (/reset-password.html)
  landing/                 ← home page and privacy page (SSG + hydrate)
  boot/theme.ts            ← applies theme/color/wallpaper before the first paint
  sw/service-worker.ts     ← notifications + caching of app files
scripts/
  build.mjs                ← esbuild: bundling, hashing, pages, SW, landing prerender
  pages.mjs                ← HTML template for the pages
  dev.mjs                  ← development mode
  test.mjs                 ← runs the tests (unit / api / e2e / load)
  backup-db.sh             ← backs up the database and pictures
  restore-db.sh            ← restore (drill or for real)
  db-url.mjs               ← database URL for the Postgres tools
server/                    ← Express 5 + Socket.IO + Prisma, all TypeScript (section 3)
  tsconfig.json            ← type check for the server and prisma/seed (npm run typecheck)
  instrument.ts            ← error reporting (Sentry), loaded before the server itself
  prisma.ts                ← database client (Prisma 7 + pg adapter) and its types for the rest of the server
  generated/prisma/        ← client generated from the schema (npm install / npx prisma generate; not in git)
  utils/logger.ts          ← JSON logs with reqId/userId
  utils/errors.ts          ← reads the message/code of a thrown error
  utils/processStats.ts    ← the process's CPU, memory and event loop, for the load test
  scripts/                 ← manual tools: keys, rotation, message checks, Vault (server/ENCRYPTION.md)
shared/                    ← the contract between app and server (section 3 → Contract)
  api.ts                   ← response shapes and every endpoint
  events.ts                ← live events and their responses
  limits.ts                ← limits (message length, name, password, …)
  schemas/                 ← zod schemas for every input (section 3 → Inputs)
public/                    ← assets (fonts, icons, emoji data) + build output
prisma/                    ← schema and migrations
  seed/                    ← test data (npm run db:seed; change data.ts freely)
prisma.config.ts           ← prisma command settings: schema, migrations, database URL (from .env)
tests/                     ← all TypeScript, checked against the shared/ contract (section 7)
  tsconfig.json            ← type check for api / e2e / integration / load / support
  support/                 ← test server (backend.ts), typed test user and socket (client.ts), small SMTP server (smtp.ts)
  unit/                    ← client logic (node:test + tsx; with the app's own tsconfig)
  api/                     ← real server + test database (node:test)
  e2e/                     ← browser (Playwright); support/app.ts for repeated tasks
  integration/             ← manual test against a running server
  load/                    ← load test (npm run loadtest)
load-reports/              ← the load test's reports (not in git)
.github/workflows/ci.yml   ← CI
eslint.config.js           ← ESLint 10 (flat config)
```

---

## 3. Server

### TypeScript on the server

The server was moved from JS to TypeScript in three stages, with no change in behavior:

| Stage | Files | Status |
|---|---|---|
| 1 | `config`, `env`, `events`, `prisma`, all of `utils/`, `services/caches`, `services/actionLimit`, `realtime/registry` | ✅ |
| 2 | `services/` (messages, contacts, presence), `auth/sessions`, `jobs/` | ✅ |
| 3 | `routes/`, `socket/`, `middleware/`, `http/`, `index` | ✅ |

- **No build:** Node 22.18 and later runs `.ts` files directly (it only strips
  the types). `tsc` only checks: `npm run typecheck`
  (`server/tsconfig.json`, strict mode).
- **Only erasable syntax** (`erasableSyntaxOnly`): no `enum`, no
  `namespace` with code, no parameter properties in constructors. Instead of an enum, use a union
  of strings (`"asc" | "desc"`).
- **Imports use the real extension:** `from "../prisma.ts"`. The remaining JS files also
  import TS modules with `.ts`. Type-only imports use
  `import type`.
- **Database:** Prisma generates the types from `schema.prisma` (`npx prisma generate`,
  which `npm install` also runs, into `server/generated/prisma`):
  a wrong field in `where` and `select`, or reading a field that was not selected, is an error
  before anything runs. Server code gets the types from `server/prisma.ts`, not from the
  generated folder: `import prisma, { type Prisma } from "../prisma.ts"`.
- **Whatever is thrown is `unknown`:** get its message with `messageOf(e)` and its code (e.g.
  `P2002` in Prisma) with `codeOf(e)` from `utils/errors.ts`.
- **The whole server is TypeScript**, including the manual tools in `server/scripts/` and the test data in
  `prisma/seed/`. So if a server function's signature changes, a script that uses it
  (e.g. `rotate_keys.ts`) fails typecheck right away, not on the day someone
  runs it. In `prisma/seed/data.ts`, a wrong username or a misspelled
  option (`{ raect: "❤️" }`) is also a type error. The server starts with `node server/index.ts`
  (`npm start` also loads `server/instrument.ts` before it with `--import`).
- **Express handlers return nothing** (Express 5 types):
  `return void res.status(400).json(...)` means "respond and stop"; Express ignores the
  return value anyway.
- **The result of message service operations** is either `{ error }` or a success; they are told apart with
  `if ("error" in result)`.
- **`req.userId` / `req.sessionId`** are set by `requireAuth`
  (`server/types/express.d.ts`); they are only read in routes behind it.
- **Socket:** everything that belongs to the connection is in `socket.data` (`SocketData` in
  `realtime/registry.ts`), including `userId`. Each event's payload is checked against its own
  schema before it is used (next section).

### Inputs (zod)

TypeScript only checks while you write the code; what arrives from the network can have any
shape (`{ conversationId: "12abc", text: 5 }`). That is why every input (the body,
query and params of each route, the payload of each socket event) is checked **before anything else**
against a schema from `shared/schemas/`:

| File | What |
|---|---|
| `common.ts` | Building blocks: id (number or digits, 1 to 2³¹−1), optional id, flag, trimmed text, clientId, page size |
| `messages.ts` | Send, forward, edit, delete, pin, reaction, seen, join/leave/typing, search |
| `auth.ts` | Email code, sign-up, login, logout, forgot password |
| `account.ts` | Profile, password, account deletion, people search, devices, push |
| `contacts.ts` / `conversations.ts` | Contact list, chat pages, changes, clearing a chat |

- **One place for checking:** `server/http/validate.ts` → `check(schema, input)` (for
  sockets) and `parse(res, schema, input)` (for routes: if the input is bad, it responds with `400 { error }`
  itself). The response is the **first** problem, with the sentence the schema defines for it
  (`"Invalid clientId"`, `"Name must be between 2 and 100 characters"`); a problem that
  has no sentence of its own is `"Invalid data"`. The sentences are the same ones the server used
  before (the app shows some of them to the user).
- **Services receive checked data:** `sendMessageAs(actor, data)` no longer takes `unknown`;
  `data` is the schema's output (`conversationId: number`, trimmed `text`,
  `scheduledFor: Date | null`). Checks that need the database or the clock (chat
  membership, blocking, the capsule time window) stay in the service.
- **Budget before the check:** the cost of an event/request is deducted from the action budget first,
  and then the payload is checked; a flood of malformed payloads is not free either.
- **Stricter than before:** `isOneTime: "yes"` used to be silently treated as `false`; now it is
  rejected. A bad id in the middle of a delete or forward list used to be ignored; now the whole
  request is rejected. A bad `beforeId` in the chat list used to be ignored. The app
  sends none of these.
- **Limits in `shared/limits.ts`:** message length (1500), name, bio, password, username
  pattern, batch size, capsule time window. These are no longer in `.env`: the app and the server
  must know the same number, and the app cannot see the server's `.env`.
- **New input:** write its schema in `shared/schemas/`, check it in the route or handler with
  `parse`/`check`, and pass its output to the service. Its tests go in
  `tests/unit/schemas.test.ts`.

### Contract between the app and the server (`shared/`)

The app and the server used to each have their own types: if the server renamed a field,
typecheck stayed green on both sides and the breakage only showed up at runtime. Now
both read from **one place**, and `npm run typecheck` checks both against the same
files:

| File | What |
|---|---|
| `shared/api.ts` | The shape of everything the server sends (`Me`, `Person`, `ContactRow`, `LiveMessage`, …) and `Endpoints`: what each endpoint takes (`Body<"PATCH /api/users/me">`, from that input's schema) and what it returns (`Answer<…>`) |
| `shared/events.ts` | `ServerEvents` (every event the server sends), `ClientEventSchemas` (the schema of every event the app sends), `ClientAcks` (the response to each one) |
| `shared/limits.ts` | Limits and patterns (message length, username, email, …); plain values only |
| `shared/schemas/` | Inputs (previous section) |

- **Server:** every successful route response is sent with `reply(res, "GET /api/users/me", me)`
  (`server/http/reply.ts`); if `me` is not what the contract says, it does not
  compile. Every event goes out through `emitToUser` / `deliverToConversation`, which check the event name and
  its payload against `ServerEvents`. Every socket event is read with its own schema from
  `ClientEventSchemas`, and its response must be that event's `ClientAcks`
  (services return `Result<…>`).
- **App:** `client/shared/api/types.ts` only re-exports from `shared/` (the app's imports
  stayed the same); `endpoints.ts` types each endpoint's response as `Answer<…>` and its body as
  `satisfies Body<…>`; `realtime.ts` works with the same `ClientEvents` / `ServerEvents`.
  The app does **not bundle** zod: it only takes types from the schemas, and
  `limits.ts` contains nothing but plain values.
- **Dates on the wire are ISO strings:** the server converts `Date` itself
  (`server/utils/wire.ts`: `iso`, `isoOrNull`, `meOf`). The JSON output is the same as before; only
  now the types say so too.
- **A field the schema does not know:** zod silently drops it. That is why
  `shared/events.ts` has an exact type for what the app sends for each event
  (`ClientPayloads`; ids are numbers, not the "number or string" that the server also accepts), and it checks
  at compile time that the schema for that event accepts it and reads **all** of its
  fields.
- **Changing the protocol:** change the `shared/` file and run `npm run typecheck`: every place in the
  server and the app that must change along with it gets an error. For example, renaming
  `LiveMessage.replyToName` causes an error both in the server's `messageView.ts` and in the app's
  `bubbleData.ts`; a response that lacks `updatedAt`, or an event with a wrong field, causes an error in
  the server itself.
- **Nothing is outside the contract:** every endpoint and event the server has is in `shared/`.
  What remained only for the first version of the app was removed: `GET /api/conversations`,
  `GET /api/conversations/:id`, `GET /api/messages/:conversationId` (and `/pinned`),
  the single-message `message:delete` event (the app sends `messages:delete`), the old name
  `clientMessageId`, the contact row that included `conversation.messages`, "You" instead of the name in
  quotes and forwards, `<id>.jpg` avatars, the `/chat/main.html`,
  `/auth/auth.html` and `/reset-password` URLs, and the cookies from before sessions.
- **Tests use the same contract:** the test client (`tests/support/client.ts`) types the response of
  any endpoint you name with `Answer<…>` and its body with `Body<…>`
  (`a.get<"GET /api/contacts">("/api/contacts")`), each event's payload with its own
  schema, its response with `ClientAcks`, and the server's events with `ServerEvents`. A field that
  changes in `shared/` is a type error in the tests too.

### Sessions

- Each login creates a `Session` row. The session cookie (`rivo_session`, in production
  `__Host-rivo_session`) is a JWT with `{uid, sid}`: the signature proves the cookie came from the
  server; the database row decides whether it is still valid.
- Result: logging out a device is immediate (Settings → Devices); a password change logs out the
  other devices but keeps the current one; a password reset/account deletion logs out all of them.
- A session is extended with use (`SESSION_TTL_DAYS`, default 30 days).
- The socket is also tied to the `sid`; session end = `session:ended` and that device is disconnected.

### CSRF

The `rivo_csrf` cookie holds `HMAC(secret, "csrf:" + sid)`, and the client sends it back in the
`X-CSRF-Token` header. The server recomputes it from the session, so a value planted by
someone else never matches (signed double-submit).

### Message sync protocol

The old problem: if the connection dropped for a few seconds, the messages/edits/deletions in that gap
were lost. Now:

- Every message has `updatedAt` (it moves forward with every edit, deletion, seen, pin, and reaction).
- `GET /api/conversations/:id/messages?limit&before&beforeId` → a page of messages +
  `cursor` (server time).
- `GET /api/conversations/:id/changes?since=<cursor>` → everything that changed since that moment
  (with a 10-second overlap to be safe; deleted messages as tombstones). If there are more than
  500 changes, `reset: true`, and the client fetches the last page from scratch.
- When the connection drops, the client marks all cached chats as "stale" and catches up on each one
  when it is opened (the open chat right after reconnecting). The starting point is
  **the last time anything was heard from the server** (any event, or the ping every 5 seconds) minus
  30 seconds, not the moment the drop was noticed: a phone that was asleep for 10 minutes only notices the drop
  when it wakes up. If catch-up fails, it is retried at longer intervals for as long as the chat
  stays open.
- Clearing a chat has `upToId`: only messages up to the last one the user has seen are deleted (for both
  people). A message that arrives during the 3-second Undo window stays. The `messages:bulk-deleted` event
  is also `{conversationId, upToId}`.

### Idempotent sending

Each message carries a random `clientId` (22 characters) from the client, and `(senderId, clientId)`
is unique in the database. If the send response is lost and the client sends again, no duplicate
message is created and the existing message is returned — or, if it was deleted in the meantime, its tombstone
(for the sender only, with `clientId`) so the client can drop the pending message.

### Reply and forward from the message itself

- A reply sends only `replyToId`; the quoted text is built by the **server** from the original message
  (it used to come from the client, and someone could "quote" made-up text under someone else's message). Nothing is
  quoted from a one-time message, someone else's locked capsule, or a deleted message.
- A forward sends only `forwardOf` (the message id); the server takes the text and "Forwarded from" from the
  original message (forwarding a forward keeps the original author). Only messages from
  chats the user is a member of; a one-time message or someone else's locked capsule cannot be forwarded.

### "Contacts only" privacy

When A adds someone, the chat also appears in B's list (a row the server creates on its own).
Previously, that same row counted as "a contact B chose"; so anyone could see someone's
"Contacts only" email, photo and last seen just by adding them. Now
`Contact.addedByOwner` decides: a row the server created does not count as a "contact" until its owner
adds it themselves (Add Contact → 200 instead of "already exists"), sends them a message, or gives it
a name.

### Live events (the important ones)

`message:new`, `message:edited`, `message:deleted`, `messages:bulk-deleted`,
`message:pinned`, `reaction:updated`, `message:seen {upToId}`,
`message:capsule:opened` (the whole message), `contact:upsert` (the full contact row),
`contact:removed`, `user:online/offline/updated`, `typing:start/stop`,
`session:ended`. Bulk delete and forward: `messages:delete` and `messages:forward`.

### Rate limiting

- HTTP: an overall API cap (`HTTP_RATE_MAX`).
- auth: only **failed** attempts are counted, per IP + account (`AUTH_RATE_MAX`);
  so a normal sign-up or logout is never locked out, but password guessing is.
- Actions: a "cost" budget per user (`SOCKET_RATE_MAX` per `SOCKET_RATE_WINDOW_MS`),
  **shared between the socket and REST** (send, forward, edit, delete, pin, clear chat, avatar
  upload, join). When the client hits the cap, it waits and sends again; no message is lost.
- auth: in addition to the "IP + account" cap, a 10× cap per IP alone (trying many
  accounts from one place). The account key is read from the same field that the endpoint
  uses (previously, changing a different field got you a fresh quota).
- Email verification code: each guess **atomically** consumes one attempt first; even 5 concurrent guesses cannot go past 5.
- API paths are rate-limited regardless of upper/lower case (`/API/...` is no longer a way around it).
- An IPv6 address is counted by its `/56` network (express-rate-limit 8): a home internet connection
  has a whole range of IPv6 addresses, and otherwise each of those addresses would get a fresh quota.
- `HTTP_RATE_MAX` / `AUTH_RATE_MAX` are at least 1 (zero means "reject everything", not "off");
  to turn off the HTTP cap: `ENABLE_HTTP_RATE_LIMITER=0`.

### Emails without leaking accounts

- `check-availability` only answers for usernames. For an email that already has an account, `send-code`
  sends a "You already have an account" email (with login and forgot-password links) instead of a code,
  and gives the usual response; so the sign-up form does not reveal who has an account.
- A password reset request (made without logging in) responds first and then does the work; the response
  time does not reveal anything either.
- The email regex is written so that it does not backtrack (previously a 60,000-character email
  locked up the server for ~3 seconds), and anything over 254 characters is rejected.

### Push

- Only addresses of the browsers' push services (Google/FCM, Mozilla, Apple, Windows;
  `PUSH_ALLOWED_HOSTS` to add more) are accepted, with https and the default port; previously any
  https address was accepted and the server sent requests to it (SSRF).
- One subscription per device (session), at most `PUSH_MAX_PER_USER` (20) per account. The test
  route `POST /api/push/send` was removed.

### Blocking and account deletion

- Someone who has been blocked cannot edit or pin their earlier messages, or clear the chat for
  the other person (sending and reacting were already blocked).
- Deleting an account also deletes the messages in Saved Messages (they used to stay on the server).

---

## 4. Chat client

### Layers

```
UI (React)  ──reads──▶  stores  ◀──writes──  services  ◀──▶  server (HTTP + Socket)
     │                                          ▲
     └──────────────── calls (actions) ─────────┘
```

- **stores** (`state/stores.ts`): several small, independent stores, each scoped to how often
  it changes: `session`, `contacts` (rows keyed by conversationId), `chats` (each chat's message
  cache), `outbox` (messages being sent), `typing`, `connection`, `ui`, `composers`
  (each chat's draft), `undoing`, `toasts`, `notices`. Result: typing one character does not re-render the contact
  list, and an incoming "typing..." does not re-render the messages.
- `createStore` + `useStore(store, selector)` are built on `useSyncExternalStore`;
  a component re-renders only when the output of its own selector changes.
- **Models** (`chatModel.ts`, `contactModel.ts`): pure, testable functions for merging
  messages, chat placement rules, and sorting. Every change to a contact row gets a sequence number; a full
  list that was requested before a live change does not overwrite that change.
- **services**: the only places that have side effects.

### Message merge rules (chatModel)

- The version with the newer `updatedAt` wins (a late event does not overwrite newer data).
- `isSeen` and capsule opening only move forward.
- A deleted message is remembered in `gone` so that an old event does not bring it back.
- At most 12 chats are kept in memory (LRU; the open chat is never evicted).

### Send queue (outbox)

- Every message first goes into the outbox (with `clientId`) and appears in the chat immediately.
- A sequential sender sends the messages in the same order; offline → wait,
  rate limit → wait a few seconds and retry, real error (e.g. blocked) → "failed" with
  Retry / Copy / Delete buttons.
- The outbox is saved in localStorage per user: a refresh or closing the tab does not lose the message
  either. It is cleared on logout. Several tabs open at once do not delete each other's unsent messages
  (they are merged by `clientId`).
- If the connection drops mid-send, the request fails right away (not 10 seconds later), and
  the message goes out again in the same order.
- After every reconnect, nothing is sent from the outbox until the server confirms that the same account is still
  logged in (if you have logged in with a different account in another tab, the page reloads).

### Undo

Deleting a message/chat/contact first only hides it, and a Toast with "Undo" appears; after 3 seconds
the server is told. If the page is closed in the meantime, the request is still sent
with `keepalive`.

### The phone's Back button

Each layer (chat, panel, dialog, menu, search, All contacts) has a history entry
(`backStack.ts`). Back closes the topmost layer, not the whole app; closing from inside the UI also
removes its entry. History changes are queued because `history.go` is asynchronous.

### Seen

A message becomes seen when it has actually been visible on screen (IntersectionObserver), the page
is visible, and the connection is up. The server is sent `upToId`, not "mark everything seen";
so a message that has just arrived and has not been seen does not become seen.

### Chat placement (same rules as before)

- **Active Chats**: Saved Messages, pinned chats, the open chat, chats with unread messages,
  a chat where a message from me is being sent or my last message has not been seen yet.
- **Contacts**: the rest (first those with messages, by recency, then those without messages, blocked ones last).
- **Archived**: only in Settings → Archived Chats.

### Keyboard access

Everything is reachable with Tab, and focus is visible. In the message list: ↑/↓ moves between messages,
Enter or the Menu key = message menu, Esc = close (Enter on a link or quote inside a message does
that element's own action). On an Active Chat card: ←/→ reveals the buttons, like a swipe.

### Dialogs and toasts

Dialogs are native `<dialog>` elements with `showModal()` (the rest of the page becomes inert). Toasts
are shown inside the topmost open dialog, as a popover in the top layer (`TopLayer`),
so they are visible and clickable on top of the dialog. Escape in a nested dialog closes only that dialog.

### Theme

`boot/theme.ts` applies the `dark-mode` class on `<html>`, the accent color and the wallpaper before the first paint
(without an inline script, so it is CSP-compatible); so no white flash is ever
seen. The wallpaper is downscaled to a JPEG of at most 1600 pixels before it is saved.

---

## 5. Build

- **esbuild** with ESM and code splitting: React is downloaded once and cached across pages;
  the emoji picker is loaded only when it is opened for the first time.
- All file names in `public/app/` include a content hash → the server caches them as `immutable`,
  and each new build replaces them automatically.
- The pages' HTML is generated with the file names from the same build (`pages.mjs`) + `modulepreload`.
- landing and privacy are rendered to full HTML at build time with `react-dom/server`
  (for SEO and instant display) and are hydrated in the browser.
- The service worker is built with a version derived from the file hashes; every build = a new version.

---

## 6. What changed or was fixed

### Client (full rewrite with React + TypeScript)

- **Sync**: a message/edit/deletion that happened while the internet was down is no longer lost.
- **Offline sending**: the message stays in the queue, is delivered after reconnecting (even after a refresh), and is not duplicated.
- **Accurate Seen** (previously a message that arrived at that very moment was also marked seen).
- The phone's **Back** button works correctly everywhere.
- Long-press message menu: lifting the finger used to sometimes "click" one of the options;
  now that click is ignored.
- **Settings → Devices** (new), Notifications (on/off), a countdown on "Send reset email".
- A custom cropper (cropperjs removed), gsap removed, browser Sentry (which was never active) removed.
- The auth page overflowed on phones; fixed. The reset page now looks like the rest of the app
  and removes the token from the address bar.
- The user's email is no longer stored in localStorage.
- CSS: `rgbaa` (the profile gradient did not work), the Add button with no color in Add Contact
  (undefined variables), the ring around the selected accent color that was not visible, a broken rule
  in active-chats, the fragile `.contact-actions :nth-child`, hovers on phones,
  the trapezoid-shaped pink bar in the delete preview, a global `outline: none` (keyboard focus
  was not visible), a global `scroll-behavior: smooth` that broke programmatic scrolling.
- Cards that had buttons inside them (a button inside a button) were fixed for screen readers.
- Second review (client): catch-up on a phone that was asleep, a message stuck on "sending",
  message order after reconnecting, multi-tab outbox, sending as another account after
  the account was switched in another tab, deleting a message that arrived during the "delete chat" Undo, the contact list
  wiping out live changes, toasts behind dialogs, Escape in the cropper closing Edit Profile,
  Enter on a link inside a message, a tap registering after a swipe, the list jumping
  while older messages load, two emails from double-clicking Resend.
- landing: false claims corrected ("even we can't read the messages",
  "Instant Chat without an account", "Scheduled messages", "Full offline support",
  "100ms latency"); the privacy text now matches the server's actual behavior; the custom
  mouse cursor replaces the system cursor only when a mouse is used and JS has run; selecting text on the page
  is possible again; Poppins is loaded from the site itself.

### Server

- Real sessions, signed CSRF, password change without logging out the current device, Devices.
- The `/changes` protocol, `clientId`, `updatedAt`, `message:seen {upToId}`, bulk delete/forward.
- `.env` is loaded before any import (previously VAPID worked by accident).
- The same CSP in dev and production, HSTS in production, correct cache headers (`/app` immutable,
  HTML and SW not cached).
- Extra mounts (`/src`, `/node_modules`, ...) removed.
- The login rate limit counts only failed attempts.
- The join/seen race on the socket (seen was processed before join) was serialized.
- Second review (security): ReDoS in the email check, bypassing the rate limit with `/API`, the
  "Contacts only" privacy that could be bypassed by adding someone, leaking accounts through sign-up and
  reset timing, SSRF via push subscriptions, concurrent brute-forcing of the email code, REST actions outside the budget,
  editing/pinning/clearing a chat despite a block, forged quotes and "Forwarded from", Saved
  Messages left over after account deletion, unlimited fields/pixels in avatar uploads,
  forged `X-Forwarded-For` on the socket — details in section 3.
- The `server/scripts` tools (now TypeScript): `rotate-keys` and `push-keks` did not read `.env`
  at all (the keys and the Vault address stayed empty); if a message was edited in the middle of a key rotation,
  the rotation wrote the old DEK over it and that message could no longer be decrypted, and it changed the `updatedAt`
  of every message (every device fetched all messages again); `push-keks`
  deleted the other secrets at the same Vault path, and if reading from Vault failed, it overwrote
  all of them; with `SECRET_PROVIDER=vault` some scripts never finished;
  the catch-all `KEK` key could silently take the place of `KEK_V2`; the encryption "test" finished as successful
  even when there was an error.
- Things the shared contract caught: `contact:upsert` sent `null` if the row was deleted mid-operation
  (and a 200 response with an empty body); `message:capsule:opened` sometimes lacked `text`;
  a single bad `lastSeen` stopped all online/offline announcements.

### Cleanup, dependencies, tests

- **Compatibility code for the first version of the app was removed** (Rivo has not been released yet, so no old
  client exists): the list is in section 3 → Contract. Along with it: push subscriptions without a session, creating
  Saved Messages for old accounts every time the list was loaded (both now happen once in the
  new migration; sign-up and seed create Saved Messages themselves), and
  `DEFAULT_CONVERSATIONS_TAKE` / `MAX_CONVERSATIONS_TAKE`.
- **Dependencies at their current versions** (with their breaking changes):

  | Package | From → to | What changed |
  |---|---|---|
  | helmet | 6 → 8 | HSTS is in `helmet()` itself (production only); COEP is off by default |
  | express-rate-limit | 6 → 8 | `max` → `limit`; IPv6 by `/56` (`ipKeyGenerator`); a cap of 0 no longer means "off" |
  | nodemailer | 6 → 10 | Now written in TypeScript and ships its own types (`@types/nodemailer` removed); Node 20+ |
  | sharp | 0.32 → 0.35 | `autoOrient()` instead of `rotate()` with no arguments; Node 20.9+ |
  | @sentry/node | 7 → 11 | `Handlers` was removed: Sentry starts in `server/instrument.ts`, before Express (`--import`), and catches Express errors on its own; the data sent along with errors was limited (section 9) |
  | dotenv | 17 → 18 | `quiet: true` (the "injected env" message no longer appears in the log) |

  Prisma 7 was done separately (below).
- **Bugs found and fixed during this work:**
  - `npm run dev` ran the server with **ts-node** (nodemon calls ts-node by itself for `.ts` files,
    and ts-node is not in the project) and did not restart on changes to `shared/` either.
    Now the command is explicit (`--exec "node --import ./server/instrument.ts"`).
  - `npm run db:backup` / `db:restore` broke when the settings came from `.env`:
    dotenv 17 printed an "injected env" line to the output, and that line was read as part of the database URL and
    the backup folder.
  - A chat that opened at the "unread messages" position, near the top of the list, **never** loaded
    its older messages (a list that is already at the top gets no scroll event); the same happened if the user
    scrolled to the top in the first moment after the chat opened.
  - A tap on a chat or message was ignored for up to 0.6 seconds after a finger swipe
    (the guard against the click at the end of a **mouse** drag was also active for fingers).
  - (Also as part of the same work: a page of older messages that fails to load — no internet — is no longer
    automatically requested again and again; it is retried on the user's next scroll.)
  - **Profile picture upload was always rejected** ("Only images are allowed"). The `parts: 1` limit
    that earlier hardening had added to multer is reported by busboy the moment the limit is *reached*,
    so the only allowed part (the picture itself) was rejected too. The earlier tests ran with a substitute multer
    and did not reveal this; the first e2e run on a real system found it.
    Now: no `parts` (`files: 1` and `fields: 0` are enough on their own), the picture is received **in memory**
    (5 MB; an unprocessed temporary file no longer stays in the public folder, and it no longer gets locked
    on Windows), the final JPEG is written directly under its final name (no rename), and every
    rejection case has its own correct message. An api test was added for this path.
  - **Log Out changed the page twice**: "session:ended" from the live connection usually arrives before
    the response to the logout request itself, and both paths navigated to `/auth/` separately; the first navigation
    was cut off midway (`ERR_ABORTED`). Account deletion had the same problem. Now ending the session is a single
    action that happens only once (`finish()` in `client/chat/services/session.ts`).
- **Tests**: all TypeScript and checked against the contract; browser scenarios went from 10 to 37
  (section 7); a test for actually sending email over SMTP (for nodemailer), security headers (for helmet),
  and picture upload (for multer and sharp). Several browser tests that only passed on a fast
  machine were fixed (they checked the server before its response arrived, or watched a half-second highlight
  at one-second intervals), and dropping the connection in tests now also blocks Socket.IO's second path
  (long polling over HTTP).

### Prisma 7

- **Why:** Prisma 6 only gets security patches until November 19, 2026. 7 is the current stable version and
  is supported until 18 months after Prisma 8 is released.
- **The generated client** is no longer inside `node_modules`: the new `prisma-client` generator
  builds it in `server/generated/prisma`, as TypeScript and ES modules with `.ts`
  imports, which Node runs directly like the rest of the server. It is not in git; `npm install`
  (`postinstall`) and `npx prisma generate` build it.
- **Connection through a driver adapter:** `@prisma/adapter-pg` on top of `pg` (node-postgres), in
  `server/prisma.ts`. Differences from Prisma 6:
  - Pool size is set with `DATABASE_POOL_MAX` (default 10). `connection_limit` in the URL
    no longer has any effect.
  - Waiting to connect, or for a free connection, takes at most 10 seconds (pg on its own waits forever;
    Prisma 6 waited 5 seconds to connect and 10 seconds for a free connection, and pg has a single limit for both).
  - The URL's `?schema=` is still respected: Prisma's own queries get it from the adapter, and hand-written
    SQL (`$queryRaw`…) gets it from the connection's `search_path`.
  - **SSL:** Prisma 6 tried TLS by default and did not verify the certificate. Without
    `sslmode` in the URL, pg does not use TLS at all, and with `sslmode=require` it fully verifies the certificate.
    So for a database on another server that requires TLS: `?sslmode=require` in `DATABASE_URL`,
    and if its certificate is self-issued, provide its CA with `NODE_EXTRA_CA_CERTS` (do not turn verification off).
    A database on the same server (localhost) does not need TLS.
- **Settings for the `prisma` command** are in `prisma.config.ts`; the database URL is no longer in `schema.prisma`,
  and Prisma no longer reads `.env` itself (the config does; `DATABASE_URL` from the environment takes
  precedence over `.env`, which is how the tests supply the test database).
- `prisma migrate dev` no longer runs `generate` (section 1 → Migrations).
- Tests connect to the test database with the server's own `createPrismaClient`; CI has no separate
  `prisma generate` step (`npm ci` does it).
- Errors are the same: a duplicate is still `P2002` (`codeOf(e)`).

### Landing without Google Fonts

- The Syne font (headings on the landing and privacy pages) now comes from the server itself:
  `public/assets/fonts/Syne/Syne-wght-latin.woff2`, a single variable file for all weights from
  400 to 800, with only the Latin characters the pages use (39 KB; the OFL license sits next to it). It used to come from
  Google Fonts: every visit made a request to Google, and when Google was slow or unreachable
  (which happens a lot from Iran), the page waited for it.
- The Content-Security-Policy no longer allows `fonts.googleapis.com` and `fonts.gstatic.com`.
- The privacy page now says that neither the app nor these pages load anything from another company; the landing
  browser test checks exactly this (no request goes to another server, and Syne actually loaded).
- If the heading text gets a character outside Latin, only that character is shown in the fallback font;
  to add characters, the file is subset again from `Syne[wght].ttf` (the google/fonts repository) with
  fontTools.

### Dependency audit (npm audit)

- `npm audit fix` (without `--force`) moved the affected packages to fixed versions within the ranges
  `package.json` allows; only `package-lock.json` changed.
- What is left was reviewed and accepted. None of it can be reached by anything a user sends:

  | Package | Comes from | Why it is accepted |
  |---|---|---|
  | deepmerge-ts | `prisma` (the command) → `@prisma/config` | It only merges Prisma's defaults with our own `prisma.config.ts` when a `prisma` command runs (`migrate`, `generate`). The running server never loads it, and no outside input reaches it |
  | mysql2 | `prisma` (the command) | Prisma's driver for MySQL databases. Rivo uses PostgreSQL: it is installed but never loaded |
  | braces (through chokidar) | `nodemon` (development only) | The file watcher of `npm run dev`, matching our own folder names. The server never runs it, and there is no fixed version for nodemon's line yet |

- `npm audit fix --force` is not used: it gets rid of a finding by installing a different major version
  of a package, which is a breaking change made without anyone choosing it.
- After every dependency update: `npm audit`. `npm audit --omit=dev` shows only what a production install
  gets (the first two stay there: production needs the `prisma` command for `migrate deploy`). A new
  finding gets the same review: can a user's input reach it, and is there a fixed version within range?

### Load test

- `npm run loadtest`: many people chatting at once on a test server, measured (section 7 → Load test).
- Its only server change: the server answers a `stats` message on the IPC channel of the process that
  started it (`server/utils/processStats.ts`). Nothing new is exposed on the network.

---

## 7. Tests

Three suites, all in the repo, all **TypeScript**, and all run on every push to GitHub (section 8):

| Suite | Where | What | Requires |
|---|---|---|---|
| **unit** | `tests/unit/*.test.ts` | Pure client logic: merging messages, chat placement and order, previews, a contact list that does not wipe out live changes, multi-tab outbox, links (and that `javascript:` never becomes a link), accent color; and the input schemas (`shared/schemas`: what is accepted, in what form, and with what message a bad input is answered) — 34 tests | Nothing (a few seconds) |
| **api** | `tests/api/*.test.ts` | The real server on a test database: sessions, CSRF, devices, password, sign-up, contacts and privacy, idempotent sending, seen, sync, delete/forward, capsules, one-time messages, rate limits, push, health, security headers, profile picture upload (real multer and sharp: the server's own JPEG, deletion of the previous picture, rejection of anything else with its reason), **actually sending email over SMTP** (to a small SMTP server inside the test), database constraints, bad inputs through both paths (socket and REST) that are rejected with the schema's message and change nothing; and the `server/scripts` tools (key rotation from start to finish with separate `t1`→`t2` keys that only moves the test's own messages, reading all messages, `test:enc`, `check-kek`) — 42 tests | `TEST_DATABASE_URL` |
| **e2e** | `tests/e2e/*.spec.ts` | The built app in Chromium — 37 tests in six files: `auth` (sign-up with a code and per-field errors, wrong code, wrong password, forgot password all the way to logging in with the new password, landing), `chat` (live two-person chat, older pages back to the first message, reactions and pins, forwarding, multi-select, the banner for a message in another chat, **internet disconnect and reconnect**, the send queue after a refresh, sending faster than the cap), `features` (one-time messages, capsules, the pinned list, All contacts, Undo of contact deletion, blocking), `panels` (settings, devices, password change, adding a contact, contact profile and archive, search, profile picture, account deletion), `phone` (pages and Back, long-press and swipe with a finger), `ui` (toast over a dialog, keyboard) | `TEST_DATABASE_URL` + `npm run build` |

### Running locally

```bash
# once: a database just for tests (its name must contain "test"; the tests write to it)
createdb rivo_test
# in .env (or in the environment):
TEST_DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/rivo_test"

npm run test:unit
npm run test:api                     # applies the test database's migrations itself
npx playwright install chromium      # once, and again after an npm install that upgraded Playwright (if it fails: system Chrome/Edge, see below)
npm run build && npm run test:e2e
npm run test:e2e -- -g "offline"     # just one test
```

- Test servers start with their own settings (a separate key, fast password hashing, relaxed rate limits)
  and take only `TEST_DATABASE_URL` from your `.env`; they do not touch Vault, SMTP or the main database.
- Emails (verification code, reset link) are not actually sent in tests: with
  `MAIL_CAPTURE_FILE`, the server writes them to a file and the test reads them from there. In
  production, the server **does not start at all** with this variable set.
- If the database name does not contain "test", the tests do not run (this prevents real data from being deleted by mistake).
- **Browser:** each Playwright version needs its own Chromium build (the same one CI
  uses). If it is not installed, for example when downloading it from cdn.playwright.dev does not respond,
  `test:e2e` runs with the Chrome or Edge installed on the system (the engine is the same, and Playwright
  controls it the same way; Edge is always present on Windows) and prints one line saying which one
  it used. If neither is present, it says so before starting and shows `npx playwright install chromium`.
  With `E2E_CHANNEL=msedge` (or `chrome`) you can pick one yourself.
  - Downloading behind a filter or proxy: `set HTTPS_PROXY=http://127.0.0.1:PORT` (your proxy's HTTP port)
    and, for slow internet, `set PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=300000`, then
    `npx playwright install chromium`.
- Internet disconnects in e2e are real: the live connection (WebSocket) goes through Playwright, and the test
  closes it and keeps rejecting it until it is time to reconnect (the browser's offline mode alone does not close an open WebSocket).
  Socket.IO's second path is blocked too: the connection starts with ordinary HTTP requests (long polling,
  `/socket.io/?transport=polling`) and then moves to WebSocket; without blocking that path,
  a page that still has HTTP would reconnect through it.
- **Slow server:** `E2E_API_DELAY=300 npm run test:e2e` (in Windows cmd: `set E2E_API_DELAY=300`, then
  `npm run test:e2e`) delivers every API response 300 milliseconds
  later (for pages opened with the `support/app.ts` helpers), like a slower
  machine or a real database under load. A test that only passes on a fast machine fails here;
  rule: watch server state with `expect.poll`, not with a single read right after a click.
- The finger on the phone is real too: `finger()` in `tests/e2e/support/app.ts` sends touch events
  from the browser itself (long press, drag, tap), the same way a touchscreen does (Chromium only).
- **Other browsers:** with `E2E_ALL_BROWSERS=1`, the tests also run in Firefox and WebKit
  (`npm run test:e2e -- --project=firefox --project=webkit`). CI does this (section 8); you do not need to on
  your own machine (their browsers are downloaded separately).
- **Types:** the tests are checked in `npm run typecheck` with `tests/tsconfig.json` (and the unit tests with `tests/unit/tsconfig.json`).
  Node runs them as they are (it strips the types),
  and Playwright compiles them itself; they have no separate build. Name the endpoint in a test
  so its response gets a type; a deliberately wrong request (`requestRaw`, `req`) stays untyped.
- Each browser test closes the contexts it opened when it finishes (`test` from `support/app.ts`);
  a failure screenshot shows only that test's pages.

### Manual test against a running server

`tests/integration/socket-flow.ts` checks 15 things against a real running server and two existing accounts
(login, CSRF, send, edit, quote, pin, seen, `/changes`, delete, logout).
It uses the same typed client as the api tests:

```bash
TEST_SERVER_URL=http://localhost:3000 \
TEST_USER_A=alice TEST_PASS_A=... TEST_USER_B=bob TEST_PASS_B=... \
npm run test:integration
```

> Run it with two test accounts, not real accounts: it sends two messages in their conversation (and
> then deletes them).

### Load test

`npm run loadtest` measures how Rivo holds up with many people chatting at once: how long a message
takes to reach the other person, what fails, and what it costs the server. It is not a pass/fail suite
(it is not part of `npm test` or CI): it measures, and you compare runs.

```bash
npm run loadtest                                     # 50, 100, 200, 400 people; 30 s each (a few minutes)
npm run loadtest -- --stages 20,40 --seconds 15      # a quick one
npm run loadtest -- --interval 5                     # busier people: a message every 5 s each
npm run loadtest -- --compare load-reports/load-2026-10-07-09-30-00.json
npm run loadtest -- --help
```

**What it does**

- It starts its own server on the test database, as the api tests do (`TEST_DATABASE_URL`, migrations
  brought up to date first), with production's per-person limit (`SOCKET_RATE_MAX`: 20 actions per
  10 seconds) and only warnings and errors in the log.
- It creates the accounts the real way (code by email, sign-up, login) and pairs them: each pair is a
  one-to-one chat.
- Stages: each one brings more people online (each on their own WebSocket, with the chat open), waits two
  seconds, then measures for `--seconds`. Each person, every `--interval` seconds on average (10 by
  default; the gaps are random, people do not take turns): `typing:start`, one to two seconds of typing,
  `typing:stop`, `message:send`. A received message is read 0.3 to 1.5 seconds later (`message:seen`), as
  the app does with the chat on screen.
- After each stage, sending stops and messages still on their way get up to 5 seconds to arrive.
- The load is roughly people ÷ interval messages per second: 400 people at 10 s ≈ 40 messages per second,
  plus as many typing events and reads.

**Reading the table** (one column per stage)

| Row | Meaning |
|---|---|
| messages / s | Messages the server stored per second |
| send → answer | From sending to the server's answer (the message is stored) |
| send → delivered p50 / p95 / p99 / max | From sending to arriving on the other person's connection: **what people feel**. p95 = 95% of the messages arrived faster than this |
| seen → answer | Marking as read |
| coming online p95 | The WebSocket handshake, with its session check |
| failed / lost / dropped | Sends the server refused or did not answer within 10 seconds (the reasons are listed under the table); messages stored but never delivered; connections that broke or could not be made. All three should be 0 |
| server CPU | The server process, one core = 100% |
| server event loop busy | How much of the time the server's one JavaScript thread was working. Close to 100%, every event waits for the ones before it and delivery times climb steeply: that is the ceiling of a single process |
| server event loop delay p99 | How late the event loop got to a timer: what each event waits on top of its own work. Windows' timers fire only every ~15.6 ms, so there it is only that exact (the table says so under it); "event loop busy" is exact everywhere |
| server memory (RSS) | At the end of the stage |
| load generator CPU | The test's own process (the people) |
| verdict | `smooth` (95% delivered within 200 ms), `at the limit` (still that fast, but the event loop is busy 90% of the time or more), `noticeable` (within 1 second), `too slow`, or `errors` |

**Reports:** each run writes the same figures as JSON to `load-reports/load-<date>.json` (not in git),
with the computer, the commit and the settings. `--compare <an earlier report>` puts its figures next to
these (old → new and the change in %, lower is better), for the stages with the same number of people:
for example before and after a change to the server, or with `DATABASE_POOL_MAX=20` against the default 10
(the load test's server takes it from the command's environment, not from `.env`: in Windows cmd,
`set DATABASE_POOL_MAX=20`, then `npm run loadtest`; the report records it).

**Things to keep in mind**

- **One computer:** run locally, the people (the test's process), the server and PostgreSQL share the CPU
  and take it from each other. If "load generator CPU" is high, the test itself is part of the load. The
  figures are that computer's: compare runs on the same computer, and for the real ceiling, run it on a
  machine like the production server.
- The server's own figures (CPU, memory, event loop) come from the server process itself, asked over the
  IPC channel that the test's process opened when it started it (`server/utils/processStats.ts`, the
  `stats` message in `server/index.ts`). Only the process that started the server can ask; nothing is
  exposed on the network.
- Every run leaves its accounts in the test database (400 by default), like the api tests do. To start
  it empty: `dropdb rivo_test` and `createdb rivo_test`; the next test run applies the migrations.
- Ctrl+C stops it: it reports the stages it finished and stops its server.
- If the server logged warnings or errors during the run, the first ten lines are printed at the end.

---

## 8. CI (GitHub Actions)

`.github/workflows/ci.yml` runs four jobs in parallel on every push and every Pull Request:

| Job | What it does |
|---|---|
| **checks** | `npm ci` → typecheck (app, server, tests) → lint → unit → build |
| **api** | A fresh PostgreSQL 16 starts alongside the job → migrations → api tests |
| **e2e** | The same database + Chromium → build → browser tests; if something fails, screenshots and traces are saved as artifacts |
| **e2e-more** | The same browser tests in **Firefox** and **WebKit** (Safari's engine). The two finger-gesture tests (`finger()`) run only in Chromium: the finger is moved through Chromium's own DevTools, which the other two do not have |

- `npm ci` also builds the database client (`postinstall` → `prisma generate`).
- `npm ci` installs exactly the versions in `package-lock.json`, so **the lock file must be in sync with
  `package.json` and committed** (after every dependency change: `npm install` and commit the lock file).
- **Protecting main** (once, on GitHub, after the first CI run): Settings → Branches →
  Add branch protection rule (or Settings → Rules → Rulesets) for `main` → "Require status
  checks to pass before merging", and select the four jobs `Types, lint, unit tests, build`,
  `API tests (PostgreSQL)`, `Browser tests (Chromium)` and `Browser tests (Firefox, WebKit)`. From then on, nothing whose
  tests are red gets into main (changes go through branches and Pull Requests).
- The result of each run: the repo's **Actions** tab. Click a red job to see the failed step and its log.

---

## 9. Operations (running server)

### Health check

`GET /api/health` → `200 {"status":"ok","db":"ok","dbMs":…,"uptime":…,"version":…}`
when the server and the database respond; `503` when the database does not respond (it waits at most 2
seconds) or the server is shutting down. The response is cached for one second, so a flood of health requests
does not turn into a flood of queries. For monitoring: have an uptime service (such as UptimeRobot, which is free) call
`https://<domain>/api/health` every minute and send an email/message if the response is not 200.

### Logs

`server/utils/logger.ts`. In production, each line is a JSON object:

```json
{"time":"2026-10-07T09:01:22.545Z","level":"info","msg":"http","reqId":"9fa4bb92-7ab5","userId":12,"details":{"method":"POST","path":"/api/messages","status":201,"ms":14.2}}
```

- Every request has a `reqId`, which is also returned in the response header (`X-Request-Id`). If a proxy
  (such as nginx) sends its own id, that id is kept; so nginx's logs and Rivo's logs can be linked to each other.
- Every line written while handling a request or socket event carries its `reqId`/`userId`
  automatically (no manual passing, via AsyncLocalStorage).
- The query string is not logged (it may contain a token); request bodies are never logged either.
- `LOG_LEVEL` (debug/info/warn/error) and `LOG_FORMAT` (json/pretty). Human-readable in development.
- Searching: `journalctl -u rivo -o cat | jq 'select(.level=="error")'` or
  `… | jq 'select(.reqId=="9fa4bb92-7ab5")'`.

### Error reporting (Sentry)

With `SENTRY_DSN` in `.env`, server errors go to Sentry; without it, Sentry is not loaded at all.

- Sentry must start **before Express** to see the errors that reach Express; that is why it
  lives in `server/instrument.ts` and is run with `node --import ./server/instrument.ts server/index.ts`
  (`npm start` and `npm run dev` do this). If you run the server without it
  while `SENTRY_DSN` is set, the startup log shows a warning.
- systemd / pm2: the same `npm start` command (or `node --import ./server/instrument.ts server/index.ts`).
- What is sent with an error: the message and stack, the request path, a few harmless headers (`user-agent`,
  `content-type`, …). **Not sent:** cookies (the session), request and response bodies (passwords, message text),
  the query string (searches), variable values, IP address and user identity, database query data.
  (Sentry 11 sends all of these by default; `dataCollection` in instrument.ts prevents that.)
- Shutting down (`SIGTERM`, or an error that brings the server down) first sends whatever is queued for Sentry (up to 2 seconds).

### Graceful shutdown

On `SIGTERM` (restart, deploy): health immediately becomes 503, new connections are not accepted,
in-flight requests finish, sockets are disconnected (clients reconnect to the new process
on their own), and the database connection is closed; at most 10 seconds. An error that was not caught
anywhere is logged with its full stack; an exception outside a promise shuts the server down (cleanly) so that
the process manager (systemd/pm2) brings it back up.

Windows has no `SIGTERM` signal (there, closing a process means it ends immediately). So the server also
performs the same graceful shutdown when it gets a `"shutdown"` message over the IPC channel: pm2 with
`shutdown_with_message: true`, and the test servers (which is why they also shut down cleanly on Windows).

### Backup

```bash
npm run db:backup     # = scripts/backup-db.sh
```

- A compressed `pg_dump` in `backups/rivo-<date>.dump` + profile pictures in `…-avatars.tar.gz`.
- Each backup is read once right away (`pg_restore --list`) so that a corrupt file is caught
  then, not on the day of disaster. It is readable only by the same system user. Backups older than 14 days
  (`BACKUP_KEEP_DAYS`) are deleted. Folder: `BACKUP_DIR`.
- Every night at 3:30 (`crontab -e`):
  `30 3 * * * cd /path/to/Rivo && bash scripts/backup-db.sh >> backups/backup.log 2>&1`
- Requires: `pg_dump`/`pg_restore` of the same version as the Postgres server (`apt install postgresql-client-16`).
- ⚠️ Messages in the database are encrypted with the keys in `.env` (`KEK_V1` …): **a backup cannot be read without those
  keys.** Keep a copy of `.env` somewhere safe and separate from the backups.
- A copy of the backups must also be kept outside that server (another disk, cloud storage); a backup that
  is lost along with the server is useless.

### Restore drill (once a month)

A backup that has never been restored does not count as a backup:

```bash
createdb rivo_restore_test          # once
RESTORE_DATABASE_URL="postgresql://USER:PASS@localhost:5432/rivo_restore_test" \
  npm run db:restore -- backups/rivo-20261007-033000.dump
# → restored … / 1234 users, 56789 messages, last migration: …
```

A real restore onto the main database (shut the server down first; you have to type the database name):
`npm run db:restore -- backups/rivo-….dump --into-live`

### Database constraints (third migration)

| Constraint | Before | Now |
|---|---|---|
| Each person once in anyone's list | In-memory lock (single process only) | unique index; a concurrent second request → 409 |
| One Saved Messages per user | Check in code | unique index |
| Each member once per chat | Code ignored duplicates | unique index |

Existing duplicate rows are cleaned up before the constraint is created (**no message is deleted**):
a duplicate member is removed; an extra Saved Messages is merged, along with its messages, into the oldest one; of two rows for the same
person, the one whose chat was used most recently is kept (the other chat's messages stay on the server).
`npm run db:check` before migrating shows exactly what (if anything) will be cleaned up.

---

## 10. Suggestions for next steps

- End-to-end encryption (for now, encryption is server-side and at rest).
- Sending pictures/files in chat.
- Push notifications for reactions on group messages (once groups are added).
- The server is designed for **a single Node process**: the list of connected sockets, the conversation member cache and
  the rate-limit counters are in memory (contact uniqueness is now guaranteed by the database itself).
  To run several instances behind a load balancer, these must first move to a shared store (e.g. Redis +
  the Socket.IO Redis adapter).
- The load test on a machine like the production server (section 7 → Load test), to find the real
  ceiling of a single process before it is reached.
