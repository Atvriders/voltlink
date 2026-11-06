// Sign-in page with TOTP step and passkey support.

import { useEffect, useState, type FormEvent } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../api/client';
import { ApiError } from '../api/client';
import { Button, Field, Input } from '../components/ui';

export default function LoginPage() {
  const { login, loginMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpEmail, setTotpEmail] = useState('');
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<{ needsSetup: boolean }>('/api/v1/auth/setup-status');
        if (alive) setNeedsSetup(!!res.needsSetup);
      } catch {
        /* the login page stays usable regardless */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await login(email, password);
      if (res.mfaRequired) {
        setTotpEmail(email);
        setMfaMethods(res.methods ?? []);
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async () => {
    setError('');
    setBusy(true);
    try {
      if (recoveryMode) {
        await loginMfa({ recoveryCode: totp });
      } else {
        await loginMfa({ code: totp });
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code was not accepted.');
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
      // A-PASSKEY: real /passkey/login/* routes with a simplewebauthn JSON
      // response, never a hand-built body.
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/api/v1/auth/passkey/login/options',
        {
          method: 'POST',
        },
      );
      const response = await startAuthentication({ optionsJSON });
      await api('/api/v1/auth/passkey/login/verify', {
        method: 'POST',
        body: { response },
      });
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
            <>
              <Field label={recoveryMode ? 'Recovery code' : 'Authentication code (TOTP)'}>
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  placeholder={recoveryMode ? 'Recovery code' : '6-digit code'}
                />
              </Field>
              {mfaMethods.includes('recovery_code') && (
                <label className="flex items-center gap-2 text-xs text-subtle">
                  <input
                    type="checkbox"
                    checked={recoveryMode}
                    onChange={(e) => setRecoveryMode(e.target.checked)}
                  />
                  Use a recovery code
                </label>
              )}
              <Button
                type="button"
                loading={busy}
                disabled={totp.length === 0}
                onClick={submitMfa}
                className="w-full"
              >
                <KeyRound size={15} /> Verify
              </Button>
            </>
          )}
          {!totpEmail && (
            <Button type="submit" loading={busy} className="w-full">
              <KeyRound size={15} /> Sign in
            </Button>
          )}
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
            {needsSetup && (
              <Link className="text-accent hover:underline" to="/setup">
                Set up this instance
              </Link>
            )}
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
