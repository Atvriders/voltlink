# VoltLink Docker Compose install guide

This is THE VoltLink install guide for Docker Compose. Every other install doc
in this repo points here; if one contradicts this file, this file wins.

The stack pulls the published image `ghcr.io/atvriders/voltlink` — nothing in
the install path builds an image locally. Building from source is a separate,
documented overlay (`docker-compose.build.yml`), never an install step.

Runnable blocks are marked with `<!-- run: <name> -->`; CI's compose acceptance
runs them verbatim with two printed substitutions (the compose file comes from
the checkout, and the image is the run's image via `docker-compose.ci.yml`).

## 1. Requirements

- Docker Engine with the Compose plugin v2.20 or newer (`docker compose version`
  must print 2.20+; `docker-compose.yml` uses `include:`).
- ~2 GB free RAM and ~2 GB disk for the database volume.
- A host name you control (HTTPS) or localhost for a trial.
- Ports published by default: `127.0.0.1:3110` (web) and, with the status
  profile, `127.0.0.1:3001` (status). PostgreSQL and Redis stay on an internal
  network and publish nothing.

## 2. Get the files

Download the compose file from the release tag's URL so the file and the image
always match:

<!-- run: get-files -->
```bash
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.1/compose.production.yml -o compose.production.yml
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.1/.env.example -o .env.example
```

The compose file's image reference defaults to `v1.1.1`. Pin the exact digest
for immutable deployments (see
[Configuration](CONFIGURATION.md#image-reference)).

## 3. Create `.env`

Compose reads `.env` from the same directory as the compose file. Generate the
secrets with commands (never put `$(...)` inside `.env` — compose does not run
commands there):

<!-- run: create-env -->
```bash
umask 077
printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'VL_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" >> .env
```

`VL_MASTER_KEY` must be exactly 32 random bytes in standard base64 — the
command above is the canonical way. Store `.env` securely: it contains the
secrets that unlock the database password, sessions and sealed provider
credentials.

Then set `PUBLIC_URL` for one of the three supported cases:

**Localhost trial (plain HTTP):**

<!-- run: env-localhost -->
```bash
printf 'PUBLIC_URL=http://localhost:3110\n' >> .env
```

**Plain-HTTP LAN deployment** (passkeys and web push stay unavailable without
HTTPS):

<!-- run: env-lan -->
```bash
printf 'PUBLIC_URL=http://192.0.2.10:3110\n' >> .env
printf 'VL_ALLOW_INSECURE_HTTP=true\n' >> .env
```

**HTTPS behind a reverse proxy** (recommended for anything real):

<!-- run: env-https -->
```bash
printf 'PUBLIC_URL=https://voltlink.example.com\n' >> .env
printf 'TRUST_PROXY=1\n' >> .env
```

If you set passkeys up, `VL_WEBAUTHN_RP_ID` must equal the `PUBLIC_URL` host or
a parent domain of it (boot refuses anything else). For
`https://voltlink.example.com` the default is correct; for a subdomain such as
`https://cars.example.net`, set:

<!-- run: env-webauthn -->
```bash
printf 'VL_WEBAUTHN_RP_ID=example.net\n' >> .env
```

Missing required values fail `docker compose` itself with a message naming the
variable; placeholder-looking secrets are refused at boot.

## 4. Start

<!-- run: up -->
```bash
docker compose -f compose.production.yml up -d --wait
```

`--wait` returns only after every role is healthy. Watch the logs with
`docker compose -f compose.production.yml logs -f`.

## 5. First-run setup

On a fresh install the web role logs a setup token on every boot until setup is
complete (the token changes on each boot). Read the latest one with the guide
command:

<!-- run: read-token -->
```bash
docker compose -f compose.production.yml logs web | grep 'first-run setup token' | tail -1 | awk '{print $NF}'
```

Open `http://localhost:3110/setup` (or your PUBLIC_URL's `/setup`), paste the
token, and create the instance administrator. After setup you land on the
overview and the token stops being logged. If you lose a boot log before
finishing setup, restart the stack and read the token again.

## 6. Demo mode

Sign in, open **Providers → Demo provider → Connect**, and the fictional demo
fleet appears. Demo data is clearly marked and fictional.

## 7. Optional extras

**SMTP** — without `SMTP_URL`, transactional mail is suppressed (one log line
per mail, never the body or a link) and the boot log says so. To send real mail:

```bash
printf 'SMTP_URL=smtp://user:pass@smtp.example.com:587\n' >> .env
```

**Status page** — the public status site on its own port:

<!-- run: status-profile -->
```bash
docker compose -f compose.production.yml --profile status up -d --wait
```

It serves on `127.0.0.1:3001` (`STATUS_PORT`).

**Tesla command proxy** — see [TESLA_SETUP.md](TESLA_SETUP.md); the profile is
`tesla` and the app roles reach the proxy over the shared `egress` network.

## 8. Reverse proxy examples

**Caddy** (https://caddyserver.com):

```
voltlink.example.com {
    reverse_proxy 127.0.0.1:3110
}
```

With the status profile, add `status.example.com { reverse_proxy 127.0.0.1:3001 }`.

**nginx**:

```nginx
server {
    listen 443 ssl;
    server_name voltlink.example.com;
    location / { proxy_pass http://127.0.0.1:3110; proxy_set_header Host $host; }
}
```

Set `TRUST_PROXY=1` in `.env` for one proxy hop.

## 9. Backups and upgrades

Backup, restore and the migrate role: [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
Upgrades: [UPGRADING.md](UPGRADING.md) — in short, set the new tag and
`docker compose pull && docker compose up -d --wait`.

## 10. Stop, reset, uninstall

<!-- run: down -->
```bash
docker compose -f compose.production.yml down
```

`down` keeps the `pgdata` volume (your data). A full reset including data:

<!-- run: down-v -->
```bash
docker compose -f compose.production.yml down -v
```

Remove the image with `docker image rm ghcr.io/atvriders/voltlink:v1.1.1`.

## 11. Troubleshooting

Boot refuses to start with a clear message for each of these; the fix is in the
message itself:

| Boot error | Fix |
| --- | --- |
| `PUBLIC_URL must be an https:// URL in production…` | Use HTTPS, or set `VL_ALLOW_INSECURE_HTTP=true` for a plain-HTTP LAN deployment. |
| `VL_WEBAUTHN_RP_ID (…) must equal the PUBLIC_URL host…` | Set `VL_WEBAUTHN_RP_ID` to the host or a parent domain. |
| `JWT_SECRET is missing or too short` / placeholder refusal | Generate a real secret (`openssl rand -hex 32`), never a placeholder. |
| `VL_MASTER_KEY must be 32 bytes when base64-decoded` | `openssl rand -base64 32`. |
| `VL_MASTER_KEY_VERSION must be a positive integer` / ring errors | Fix `VL_MASTER_KEY_VERSION` or the `VL_MASTER_KEYS` entries (`vN:base64`). |
| `MAIL_TO_CONSOLE=true is not allowed in production` | Set `SMTP_URL` and remove `MAIL_TO_CONSOLE`. |
| `VL_DEV_ECHO_TOKENS=1 …` | Development-only switch; remove it in production. |
| Required variable `…` is not set (compose) | Add the named variable to `.env`. |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for runtime issues.
