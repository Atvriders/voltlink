// Resumable first-run onboarding: welcome, privacy, security, demo/provider
// setup, units, timezone, retention, privacy zones, notifications, vehicle
// import, freshness explanation, control safety, WebGL intro, completion.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Lock,
  PlugZap,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, Field, ProgressBar, Select } from '../components/ui';

const STEPS = [
  { id: 'welcome', title: 'Welcome to VoltLink' },
  { id: 'privacy', title: 'Your data stays yours' },
  { id: 'security', title: 'Secure your account' },
  { id: 'provider', title: 'Vehicles' },
  { id: 'units', title: 'Units & time zone' },
  { id: 'retention', title: 'Data retention' },
  { id: 'privacy-zone', title: 'Privacy zone' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'freshness', title: 'How data freshness works' },
  { id: 'controls', title: 'Control safety' },
  { id: 'webgl', title: 'Your vehicle in 3D' },
  { id: 'done', title: 'You’re all set' },
] as const;

export default function OnboardingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(() => Number(localStorage.getItem('voltlink-onboarding') ?? 0));
  const [units, setUnits] = useState(user?.units ?? 'metric');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  const [retentionDays, setRetentionDays] = useState(365);
  const [notificationEnabled, setNotificationEnabled] = useState(true);

  useEffect(() => {
    localStorage.setItem('voltlink-onboarding', String(step));
  }, [step]);

  const saveSettings = useMutation({
    mutationFn: () => api('/api/v1/users/settings', { method: 'PATCH', body: { units, timezone } }),
  });
  const saveRetention = useMutation({
    mutationFn: () =>
      api('/api/v1/users/retention', {
        method: 'PATCH',
        body: { telemetryRetentionDays: retentionDays, locationRetentionDays: 90 },
      }),
  });
  const connectDemo = useMutation({
    mutationFn: () =>
      api<{ vehiclesImported: number }>('/api/v1/providers/demo/connect', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vehicles'] });
    },
  });

  const next = async () => {
    if (step >= STEPS.length - 1) {
      navigate('/');
      return;
    }
    if (STEPS[step]!.id === 'units') await saveSettings.mutateAsync();
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
      <ProgressBar value={(step + 1) * (100 / STEPS.length)} />
      <Card title={STEPS[step]!.title}>
        <div className="min-h-64 space-y-4">
          {step === 0 && (
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
          {step === 1 && (
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
          {step === 2 && (
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
          {step === 3 && (
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
          {step === 4 && (
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
          {step === 5 && (
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
          {step === 6 && (
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
          {step === 7 && (
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
          {step === 8 && (
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
          {step === 9 && (
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
          {step === 10 && (
            <Intro
              icon={<Boxes className="text-accent" size={30} />}
              body={
                <p className="text-sm text-subtle">
                  Your vehicle appears as a real-time 3D model that reflects its actual state —
                  doors, trunk, charge port, charging pulse, and lights. Rotate, zoom, and explore
                  in the showroom.
                </p>
              }
            />
          )}
          {step === 11 && (
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
