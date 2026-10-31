// Password reset (forgot + set new) and email verification pages.

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Mail, MailCheck, KeyRound } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { Button, Field, Input } from '../components/ui';

function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="VoltLink" className="h-14 w-14 rounded-2xl" />
          <h1 className="text-xl font-extrabold">VoltLink</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ ok: boolean; token?: string; link?: string }>(
        '/api/v1/auth/forgot-password',
        { method: 'POST', body: { email } },
      );
      if (res.token) setDevToken(res.token);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      {done ? (
        <div className="card space-y-3 p-5 text-center">
          <MailCheck className="mx-auto text-ok" size={34} />
          <h2 className="font-bold">Check your inbox</h2>
          <p className="text-sm text-subtle">
            If an account exists for {email}, a reset link is on its way. It expires in one hour.
          </p>
          {devToken && (
            <p className="text-xs text-warn">
              Development mode:{' '}
              <Link className="underline" to={`/reset-password?token=${devToken}`}>
                open the reset link
              </Link>
            </p>
          )}
          <Link className="text-sm text-accent hover:underline" to="/login">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="card space-y-4 p-5">
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          <Field label="Account email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            <Mail size={15} /> Send reset link
          </Button>
          <p className="text-center text-xs">
            <Link className="text-accent hover:underline" to="/login">
              Back to sign in
            </Link>
          </p>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/v1/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      {done ? (
        <div className="card space-y-3 p-5 text-center">
          <CheckCircle2 className="mx-auto text-ok" size={34} />
          <h2 className="font-bold">Password updated</h2>
          <p className="text-sm text-subtle">
            All other sessions were signed out. Sign in with your new password.
          </p>
          <Link className="text-accent hover:underline" to="/login">
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="card space-y-4 p-5">
          {error && (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          <Field label="New password" hint="At least 10 characters.">
            <Input
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            <KeyRound size={15} /> Set new password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [message, setMessage] = useState('');
  const navigate = useNavigate();

  useState(() => {
    (async () => {
      if (!token) {
        setState('error');
        setMessage('Missing verification token.');
        return;
      }
      try {
        await api('/api/v1/auth/verify-email', { method: 'POST', body: { token } });
        setState('ok');
        setTimeout(() => navigate('/onboarding'), 1200);
      } catch (err) {
        setState('error');
        setMessage(err instanceof ApiError ? err.message : 'Verification failed.');
      }
    })();
  });

  return (
    <AuthCard>
      <div className="card space-y-3 p-5 text-center">
        {state === 'pending' && <p className="text-sm text-subtle">Verifying your email…</p>}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="mx-auto text-ok" size={34} />
            <h2 className="font-bold">Email verified</h2>
            <p className="text-sm text-subtle">Taking you to onboarding…</p>
          </>
        )}
        {state === 'error' && (
          <>
            <p className="text-danger">{message}</p>
            <Link className="text-accent hover:underline" to="/login">
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </AuthCard>
  );
}
