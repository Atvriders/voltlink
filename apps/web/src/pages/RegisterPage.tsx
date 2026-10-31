// Account registration page.

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Field, Input } from '../components/ui';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<{ token?: string; link?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api<{
        user: { id: string };
        verification?: { token?: string; link?: string; sent?: boolean };
      }>('/api/v1/auth/register', {
        method: 'POST',
        body: { name, email, password },
      });
      await refresh();
      if (res.verification?.token)
        setVerification({ token: res.verification.token, link: res.verification.link });
      else navigate('/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="VoltLink" className="h-14 w-14 rounded-2xl" />
          <h1 className="text-xl font-extrabold">Create your VoltLink account</h1>
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
          {verification && (
            <div className="rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
              <p className="font-semibold">Account created.</p>
              <p className="mt-1 text-xs">
                In development mode, verify instantly with{' '}
                <Link className="underline" to={`/verify-email?token=${verification.token}`}>
                  this link
                </Link>{' '}
                or continue to
                <Link className="underline" to="/onboarding">
                  {' '}
                  onboarding
                </Link>
                .
              </p>
            </div>
          )}
          <Field label="Name">
            <Input
              autoComplete="name"
              required
              maxLength={80}
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
          <Field label="Password" hint="At least 10 characters.">
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Button type="submit" loading={busy} className="w-full">
            <UserPlus size={15} /> Create account
          </Button>
          <p className="text-center text-xs text-subtle">
            Already have an account?{' '}
            <Link className="text-accent hover:underline" to="/login">
              Sign in
            </Link>
          </p>
        </form>
        <p className="mt-4 text-center text-xs text-faint">
          Your data stays on your server. VoltLink never sells or shares it.
        </p>
      </div>
    </div>
  );
}
