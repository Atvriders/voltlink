# Foundation audit

Recorded before the VoltLink build began, kept for history.

## Baseline

VoltLink was built from scratch on a monorepo skeleton (TypeScript strict,
npm workspaces, Express/React tooling) imported from a prior project
(`Atvriders/ham-net-assistant`). The prior domain (amateur-radio net logging)
was fully removed: no legacy routes, pages, tables, or terminology remain,
and `scripts/legacy-scan.ts` fails CI if any resurfaces.

At the start of the VoltLink effort, the imported foundation had:

- 232 passing tests, 2 timing-flaky failures (pre-conversion baseline)
- Node 24 tooling (npm 11, TypeScript 5.4, strict + `noUncheckedIndexedAccess`)

## Environment constraints at build time

- No Docker daemon or Redis available on the development machine → the
  queue supports PostgreSQL fallback, and container smoke tests run in CI
  only (`.github/workflows/ci.yml`).
- PostgreSQL 16 local instance used for migrations and E2E.
- Blender 5.2.2 LTS for the asset pipeline.

## What changed in the rebrand

| Area     | Result                                                                                |
| -------- | ------------------------------------------------------------------------------------- |
| Domain   | ham-radio logging → connected-vehicle platform                                        |
| Database | fresh PostgreSQL schema (35+ models), partitioned telemetry; no renamed legacy tables |
| Auth     | Argon2id, TOTP, passkeys, session revocation added                                    |
| Runtime  | role-based processes (web/worker/scheduler/status), PG+Redis queue                    |
| Frontend | React 19 SPA, 5 themes, WebGL showroom                                                |
| Ops      | Docker multi-role image, GHCR publishing, status platform                             |

See `ARCHITECTURE_DECISIONS.md` for the decision log.
