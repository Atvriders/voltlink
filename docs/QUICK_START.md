# Quick start

Five minutes to a running VoltLink with the fictional demo fleet.

## 1. Requirements

- Docker Engine 24+ with the Compose plugin
- 2 GB RAM free, ~1 GB disk
- Nothing else — PostgreSQL and Redis run as containers.

## 2. Clone and configure

```bash
git clone https://github.com/Atvriders/voltlink.git
cd voltlink
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
JWT_SECRET=$(openssl rand -hex 32)      # paste the output
VL_MASTER_KEY=$(openssl rand -base64 32) # paste the output
POSTGRES_PASSWORD=<strong database password>
PUBLIC_URL=http://localhost:3110        # your real https:// URL later
```

## 3. Start

```bash
docker compose up -d
```

Watch startup:

```bash
docker compose logs -f web
```

Wait for `[voltlink] web listening on 0.0.0.0:3000`. On first boot the web role
applies database migrations under an advisory lock, so replicas can race
without harm.

## 4. Create your account

Open <http://localhost:3110> and register. The first account becomes the owner
with every role and permission. Registration sends a verification email; in
development mode with no SMTP configured the verification link is printed in
the web container's log.

## 5. Try every feature without a car

Open **Providers** → click **Enable demo mode**. This seeds:

- 5 fictional vehicles (compact sedan, sport sedan, compact crossover, SUV, pickup) with live simulated state
- 30 days of drives, charging sessions and telemetry
- Places, geofences, a privacy zone, electricity rate rules
- Fleet groups/drivers, automations, notifications, and a status page with an active incident

Now explore: Overview, Live vehicle (honk the horn and watch
`Queued → … → Confirmed`), Showroom (3D), Drives, Charging, Battery,
Automations, Fleet, Map, and the public status page at `/status`.

## 6. Connect a real provider

See [Tesla setup](TESLA_SETUP.md) for the official Fleet API flow, or
[Tessie](OPTIONAL_TESSIE_PROVIDER.md) for the optional third-party service.

## Next steps

- [Configuration](CONFIGURATION.md) — every environment variable
- [Docker Compose](DOCKER_COMPOSE.md) — service layout, healthchecks, production stack
- [Security](SECURITY.md) — hardening checklist
