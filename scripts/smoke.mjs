// Container smoke test (guide 04 §7.1 / guide 08 §14): first-run setup with
// a setup token, demo mode, a command through the queue to a terminal state,
// its SSE frames and /readyz. Run inside CI's image job against the booted
// compose stack.
//
// Modes:
//  - First-run: SMOKE_SETUP_TOKEN required — the guide path reads the token
//    from the web log with the guide's pipeline, and no env fallback exists
//    (a missing token must fail loudly, C5.1).
//  - Login reuse (post-restart smoke): SMOKE_EMAIL + SMOKE_PASSWORD log in
//    with the existing instance instead of registering (no AppSetting rows
//    are deleted, R2-27).
//  - SMOKE_ALLOW_ACCEPTED=1 (ONLY the upgrade-smoke's pre-upgrade run):
//    v1.0.0's demo provider answers {kind:'accepted'} and has no confirmation
//    step, so 'accepted' is that release's terminal state. Never set it
//    anywhere else — the post-upgrade run in the same job keeps the strict
//    R2-27 check.

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3110';
const setupToken = process.env.SMOKE_SETUP_TOKEN ?? '';
const loginEmail = process.env.SMOKE_EMAIL ?? '';
const loginPassword = process.env.SMOKE_PASSWORD ?? '';
const allowAccepted = process.env.SMOKE_ALLOW_ACCEPTED === '1';
const TERMINAL = new Set(['confirmed', 'failed', 'rejected', 'timed_out', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cookieOf(res, name) {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(name));
}

async function csrfFrom() {
  const first = await fetch(`${base}/api/v1/auth/csrf`);
  if (!first.ok) throw new Error(`csrf ${first.status}`);
  const cookie = cookieOf(first, 'vl_csrf');
  if (!cookie) throw new Error('CSRF cookie missing');
  return { cookie, token: cookie.split('=')[1] };
}

async function main() {
  const ready = await fetch(`${base}/readyz`);
  if (!ready.ok) throw new Error(`readyz ${ready.status}: ${await ready.text()}`);
  console.log('readyz ok');

  const { cookie: csrfCookie, token: csrf } = await csrfFrom();
  let sessCookie; // assigned in both branches below

  if (loginEmail && loginPassword) {
    // R2-27: the post-restart smoke signs in instead of tampering with
    // AppSetting rows.
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: csrfCookie, 'x-vl-csrf': csrf },
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    });
    sessCookie = cookieOf(login, 'vl_session') ?? '';
    if (login.status !== 200 || !sessCookie)
      throw new Error(`login ${login.status}: ${await login.text()}`);
    console.log('login ok');
  } else {
    if (!setupToken) throw new Error('SMOKE_SETUP_TOKEN is required for first-run smoke');
    const email = process.env.SMOKE_EMAIL || `smoke-${Date.now()}@ci.test`;
    const reg = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: csrfCookie, 'x-vl-csrf': csrf },
      body: JSON.stringify({ email, password: 'smoke-password-12345', name: 'Smoke', setupToken }),
    });
    sessCookie = cookieOf(reg, 'vl_session') ?? '';
    if (reg.status !== 201 || !sessCookie)
      throw new Error(`register ${reg.status}: ${await reg.text()}`);
    console.log('register ok');
  }

  const h = {
    'content-type': 'application/json',
    cookie: `${csrfCookie}; ${sessCookie}`,
    'x-vl-csrf': csrf,
  };

  const demo = await fetch(`${base}/api/v1/providers/demo/connect`, { method: 'POST', headers: h });
  if (!demo.ok && demo.status !== 409 && demo.status !== 400) {
    const text = await demo.text();
    if (!/already|exists|created/i.test(text))
      throw new Error(`demo connect ${demo.status}: ${text}`);
  }
  console.log('demo connect ok');

  const vehicles = await (
    await fetch(`${base}/api/v1/vehicles`, { headers: { cookie: `${csrfCookie}; ${sessCookie}` } })
  ).json();
  const vehicle = vehicles.data?.[0];
  if (!vehicle?.id) throw new Error('no demo vehicles');
  console.log('vehicles', vehicles.data.length);

  const sse = await fetch(`${base}/api/v1/realtime`, {
    headers: { cookie: `${csrfCookie}; ${sessCookie}` },
  });
  if (!sse.ok) throw new Error(`realtime ${sse.status}`);
  const reader = sse.body.getReader();
  let frames = '';
  const deadline = Date.now() + 25_000;
  const collect = (async () => {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      frames += Buffer.from(value).toString('utf8');
      if (frames.includes('vehicle_state') || frames.includes('command_finished')) break;
    }
  })();

  const cmd = await fetch(`${base}/api/v1/commands`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ vehicleId: vehicle.id, type: 'honk_horn', params: {} }),
  });
  if (!cmd.ok) throw new Error(`command ${cmd.status}: ${await cmd.text()}`);
  console.log('command queued', (await cmd.json()).data?.status);

  // R2-27: the smoke must see the command reach a terminal state, not just
  // any vehicle_state frame.
  let terminal = false;
  const cmdDeadline = Date.now() + 90_000;
  while (Date.now() < cmdDeadline) {
    const list = await fetch(`${base}/api/v1/commands?vehicleId=${vehicle.id}`, {
      headers: { cookie: `${csrfCookie}; ${sessCookie}` },
    });
    if (!list.ok) throw new Error(`commands list ${list.status}`);
    const data = await list.json();
    const rows = data.data?.items ?? data.data ?? [];
    for (const row of rows) {
      if (
        row.completedAt ||
        TERMINAL.has(row.status) ||
        (allowAccepted && row.status === 'accepted')
      ) {
        terminal = true;
        console.log('command terminal state', row.status, row.confirmation ?? '');
        break;
      }
    }
    if (terminal) break;
    await sleep(1000);
  }
  if (!terminal) throw new Error('command never reached a terminal state');

  await collect;
  await reader.cancel().catch(() => {});
  if (!frames.includes('vehicle_state') && !frames.includes('command_finished')) {
    throw new Error(`no SSE frames received: ${frames.slice(0, 200)}`);
  }
  console.log('SSE frames received');
  console.log('smoke PASS');
}

main().catch((err) => {
  console.error('[smoke] FAIL', err);
  process.exit(1);
});
