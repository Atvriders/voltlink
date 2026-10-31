// Container smoke test (guide 04 §7.1 / guide 08 §14): first-run setup with
// VL_SETUP_TOKEN, demo mode, a command through the queue, its SSE frames and
// /readyz. Run inside CI's image job against the booted compose stack.
const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:3110';
const setupToken = process.env.VL_SETUP_TOKEN ?? '';
if (!setupToken) throw new Error('VL_SETUP_TOKEN is required for the smoke test');

function cookieOf(res, name) {
  return (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(name));
}

async function main() {
  // /readyz must be green (DB + migrations + queue).
  const ready = await fetch(`${base}/readyz`);
  if (!ready.ok) throw new Error(`readyz ${ready.status}: ${await ready.text()}`);
  console.log('readyz ok');

  // First-run setup: register the instance admin with the setup token.
  const first = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const csrfCookie = cookieOf(first, 'vl_csrf');
  if (!csrfCookie) throw new Error(`CSRF cookie missing from first response (${first.status})`);
  const csrf = csrfCookie.split('=')[1];
  const reg = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: csrfCookie, 'x-vl-csrf': csrf },
    body: JSON.stringify({
      email: `smoke-${Date.now()}@ci.test`,
      password: 'smoke-password-12345',
      name: 'Smoke',
      setupToken,
    }),
  });
  const sessCookie = cookieOf(reg, 'vl_session');
  if (reg.status !== 201 || !sessCookie)
    throw new Error(`register ${reg.status}: ${await reg.text()}`);
  console.log('register ok');

  const h = {
    'content-type': 'application/json',
    cookie: `${csrfCookie}; ${sessCookie}`,
    'x-vl-csrf': csrf,
  };

  // Demo mode.
  const demo = await fetch(`${base}/api/v1/providers/demo/connect`, { method: 'POST', headers: h });
  if (!demo.ok) throw new Error(`demo connect ${demo.status}: ${await demo.text()}`);
  console.log('demo connect ok');

  const vehicles = await (
    await fetch(`${base}/api/v1/vehicles`, { headers: { cookie: `${csrfCookie}; ${sessCookie}` } })
  ).json();
  const vehicle = vehicles.data?.[0];
  if (!vehicle?.id) throw new Error('demo connect produced no vehicles');
  console.log('vehicles', vehicles.data.length);

  // SSE frames + a command through the queue.
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
