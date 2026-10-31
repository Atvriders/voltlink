# Tesla Fleet API setup (operator runbook)

VoltLink talks to Tesla through the official Fleet API. All vehicle commands
are signed by Tesla's `tesla-http-proxy` sidecar; nothing is called without the
proxy except `wake_up` and data endpoints.

## 1. Developer app

1. Create an app on https://developer.tesla.com (verified email, MFA, business
   details). Request only `vehicle_device_data`, `vehicle_location`,
   `vehicle_cmds`, `vehicle_charging_cmds` — do not request `energy_*`.
2. Allowed origin: `https://<your host>`. Redirect URI:
   `https://<your host>/api/v1/providers/tesla/callback`.
3. Add a payment method and set a billing limit (the default limit is 0, and
   apps without a payment method are disabled).

## 2. Keys and public-key hosting

On the host (never in the image):

```bash
mkdir -p tesla/keys tesla/public tesla/proxy-tls
openssl ecparam -name prime256v1 -genkey -noout -out tesla/keys/fleet-key.pem
openssl ec -in tesla/keys/fleet-key.pem -pubout -out tesla/public/com.tesla.3p.public-key.pem
openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 -pkeyopt ec_param_enc:named_curve \
  -subj '/CN=tesla-proxy' -addext 'subjectAltName=DNS:tesla-proxy' \
  -addext 'extendedKeyUsage=serverAuth' -addext 'keyUsage=digitalSignature,keyCertSign,keyAgreement' \
  -keyout tesla/proxy-tls/tls-key.pem -out tesla/proxy-tls/tls-cert.pem -sha256 -days 3650
chmod 0644 tesla/public/*.pem tesla/proxy-tls/tls-cert.pem
chown 65532:65532 tesla/keys/fleet-key.pem tesla/proxy-tls/tls-key.pem
chmod 0400 tesla/keys/fleet-key.pem tesla/proxy-tls/tls-key.pem
```

- The command key must be `prime256v1`; the proxy TLS key must be a different
  key (the proxy refuses to start otherwise).
- Back up `fleet-key.pem` with the database. Losing or rotating it forces every
  owner to re-pair.
- VoltLink serves the public key at
  `/.well-known/appspecific/com.tesla.3p.public-key.pem` (route wired before the
  SPA fallback). Keep it reachable — Tesla re-checks it.

## 3. Partner registration

Start the proxy profile and register the partner account in every region of
operation (instance admin):

```bash
docker compose --profile tesla up -d
# via the API: POST /api/v1/admin/tesla/partner-registration {"regions":"na,eu"}
```

## 4. Environment

| Var                                           | Meaning                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET`     | developer app credentials                                   |
| `TESLA_REDIRECT_URI`                          | `${PUBLIC_URL}/api/v1/providers/tesla/callback`             |
| `TESLA_TOKEN_URL`                             | `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` |
| `TESLA_AUTHORIZE_URL`                         | `https://auth.tesla.com/oauth2/v3/authorize`                |
| `TESLA_DEFAULT_AUDIENCE`                      | Fleet API base URL (NA or EU)                               |
| `TESLA_FLEET_BASE_NA` / `TESLA_FLEET_BASE_EU` | per-region bases                                            |
| `TESLA_PARTNER_DOMAIN`                        | host of `PUBLIC_URL`, lowercased                            |
| `TESLA_PUBLIC_KEY_FILE`                       | `/run/voltlink/tesla/public-key.pem`                        |
| `TESLA_COMMAND_PROXY_URL`                     | `https://tesla-proxy:4443` (empty ⇒ commands unsupported)   |
| `NODE_EXTRA_CA_CERTS`                         | `/run/voltlink/tesla/proxy-ca.pem`                          |

## 5. Connecting an account

`POST /api/v1/providers/tesla/authorize {organizationId}` redirects to Tesla's
consent page with PKCE (S256) and a single-use, session-bound `state`. The
callback exchanges the code on fleet-auth, discovers the account region, and
stores rotating refresh tokens sealed at rest. Refresh happens under a row lock
minutes before expiry; `login_required` / `invalid_grant` mark the account
`reauth_required` with a Reconnect button.

After connecting, `POST /api/v1/providers/:accountId/import` lists vehicles
(paginated, no `vehicle_data` loop) and computes per-vehicle capabilities from
scopes, `vehicle_config`/`vehicle_state` and `fleet_status`.

## 6. Virtual keys

Vehicles with `vehicle_command_protocol_required: true` need the app's virtual
key. Readiness shows the pairing link
`https://tesla.com/_ak/<domain>?vin=<VIN>` (Tesla app 4.27.3+). Until the key is
paired, signed commands are disabled with `virtual_key_not_paired`.

## 7. Sleep and cost

Never poll `vehicle_data` on an asleep car. The planner checks the free vehicle
endpoint first; a 408 is billed and never retried until the car reports online.
Wakes ($0.02 each, 3/min/vehicle max) happen only for explicit user commands or
the explicit Wake control. Estimated cost at default settings is ~$0.34/car/day.

## 8. Live acceptance (requires real credentials — blocked locally)

The live run (L2207-2228) needs a real Tesla with owner access: connect with
PKCE, tamper-test PKCE enforcement, import, confirm capabilities, leave the car
asleep 1 h and verify 0 `wake_up`/0 `vehicle_data` in the usage page, verify
battery/charging/location, run `flash_lights` (accepted, not_observable) and
`lock` (confirmed), stop the proxy and confirm readiness goes red, then
disconnect. Status: **Blocked by external credentials**.
