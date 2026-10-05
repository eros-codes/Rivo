# Server notes

The current architecture, upgrade steps and protocol are described in
`docs/ARCHITECTURE.md`. This file used to describe an older change
(a `participantsKey` upsert and a `passwordChangedAt` cache) that the
code no longer uses; the column is still in the schema but nothing
depends on it.

## Migrations

- Production / any database with real data: `npx prisma migrate deploy`.
  It only applies the migrations in `prisma/migrations` that have not
  run yet.
- Never run `npx prisma migrate dev` against a real database: it can
  ask to reset the database.
- Do not edit a migration that has already been applied anywhere;
  Prisma compares checksums and will refuse to continue. Add a new one.

## Running more than one server process

The server keeps some state in memory: who is connected (sockets per
user), short caches of conversation members, the lock that stops two
"add contact" requests for the same pair from racing, and the rate
limit counters. That is correct for one Node process. To run several
behind a load balancer, these need a shared store first (for example
Redis and the Socket.IO Redis adapter).
