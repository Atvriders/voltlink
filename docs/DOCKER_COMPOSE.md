# VoltLink Docker Compose install guide

This is THE VoltLink install guide for Docker Compose. Every other install doc
in this repo points here; if one contradicts this file, this file wins.

The stack pulls the published image `ghcr.io/atvriders/voltlink` — nothing in
the install path builds an image locally. Building from source is a separate,
documented overlay (`docker-compose.build.yml`), never an install step.

Runnable blocks are marked with `<!-- run: <name> -->`; CI's compose acceptance
runs them verbatim with printed substitutions (the compose files come from the
checkout, the image is the run's image via a `COMPOSE_FILE` the runner exports
with the CI overlay, and the in-file defaults mean no env file and no `PUBLIC_URL`
case are needed).

## 1. Requirements

- Docker Engine with the Compose plugin v2.20 or newer (`docker compose version`
  must print 2.20+; `docker-compose.yml` uses `include:`).
- **linux/amd64 only** — the image is built and verified for amd64 (see
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
- ~2 GB free RAM and ~2 GB disk for the database volume.
- A host name you control (HTTPS) or localhost for a trial.
- Ports published by default: `127.0.0.1:3110` (web) and, with the status
  profile, `127.0.0.1:3001` (status). PostgreSQL and Redis stay on an internal
  network and publish nothing.

## 2. Get the files

Download both files from the release tag's URL so the files and the image
always match (`docker-compose.yml` is the entry point; it includes the
production file):

<!-- run: get-files -->

```bash
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.2/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.2/compose.production.yml -o compose.production.yml
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.2/.env.example -o .env.example
```

The image reference is `ghcr.io/atvriders/voltlink` — the exact image the
GitHub Actions CI pipeline builds, verifies and publishes; the tag defaults to
`v1.1.2` and nothing in the install path ever builds an image. Pin the exact
CI-verified digest for immutable deployments (see
[Configuration](CONFIGURATION.md#image-reference)).

## 3. Secrets (no `.env` required)

Every required value already has a default inside the compose file — the stack
starts with no `.env` file at all. The defaults are local-trial quality: the
web role binds to `127.0.0.1`, `PUBLIC_URL` defaults to
`http://localhost:3110`, and the three secrets are published defaults. Before
exposing the stack to anything but localhost, replace them in one guarded
block (the guard refuses to overwrite an existing `.env`):

<!-- run: rotate-secrets -->

```bash
[ ! -e .env ] || { echo '.env already exists — refusing to overwrite it' >&2; exit 1; }
umask 077
printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
printf 'VL_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 16)" >> .env
```

`VL_MASTER_KEY` must be exactly 32 random bytes in standard base64 — the
command above is the canonical way. `.env` is an override file: any variable
in it wins over the compose-file default. Back it up with the rest of your
secrets.

`PUBLIC_URL` needs no `.env` entry for a localhost trial — it is the default.
For the other two supported cases:

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

Placeholder-looking secrets are refused at boot, so a `change-me` value fails
loudly instead of running silently.

## 4. Start

<!-- run: up -->

```bash
docker compose up -d --wait
```

`--wait` returns only after every role is healthy. Watch the logs with
`docker compose logs -f`.

## 5. First-run setup

On a fresh install the web role logs a setup token on every boot until setup is
complete (the token changes on each boot). Read the latest one with the guide
command:

<!-- run: read-token -->

```bash
docker compose logs web | grep 'first-run setup token' | tail -1 | awk '{print $NF}'
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
printf 'SMTP_URL=smtp://user:pass@example.invalid:587\n' >> .env
```

**Status page** — the public status site on its own port:

<!-- run: status-profile -->

```bash
docker compose --profile status up -d --wait
```

It serves on `127.0.0.1:3001`. Move only the host side with
`VOLTLINK_STATUS_PORT=3002` in `.env` if `3001` is taken; the container keeps
its own `STATUS_PORT`.

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

**Cloudflare Tunnel** — the connector can run inside this stack, so the tunnel
is the only way in and nothing new is published on the host:

```bash
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.2/docker-compose.tunnel.yml -o docker-compose.tunnel.yml
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --wait
```

That overlay requires two values from the environment (`.env` or the shell):

```
PUBLIC_URL=https://voltlink.example.com
CLOUDFLARE_TUNNEL_TOKEN=eyJhIjoi...
```

`PUBLIC_URL` must be the tunnel's public hostname; the token comes from Zero
Trust → Networks → Tunnels → your tunnel → _Configure_. In the tunnel's public
hostname rule, point the service at `http://web:3000` (the overlay puts the
connector on the `internal` network, where that name resolves). The overlay
sets `TRUST_PROXY=1` for you — one hop, the connector — which is what makes the
app see `https` and keep the session cookie. Do not set that variable to the
bare boolean value: the web role refuses to boot with it, because it would let
any client choose its own `X-Forwarded-For`.

Running `cloudflared` on the host instead? Skip the overlay: point that tunnel
at `http://127.0.0.1:3110` and set only `PUBLIC_URL` and `TRUST_PROXY=1`.
`VL_ALLOW_INSECURE_HTTP` is never needed for a tunnel: the public URL is https.

## 9. Backups and upgrades

Backup, restore and the migrate role: [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
Upgrades: [UPGRADING.md](UPGRADING.md) — in short, set the new tag and
`docker compose pull && docker compose up -d --wait`.

## 10. Scaling

Do **not** run `--scale web=2`: the web role publishes a fixed host port
(`127.0.0.1:3110`), and the first-run setup token is logged per boot, so a
second replica can neither bind the port nor share the setup state. The stack
is designed for one replica per role; scale the host instead.

## 11. Stop, reset, uninstall

<!-- run: down -->

```bash
docker compose down
```

`down` keeps the `pgdata` volume (your data). A full reset including data:

<!-- run: down-v -->

```bash
docker compose down -v
```

Remove the image with `docker image rm ghcr.io/atvriders/voltlink:v1.1.2`.
If the directory is not named `voltlink`, pass `-p voltlink` to every command
so the project name (and the `voltlink_pgdata` volume) stays the same.

## 12. Troubleshooting

Boot refuses to start with a clear message for each of these; the fix is in the
message itself:

| Boot error                                                       | Fix                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `PUBLIC_URL must be an https:// URL in production…`              | Use HTTPS, or set `VL_ALLOW_INSECURE_HTTP=true` for a plain-HTTP LAN deployment.        |
| `VL_WEBAUTHN_RP_ID (…) must equal the PUBLIC_URL host…`          | Set `VL_WEBAUTHN_RP_ID` to the host or a parent domain.                                 |
| `JWT_SECRET is missing or too short` / placeholder refusal       | Generate a real secret (`openssl rand -hex 32`), never a placeholder.                   |
| `VL_MASTER_KEY must be 32 bytes when base64-decoded`             | `openssl rand -base64 32`.                                                              |
| `VL_MASTER_KEY_VERSION must be a positive integer` / ring errors | Fix `VL_MASTER_KEY_VERSION` or the `VL_MASTER_KEYS` entries (`vN:base64`).              |
| `MAIL_TO_CONSOLE=true is not allowed in production`              | Set `SMTP_URL` and remove `MAIL_TO_CONSOLE`.                                            |
| `VL_DEV_ECHO_TOKENS=1 …`                                         | Development-only switch; remove it in production.                                       |
| Stack boots with the published default secrets                   | Local-trial defaults; run the §3 rotation before exposing it to anything but localhost. |

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for runtime issues.
