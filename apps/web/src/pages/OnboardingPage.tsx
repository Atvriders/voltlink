// Resumable first-run onboarding: welcome, privacy, security, demo/provider
// setup, units, timezone, retention, privacy zones, notifications, vehicle
// import, freshness explanation, control safety, WebGL intro, completion.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Lock,
  PlugZap,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Field, ProgressBar, Select, Spinner } from '../components/ui';

// Mirrors the server's 16 validated ids (GET/PUT /api/v1/users/onboarding).
const STEPS = [
  { id: 'welcome', title: 'Welcome to VoltLink' },
  { id: 'privacy', title: 'Your data stays yours' },
  { id: 'account', title: 'Your account' },
  { id: 'email', title: 'Verify your email' },
  { id: 'security', title: 'Secure your account' },
  { id: 'provider', title: 'Vehicles' },
  { id: 'units', title: 'Units' },
  { id: 'timezone', title: 'Time zone' },
  { id: 'retention', title: 'Data retention' },
  { id: 'privacy-zone', title: 'Privacy zone' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'import', title: 'Import your vehicles' },
  { id: 'sharing', title: 'Sharing & access' },
  { id: 'freshness', title: 'How data freshness works' },
  { id: 'controls', title: 'Control safety' },
  { id: 'done', title: 'You’re all set' },
] as const;
const stepId = (i: number) => STEPS[i]?.id;

export default function OnboardingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [verified, setVerified] = useState(user?.emailVerified === true);
  // F-ONBOARD: resume state lives on the server, never in localStorage.
  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ step: string; completedAt: string | null }>(
          '/api/v1/users/onboarding',
        );
        if (data.completedAt) {
          navigate('/');
          return;
        }
        const idx = STEPS.findIndex((s) => s.id === data.step);
        setStep(idx >= 0 ? idx : 0);
      } catch {
        /* first run: start at welcome */
      }
      setLoaded(true);
    })();
  }, [navigate]);
  const persist = (id: string) =>
    api('/api/v1/users/onboarding', { method: 'PUT', body: { step: id } }).catch(() => undefined);
  const resend = async () => {
    await api('/api/v1/auth/resend-verification', { method: 'POST' });
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const me = await api<{ user: { emailVerified: boolean } }>('/api/v1/auth/me');
      if (me.user.emailVerified) {
        setVerified(true);
        return;
      }
    }
  };
  const [units, setUnits] = useState(user?.units ?? 'metric');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [retentionDays, setRetentionDays] = useState(365);
  const [notificationEnabled, setNotificationEnabled] = useState(true);

  const saveSettings = useMutation({
    mutationFn: () => api('/api/v1/users/settings', { method: 'PATCH', body: { units, timezone } }),
  });
  const saveRetention = useMutation({
    mutationFn: async () => {
      // Z-RETENTION: retention is per organization now (guide 07 §2.9 step 9).
      const me = await api<{ memberships: { organizationId: string }[] }>('/api/v1/auth/me');
      const orgId = me.memberships[0]?.organizationId;
      if (!orgId) throw new Error('No organization');
      // Only telemetry is touched during onboarding: lowering location
      // retention would demand step-up (Z-RETENTION), which onboarding must
      // never force on a fresh account.
      await api(`/api/v1/orgs/${orgId}/settings/retention`, {
        method: 'PATCH',
        body: { telemetryRetentionDays: retentionDays },
      });
    },
  });
  const connectDemo = useMutation({
    mutationFn: () =>
      api<{ vehiclesImported: number }>('/api/v1/providers/demo/connect', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
  });

  useEffect(() => {
    if (loaded) void persist(STEPS[step]!.id);
  }, [step, loaded]);

  if (!loaded) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  const next = async () => {
    if (step >= STEPS.length - 1) {
      await api('/api/v1/users/onboarding', {
        method: 'PUT',
        body: { step: 'done', done: true },
      }).catch(() => undefined);
      navigate('/');
      return;
    }
    if (STEPS[step]!.id === 'units') await saveSettings.mutateAsync();
    if (STEPS[step]!.id === 'timezone') await saveSettings.mutateAsync();
    if (STEPS[step]!.id === 'retention') await saveRetention.mutateAsync();
    setStep((s) => s + 1);
  };

  const skipDemo = () => setStep(STEPS.findIndex((s) => s.id === 'units'));

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-6">
      <div className="flex items-center justify-between">
        <Badge tone="accent">
          Onboarding · step {step + 1} of {STEPS.length}
        </Badge>
        <Link to="/" className="text-sm text-subtle hover:text-accent">
          Skip — I know what I’m doing
        </Link>
      </div>
      <ProgressBar label="Onboarding progress" value={(step + 1) * (100 / STEPS.length)} />
      <Card title={STEPS[step]!.title}>
        <div className="min-h-64 space-y-4">
          {stepId(step) === 'account' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                Signed in as <strong>{user?.email}</strong>.
              </p>
              <p className="text-sm text-subtle">
                Your account is already created — nothing to fill in.
              </p>
            </div>
          )}
          {stepId(step) === 'email' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                {verified
                  ? 'Your email address is verified.'
                  : 'Check your inbox for the verification link.'}
              </p>
              {!verified && (
                <Button onClick={() => void resend()}>Resend verification email</Button>
              )}
            </div>
          )}
          {stepId(step) === 'welcome' && (
            <Intro
              body={
                <p className="text-sm text-subtle">
                  VoltLink connects your vehicles, tracks every drive and charge, automates
                  routines, and keeps your data on your own server. This short setup covers privacy,
                  security, and how your fleet appears.
                </p>
              }
            />
          )}
          {stepId(step) === 'privacy' && (
            <Intro
              icon={<Lock className="text-ok" size={30} />}
              body={
                <ul className="list-disc space-y-1 pl-5 text-sm text-subtle">
                  <li>
                    Vehicle locations and trip history are sensitive data — VoltLink stores them
                    only on your server.
                  </li>
                  <li>Provider credentials are encrypted at rest with a key only you control.</li>
                  <li>You can export everything or delete it permanently at any time.</li>
                  <li>Privacy zones redact addresses you consider private.</li>
                </ul>
              }
            />
          )}
          {stepId(step) === 'security' && (
            <Intro
              icon={<ShieldCheck className="text-accent" size={30} />}
              body={
                <p className="text-sm text-subtle">
                  Later, enable two-factor authentication and register a passkey in{' '}
                  <Link className="text-accent underline" to="/settings/security">
                    Settings → Security
                  </Link>
                  . High-risk vehicle commands (unlock, remote start, valet) always require
                  re-authentication.
                </p>
              }
            />
          )}
          {stepId(step) === 'provider' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                Connect a real provider (Tesla official API or optional Tessie token) or explore
                with the fictional demo fleet — a provider outage never blocks demo mode.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="secondary"
                  onClick={() => connectDemo.mutate(undefined, { onSuccess: () => next() })}
                  loading={connectDemo.isPending}
                >
                  <FlaskConical size={14} /> Enable demo fleet
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigate('/providers');
                  }}
                >
                  <PlugZap size={14} /> Connect real provider
                </Button>
              </div>
              {connectDemo.data && (
                <Badge tone="ok">
                  {connectDemo.data.vehiclesImported} fictional vehicles imported
                </Badge>
              )}
              <Button variant="ghost" onClick={skipDemo}>
                I have no vehicles yet — continue
              </Button>
            </div>
          )}
          {stepId(step) === 'units' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Units">
                <Select
                  value={units}
                  onChange={(e) => setUnits(e.target.value as 'metric' | 'imperial')}
                >
                  <option value="metric">Metric (km, °C)</option>
                  <option value="imperial">Imperial (mi, °F)</option>
                </Select>
              </Field>
            </div>
          )}
          {stepId(step) === 'timezone' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                Times and dates follow your zone. UTC always comes first.
              </p>
              <Field label="Time zone">
                <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {timezoneList().map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {stepId(step) === 'retention' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                How long should raw telemetry be kept? Location history can be retained separately
                and more aggressively.
              </p>
              <Field label="Telemetry retention">
                <Select
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Number(e.target.value))}
                >
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                  <option value={365}>1 year</option>
                  <option value={1825}>5 years</option>
                </Select>
              </Field>
            </div>
          )}
          {stepId(step) === 'privacy-zone' && (
            <Intro
              icon={<Lock className="text-info" size={30} />}
              body={
                <p className="text-sm text-subtle">
                  A privacy zone around your home redacts its address in the app. Demo mode already
                  includes one — create your own in Settings → Privacy & data, or on the map.
                </p>
              }
            />
          )}
          {stepId(step) === 'notifications' && (
            <div className="space-y-2">
              <p className="text-sm text-subtle">
                Choose how VoltLink reaches you. Every channel can be fine-tuned per event later.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--vl-accent)]"
                  checked={notificationEnabled}
                  onChange={(e) => setNotificationEnabled(e.target.checked)}
                />
                In-app notifications (recommended)
              </label>
            </div>
          )}
          {stepId(step) === 'import' && (
            <div className="space-y-3">
              <p className="text-sm text-subtle">
                Your provider's vehicles are listed here for confirmation before they appear in
                VoltLink. Demo vehicles import automatically the moment you enable the demo fleet.
              </p>
            </div>
          )}
          {stepId(step) === 'freshness' && (
            <Intro
              icon={<Sparkles className="text-accent" size={30} />}
              body={
                <ul className="list-disc space-y-1 pl-5 text-sm text-subtle">
                  <li>
                    <strong>Live</strong> — fresh from the provider moments ago.
                  </li>
                  <li>
                    <strong>Recently updated</strong> — cached minutes ago.
                  </li>
                  <li>
                    <strong>Stale / last known</strong> — the vehicle is asleep or the provider is
                    unreachable.
                  </li>
                  <li>
                    VoltLink never repeatedly wakes a sleeping vehicle just to refresh a dashboard.
                  </li>
                </ul>
              }
            />
          )}
          {stepId(step) === 'controls' && (
            <Intro
              icon={<ShieldCheck className="text-warn" size={30} />}
              body={
                <p className="text-sm text-subtle">
                  Every command runs through the server with ownership, role, and capability checks.
                  Sensitive commands require re-authentication, and the displayed vehicle state only
                  changes when the provider or telemetry confirms it — never on a button press.
                </p>
              }
            />
          )}
          {stepId(step) === 'sharing' && (
            <Intro
              icon={<Users className="text-accent" size={30} />}
              body={
                <p className="text-sm text-subtle">
                  Invite teammates from Settings → Privacy & data. Every member has a role with
                  explicit permissions — viewers never issue vehicle commands, and only the owner
                  can invite or remove people.
                </p>
              }
            />
          )}
          {stepId(step) === 'done' && (
            <div className="space-y-2 text-center">
              <Check className="mx-auto text-ok" size={36} />
              <h2 className="text-lg font-extrabold">You’re all set</h2>
              <p className="text-sm text-subtle">
                Your VoltLink instance is ready. Explore the overview, drives, charging, and fleet
                views.
              </p>
            </div>
          )}
        </div>
      </Card>
      <div className="flex justify-between">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          <ChevronLeft size={14} /> Back
        </Button>
        <Button onClick={next}>
          {step === STEPS.length - 1 ? 'Open VoltLink' : 'Continue'} <ChevronRight size={14} />
        </Button>
      </div>
    </div>
  );
}

function Intro({ icon, body }: { icon?: React.ReactNode; body: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {icon}
      {body}
    </div>
  );
}

function timezoneList(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
    ];
  }
}
