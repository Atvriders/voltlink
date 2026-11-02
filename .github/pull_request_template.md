## What and why

<!-- What changes, and the problem it solves. Link the issue if there is one.
     If this fixes a production failure, name the failure. -->

## Gate chain

Run from the repo root. Tick a box only after the command has actually passed
locally — CI runs the same chain and blocks the image publish on it.

- [ ] `npm run typecheck`
- [ ] `npx eslint . --max-warnings=0`
- [ ] `npm test` (shared + api + web)
- [ ] `npm run build`

## Tests

- [ ] Added or updated tests covering every behavior this PR changes
- [ ] No test was deleted or `.skip`ped to make the suite pass

<!-- Name the test files a reviewer should look at first. -->

## Blast radius

- [ ] **API contract:** no response shape or status code changed — or, if it did,
      I grepped `apps/web/src` for every caller and updated them
- [ ] **Roles:** any new endpoint is gated at the _lowest_ role that genuinely
      needs it (`requireRole` / `roleAtLeast`, VIEWER < DRIVER < OWNER)
- [ ] **Migrations:** no shipped migration was edited; new ones are additive and
      safe to apply to a live database on container start
- [ ] **Automation:** anything that posts to Discord or acts without a human
      press is documented, idempotent, and safe to run twice
- [ ] **Secrets/PII:** no tokens, real member data, or `.db` files in the diff

## Docs

- [ ] `README.md` updated if an operator can see this change (new env var, new
      behavior, new failure mode)
- [ ] `CHANGELOG.md` has a line under `Unreleased`
- [ ] Comments explain _why_ (the failure being prevented), not _what_

## Deploy notes

<!-- New/changed environment variables, a migration that needs a backup first,
     anything an operator must do before or after `docker compose pull`.
     Write "none" if there is nothing. -->
