# Quick start

Five minutes to a running VoltLink with the fictional demo fleet. This is the
short version of [DOCKER_COMPOSE.md](DOCKER_COMPOSE.md) — the single install
guide; anything not covered here follows the guide.

## 1. Requirements

- Docker Engine with the Compose plugin v2.20 or newer.
- 2 GB RAM free, ~1 GB disk.
- Nothing else — PostgreSQL and Redis run as containers on an internal network.

## 2. Get the files

```bash
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.1/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/v1.1.1/compose.production.yml -o compose.production.yml
```

No `.env` file — every required value has a default inside the compose file
(web on `127.0.0.1:3110`, `PUBLIC_URL=http://localhost:3110`). The secret
defaults are published local-trial values: run the guarded rotation in
[DOCKER_COMPOSE.md](DOCKER_COMPOSE.md) §3 before exposing the stack, and use an
`https://` PUBLIC_URL for anything beyond a localhost trial.

## 3. Start

```bash
docker compose up -d --wait
```

Watch startup:

```bash
docker compose logs -f web
```

`--wait` returns after every role is healthy. Only the `migrate` role ever
applies migrations (under an advisory lock); the web/worker/scheduler roles
wait for the schema to be current and exit with a clear message if it is not
after 120 s.

## 4. First-run setup

Read the setup token from the boot log, then open
<http://localhost:3110/setup> and create the instance administrator:

```bash
docker compose logs web | grep 'first-run setup token' | tail -1 | awk '{print $NF}'
```

The first account created through setup becomes the instance administrator
with every role and permission. The token is reissued on every boot until
setup completes, and stops being logged afterwards.

## 5. Try every feature without a car

Open **Providers** → click **Enable demo mode**. This seeds:

- 5 fictional vehicles (compact sedan, sport sedan, compact crossover, SUV, pickup) with live simulated state
- 30 days of drives, charging sessions and telemetry
- Places, geofences, a privacy zone, electricity rate rules
- Fleet groups/drivers, automations, notifications, and a status page with an active incident

Now explore: Overview, Live vehicle (honk the horn and watch the command
lifecycle `Queued → …`), Showroom (3D), Drives, Charging, Battery,
Automations, Fleet, Map, and the public status page at `/status`. The
terminal state depends on the command: observable commands (e.g. climate,
charge controls) reach `Confirmed`; not-observable ones (honk is one) end
at `accepted` with confirmation `not_observable`.

## 6. Connect a real provider

See [Tesla setup](TESLA_SETUP.md) for the official Fleet API flow, or
[Tessie](OPTIONAL_TESSIE_PROVIDER.md) for the optional third-party service.

## Next steps

- [Configuration](CONFIGURATION.md) — every environment variable
- [Docker Compose](DOCKER_COMPOSE.md) — service layout, healthchecks, production stack
- [Security](SECURITY.md) — hardening checklist
