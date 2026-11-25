// First-run setup page (R2-01): creates the instance admin with the setup
// token. Only reachable when the instance has not bootstrapped yet; a
// bootstrapped instance redirects to sign-in.

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, Input } from '../components/ui';

export default function SetupPage() {
  const navigate = useNavigate();
  const { refresh, user } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ needsSetup?: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<{ needsSetup: boolean; registrationMode: string }>(
          '/api/v1/auth/setup-status',
        );
        if (!alive) return;
        setStatus(res);
        // R2-01: a signed-in user is sent home, never bounced to /login.
        if (!res.needsSetup) navigate(user ? '/' : '/login', { replace: true });
      } catch {
        if (alive) setStatus({});
      }
    })();
    return () => {
      alive = false;
    };
  }, [navigate, user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/v1/auth/register', {
        method: 'POST',
        body: { name, email, password, setupToken },
      });
      await refresh();
      // R2-01 fix text: setup lands on '/'.
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="VoltLink" className="h-14 w-14 rounded-2xl" />
          <h1 className="text-xl font-extrabold">Welcome to VoltLink</h1>
          <p className="text-sm text-subtle">First run: create the instance administrator.</p>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-5">
          {error && (
            <div
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {error}
            </div>
          )}
          <Field label="Your name">
            <Input
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password (min 10 characters)">
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Setup token">
            <Input
              required
              autoComplete="off"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              placeholder="VL_SETUP_TOKEN (or the one printed in the web log)"
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            <Rocket size={15} /> Create administrator
          </Button>
          <div className="text-center text-xs">
            <Link className="text-accent hover:underline" to="/login">
              Sign in instead
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
