// Global step-up dialog (guide 07 §2.6, A-STEPUP UI side). The API client asks
// for step-up after 403 STEP_UP_REQUIRED; this dialog offers exactly the
// methods the server listed and resolves the pending request.

import { useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { setStepUpHandler } from '../lib/stepUpBus';
import { Button, Field, Input, Modal } from './ui';

type Method = 'password' | 'totp' | 'recovery_code' | 'passkey';

const METHOD_LABEL: Record<Method, string> = {
  password: 'Password',
  totp: 'Authenticator code',
  recovery_code: 'Recovery code',
  passkey: 'Passkey',
};

interface Pending {
  methods: Method[];
  resolve: (ok: boolean) => void;
}

export function StepUpDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [method, setMethod] = useState<Method>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resolveRef = useRef<(ok: boolean) => void>(() => undefined);

  useEffect(() => {
    setStepUpHandler((methodsRaw) => {
      const methods = (methodsRaw as Method[]).filter((m): m is Method => m in METHOD_LABEL);
      const first = methods[0] ?? 'password';
      setMethod(first);
      setPassword('');
      setCode('');
      setError('');
      setBusy(false);
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setPending({ methods, resolve });
      });
    });
    return () => setStepUpHandler(null);
  }, []);

  if (!pending) return null;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      let body: Record<string, unknown>;
      if (method === 'password') {
        body = { method: 'password', password };
      } else if (method === 'passkey') {
        const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
          '/api/v1/auth/step-up/passkey/options',
          { method: 'POST' },
        );
        const response = await startAuthentication({ optionsJSON });
        body = { method: 'passkey', response };
      } else {
        body = { method, code };
      }
      await api('/api/v1/auth/step-up', { method: 'POST', body });
      pending.resolve(true);
      setPending(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOO_MANY_ATTEMPTS') {
        setError('Too many attempts — wait a minute and try again.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('That credential was not accepted. Try again.');
      } else {
        setError(err instanceof Error ? err.message : 'Step-up failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        pending.resolve(false);
        setPending(null);
      }}
      title={
        <span className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-warn" /> Step-up required
        </span>
      }
    >
      <p className="text-sm text-subtle">
        This is a high-risk action. Re-authenticate to proceed. Commands never carry credentials.
      </p>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Step-up method">
        {pending.methods.map((m) => (
          <button
            key={m}
            onClick={() => {
              setMethod(m);
              setError('');
            }}
            aria-pressed={method === m}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${
              method === m ? 'border-accent bg-accent/15 text-accent' : 'border-line text-subtle'
            }`}
          >
            {METHOD_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-3">
        {method === 'password' && (
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        {(method === 'totp' || method === 'recovery_code') && (
          <Field label={METHOD_LABEL[method]}>
            <Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        {error && (
          <div
            className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            pending.resolve(false);
            setPending(null);
          }}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={
            busy ||
            (method === 'password' && !password) ||
            ((method === 'totp' || method === 'recovery_code') && !code)
          }
          onClick={() => void submit()}
        >
          {busy ? 'Checking…' : 'Authorize & send'}
        </Button>
      </div>
    </Modal>
  );
}
