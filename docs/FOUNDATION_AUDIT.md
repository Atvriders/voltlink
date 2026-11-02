# Foundation audit

> Written retroactively on 2026-11-02, after the build, as an honest historical
> record. Nothing in this file was produced at build start.

## Starting point

VoltLink was built on top of a TypeScript/npm-workspaces monorepo skeleton
imported from a prior project, `Atvriders/ham-net-assistant`.

- Real starting commit of the foundation repo: **`22aad155`**
- Imported into this repository in commit **`d121f93`**

## Baseline at import (d121f93)

- 111 test files, about 1,124 `it`/`test` cases: shared 67, api 734, web 323.
- The foundation test script chained `shared && api && web`.
- The last recorded foundation run reported **232 passing tests, 2
  timing-flaky failures, and 454 skipped tests as a result of files aborting** —
  the web suite was not run to completion in that baseline.
- Tooling at import: Node 24, npm 11, TypeScript 5 (strict with
  `noUncheckedIndexedAccess`).

## Component classification

Every major foundation component was classified before work started:

| Component | Classification | What happened |
|---|---|---|
| npm workspaces skeleton (tsconfigs, scripts, CI stub) | **Preserve** | Kept as the repo skeleton |
| Shared zod schemas and role helpers | **Refactor** | Rebuilt for the vehicle domain |
| Express app shell / route wiring | **Refactor** | policyRouter + route table added |
| Auth (argon2, TOTP, passkeys, sessions) | **Improve** | Extended with tenancy, step-up, CSRF |
| PostgreSQL schema | **Replace** | New voltlink schema with partitioned telemetry |
| SQLite dev fallback | **Remove** | Postgres-only |
| Ham-radio domain models (check-ins, net sessions, callbooks) | **Remove** | No traces remain; `scripts/legacy-scan.ts` guards this |
| Old Dockerfile with private hostname | **Remove** | Deleted (Phase 11); new multi-role image |
| Old theme bundle and college-branding references | **Remove** | Five original themes; third-party asset notes moved to docs/ASSET_LICENSES.md |
| Web UI (React SPA) | **Improve** | React 19 + Vite, vehicle platform pages |

## What VoltLink is today

- Multi-organization tenancy with OWNER/DRIVER/VIEWER roles, invitations,
  transfers, retention and audit.
- Commands/queue/worker/scheduler with realtime SSE, status platform,
  automations and 8 notification channels.
- Deterministic demo provider plus Tesla and Tessie adapters (live testing
  still blocked on credentials — see COMPLETION.md).
- WebGL showroom with original Blender-generated vehicle assets and LODs.
- OpenAPI 3.1 generated from the live route table.

The legacy-content scanner (`npm run legacy:scan`) reads every tracked text file
and fails on planted terms; the naming scanner (`npm run naming:scan`) does the
same for the pre-rename identifier.
