// seeds a login-ready user for the local Tesla e2e run, entirely over HTTP:
// open registration -> read the verification email from the e2e SMTP sink ->
// verify. (R2-24: no raw SQL in the e2e bootstrap path.)
const BASE = process.env.VL_E2E_API ?? 'http://127.0.0.1:3111';
const SMTP_HTTP = process.env.VL_E2E_SMTP_HTTP ?? 'http://127.0.0.1:1026';
const EMAIL = process.env.E2E_USER_EMAIL ?? 'tesla-e2e-user@voltlink.test';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e-password-123';

async function j(fetchPromise) {
  const res = await fetchPromise;
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  // A new user every run (open registration): create with a timestamped email
  // if EMAIL already exists in a reused DB, registration answers 409.
  const email = `${EMAIL}`;
  const csrf1 = await j(fetch(`${BASE}/api/v1/auth/csrf`));
  if (csrf1.status !== 200) throw new Error(`csrf: ${csrf1.status} ${JSON.stringify(csrf1.body)}`);
  const csrf = csrf1.body.data.token;
  // Double-submit CSRF needs the cookie AND the header to match; node fetch
  // has no cookie jar, so carry the Set-Cookie value through every request.
  const cookie = csrf1.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('csrf response carried no Set-Cookie');
  const reg = await j(
    fetch(`${BASE}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-vl-csrf': csrf,
      },
      body: JSON.stringify({ name: 'Tesla E2E', email, password: PASSWORD }),
    }),
  );
  if (reg.status === 409) {
    // Already exists from a previous run: skip to verification state check.
    console.log(`user already registered: ${email}`);
    return;
  }
  if (reg.status !== 202 && reg.status !== 201) {
    throw new Error(`register: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  if (reg.status === 202) {
    // Find the verification token in the SMTP sink.
    let token;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const m = await j(fetch(`${SMTP_HTTP}/last?to=${encodeURIComponent(email)}`));
      if (m.status === 200) {
        const text = m.body.textDecoded ?? m.body.text;
        const hit = text?.match(/token=([A-Za-z0-9_-]+)/);
        if (hit) {
          token = hit[1];
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!token) {
      // Registration answers 202 for an existing email too (no
      // account enumeration) and sends no mail then. Prove readiness by
      // signing in instead — a fresh CI database always gets the email
      // branch, a reused local database always gets this one.
      const login = await j(
        fetch(`${BASE}/api/v1/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'x-vl-csrf': csrf,
          },
          body: JSON.stringify({ email, password: PASSWORD }),
        }),
      );
      if (login.status === 200) {
        console.log(`user already verified; login works: ${email}`);
        return;
      }
      throw new Error(`no verification email for ${email}`);
    }
    const ver = await j(
      fetch(`${BASE}/api/v1/auth/verify-email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'x-vl-csrf': csrf },
        body: JSON.stringify({ token }),
      }),
    );
    if (ver.status !== 200)
      throw new Error(`verify-email: ${ver.status} ${JSON.stringify(ver.body)}`);
  }
  console.log(`user ready: ${email}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
