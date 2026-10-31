// Sign-in page with TOTP step and passkey support.

import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { ApiError } from '../api/client';
import { Button, Field, Input } from '../components/ui';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpEmail, setTotpEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await login(email, password, totp || undefined);
      if (res.totpRequired) {
        setTotpEmail(email);
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const passkeyLogin = async () => {
    if (!email) {
      setError('Enter your email, then use your passkey.');
      return;
    }
    setPasskeyBusy(true);
    setError('');
    try {
      const options = await api<{ challenge: string; allowCredentials?: { id: string }[] }>(
        '/api/v1/auth/passkey/auth-options',
      );
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b64decode(options.challenge),
          rpId: window.location.hostname,
          allowCredentials: (options.allowCredentials ?? []).map((c) => ({
            id: b64decode(c.id),
            type: 'public-key' as const,
          })),
          userVerification: 'preferred',
        },
      });
      if (!cred) throw new Error('No credential selected');
      const pk = cred as PublicKeyCredential;
      const res = await api<{ user: { id: string } }>('/api/v1/auth/passkey/auth-verify', {
        method: 'POST',
        body: {
          email,
          id: pk.id,
          rawId: b64url(pk.rawId),
          type: 'public-key',
          response: pk.response,
        },
      });
      void res;
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Passkey sign-in failed.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="VoltLink" className="h-14 w-14 rounded-2xl" />
          <h1 className="text-xl font-extrabold">VoltLink</h1>
          <p className="text-sm text-subtle">Sign in to your connected-vehicle platform</p>
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
          <Field label="Email">
            <Input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {totpEmail && (
            <Field label="Authentication code (TOTP)">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                required={!!totpEmail}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="6-digit code"
              />
            </Field>
          )}
          <Button type="submit" loading={busy} className="w-full">
            <KeyRound size={15} /> Sign in
          </Button>
          <Button
            type="button"
            variant="secondary"
            loading={passkeyBusy}
            onClick={passkeyLogin}
            className="w-full"
          >
            <ShieldCheck size={15} /> Sign in with passkey
          </Button>
          <div className="flex items-center justify-between text-xs">
            <Link className="text-accent hover:underline" to="/forgot-password">
              Forgot password?
            </Link>
            <Link className="text-accent hover:underline" to="/register">
              Create account
            </Link>
          </div>
        </form>
        <p className="mt-4 text-center text-xs text-faint">
          Self-hosted and privacy-first.{' '}
          <Link to="/status" className="text-accent hover:underline">
            System status
          </Link>
        </p>
      </div>
    </div>
  );
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
