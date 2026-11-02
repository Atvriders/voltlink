# Architecture decisions

Decision log for VoltLink. Each AD is a choice we made on purpose, with the
reason and the trade-off.

## AD-01 — Monorepo, strict TypeScript everywhere

One npm workspace tree (`packages/shared`, `apps/api`, `apps/web`) with
`strict` + `noUncheckedIndexedAccess`. The shared package is the single source
of truth for domain contracts (roles, vehicles, commands, history,
automations, fleet, API DTOs).

## AD-02 — Express 5 + Prisma + PostgreSQL

Express 5 for the API; Prisma 6 over PostgreSQL with `Timestamptz(3)` columns
everywhere (fixes timezone drift in queue scheduling). Telemetry rows live in
a **time-partitioned** table with a `voltlink_ensure_partition()` boot guard.

## AD-03 — Cookie sessions + CSRF, not bearer tokens

Sessions are `HttpOnly SameSite=Lax` cookies with server-side records and
hashed tokens; mutating requests carry a double-submit CSRF header. This keeps
the SPA simple and XSS-resistant, and enables SSE auth.

## AD-04 — Argon2id, TOTP, WebAuthn, step-up

Argon2id for passwords; TOTP and passkeys as second factors; **step-up
authentication** gates high-risk vehicle commands rather than blocking every
command behind 2FA.

## AD-05 — Envelope encryption for provider credentials

AES-256-GCM payload encryption with a random DEK wrapped by `VL_MASTER_KEY`;
envelopes carry a key version for rotation. Never store provider tokens in
plaintext.

## AD-06 — Provider interface with four implementations

`VehicleProvider` abstracts state fetch + command dispatch. Implementations:
Tesla Fleet API (official), Tessie (optional adapter), Demo (deterministic
seeded simulator), Mock (scriptable). The rest of the platform is
provider-agnostic.

## AD-07 — Explicit command lifecycle

Commands are persisted entities with
`queued → submitted → accepted → confirmed` and the failure terminal states.
A worker stages dispatch and confirmation (observation window ~60 s), with a
full audit trail.

## AD-08 — esbuild CJS bundles for the API

`node build.mjs` runs `tsc --noEmit` (type gate) then bundles each role to
CommonJS (`dist/*.cjs`). ESM output breaks Express's dynamic `require("tty")`;
CJS avoids the problem while keeping ESM source.

## AD-09 — SSE with polling fallback

Per-user SSE on `/api/v1/realtime` publishes vehicle events; the SPA falls
back to polling when SSE fails (proxies, scaling). Rate limits skip the SSE
endpoint.

## AD-10 — PostgreSQL-backed queue with Redis option

`JobQueue` interface with `PgQueue` (`FOR UPDATE SKIP LOCKED`) and
`RedisQueue` (lists + zsets). Local dev has no Redis; production compose runs
Redis.

## AD-11 — Sleep-aware telemetry polling

The scheduler computes next-poll times from vehicle sleep state, so sleeping
vehicles aren't woken by polling. Poll jobs flow through the same queue as
command jobs.

## AD-12 — Original Blender GLB assets with LODs

Five vehicle classes generated headlessly (no third-party meshes). Each class
ships a full and a `_lod` GLB; the viewer selects by graphics preset and
degrades to a procedural silhouette.

## AD-13 — React 19 + Vite + Tailwind 4, five themes

Theme tokens are CSS variables; five themes include high-contrast and
colorblind-safe variants. MapLibre for the offline fictional map, R3F for
WebGL.

## AD-14 — Status platform in-process

Public status runs as an independent route set (page, RSS, badge,
subscriptions) backed by the same database; a dedicated `status` role serves
it standalone for availability during API incidents.

## AD-15 — Docker multi-role image

One image, `VL_ROLE` selects web/worker/scheduler/status/migrate. Migrations
run under a PostgreSQL advisory lock so replicas can't race.

## AD-16 — Deterministic demo world

Demo seeding uses a fixed PRNG per account: identical schedules, drives,
charges, automations and status content — reproducible in tests and
demos.

## AD-17 — Multi-organization tenancy

Every user belongs to organizations through `Membership` rows (OWNER /
DRIVER / VIEWER), and every resource resolves through that membership at
access time — vehicles, drives, places, automations and provider accounts are
organization-scoped. The route policy table derives the target organization
from params/query/body only, never from a client-supplied id alone
(Z-IDOR), and instance-admin actions bypass org scoping explicitly.

## AD-18 — Foundation replacement and rename

The imported foundation (see FOUNDATION_AUDIT.md) was replaced component by
component rather than rewritten in one pass: the domain models, the SQLite
fallback, the old Dockerfile and the college-branding residue were removed;
the auth stack, Express shell and SPA were improved in place; the database,
queue and asset pipeline were replaced outright. The repository and every
technical identifier were renamed to VoltLink in a single migration pair, and
the naming scanner keeps the old identifier out of tracked files.
