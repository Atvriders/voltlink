# Architecture decisions and deviations

Deviations from the kit's target design are recorded here, per START_HERE.md
("if you deviate, record why").

## Phase 2

1. **Webhook channel delivery is synchronous per endpoint, not a per-channel
   outbox.** guide 03 §3's outbox-and-worker design is queued for Phase 5
   (notifications delivery). In Phase 2 the send path signs with Standard
   Webhooks and uses `safeFetch` directly. The outbox, throttles and retries
   land with Phase 5; the channel-secret storage model already matches the
   outbox target (`NotificationChannel.configCiphertext`).

2. **`POST /api/v1/providers/tesla/authorize` → kept as `GET
/tesla/authorize`** (no body, no `organizationId` parameter). The
   organization is taken from the actor's oldest active membership at
   authorize time and stored in the `OAuthState` row, and is re-verified at
   the callback (membership still active + `providers.manage`). This matches
   guide 01 §3's GET-shaped authorize route and keeps the Z-TESLASTATE
   security properties: random server-stored state hashed at rest, PKCE S256
   verifier sealed, single-use atomic delete, session binding, and no user id
   inside `state`.

3. **`Z-DEMOSCOPE` route naming:** per-account degradation is exposed as
   `POST /api/v1/providers/:accountId/demo-degraded` instead of a global
   `/demo/degraded`; `Organization.demoDegraded` is the flag and
   `status/service.ts` counts degraded organizations.

4. **N-CHANSECRETS migration is lazy.** `userChannelUrl` migrates legacy
   `AppSetting user:<id>:<key>` rows into sealed `NotificationChannel`
   rows on first read and deletes the setting. A bulk data-task sweep is not
   needed because reads are the only consumers; the write path always seals.

5. **N-CSV neutralization uses a leading `'` prefix** (standard for Excel) for
   cells starting with `= + - @ \t \r`, before quoting; quoting/escaping stays
   exactly-once.

6. **`WebhookEndpoint` keeps the raw `url` column** (config data, not a
   secret) but all API responses return only `displayHint` (G-08). Secrets are
   envelope-sealed with `secretSealed`/`previousSecretSealed`/`previousUntil`
   for rotation.

7. **Tesla token exchange still happens in `providers/tesla.ts`**
   (`teslaExchangeCode` now takes an optional PKCE verifier) rather than a new
   `providers/tesla/oauth.ts`; Phase 6's contract-test work will move it to
   the guide 01 §3 shape (TeslaAuthError, decodeClaims, etc.).
