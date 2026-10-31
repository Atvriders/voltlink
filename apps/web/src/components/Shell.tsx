// Application shell: desktop sidebar, mobile navigation, vehicle switcher,
// theme menu, and the real-time notifications bell.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { prepare } from '../lib/push';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { realtimeStart, realtimeStop } from '../lib/realtime';
import { useAuth } from '../auth/AuthContext';
import {
  Activity,
  Bell,
  Battery,
  BatteryCharging,
  Boxes,
  Car,
  ChevronDown,
  CircleUserRound,
  Gauge,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  Moon,
  Palette,
  PlugZap,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
  Zap,
  MonitorPlay,
} from 'lucide-react';
import { api } from '../api/client';
import { setTheme, THEMES } from '../auth/AuthContext';
import { Badge } from './ui';
import type { UserPublic, VehicleWithState } from '@voltlink/shared';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/vehicles', label: 'Vehicles', icon: Car },
  { to: '/showroom', label: 'Showroom', icon: Boxes },
  { to: '/map', label: 'Map', icon: MapIcon },
  { to: '/drives', label: 'Drives', icon: Gauge },
  { to: '/charging', label: 'Charging', icon: BatteryCharging },
  { to: '/battery', label: 'Battery', icon: Battery },
  { to: '/automations', label: 'Automations', icon: Zap },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/fleet', label: 'Fleet', icon: Users },
  { to: '/providers', label: 'Providers', icon: PlugZap },
  { to: '/status-admin', label: 'Status', icon: Activity },
  { to: '/admin', label: 'Administration', icon: ShieldCheck },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/logo.svg" alt="" className="h-8 w-8 rounded-lg" />
      <div className="leading-tight">
        <p className="text-base font-extrabold tracking-tight">VoltLink</p>
        <p className="text-[10px] uppercase tracking-widest text-faint">
          Connected Vehicle Platform
        </p>
      </div>
    </div>
  );
}

function useVehicles() {
  return useQuery({
    queryKey: ['vehicles'],
    queryFn: () => api<VehicleWithState[]>('/api/v1/vehicles'),
    refetchInterval: 30000,
  });
}

function useUnread() {
  return useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () =>
      api<{ unread: number }>('/api/v1/notifications?pageSize=1').then((d) => ({
        unread: (d as { unread?: number }).unread ?? 0,
      })),
    refetchInterval: 30000,
  });
}

function VehicleSwitcher() {
  const { data: vehicles } = useVehicles();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (id: string) => {
    setOpen(false);
    navigate(`/vehicles/${id}`);
  };

  if (!vehicles || vehicles.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-sm hover:border-faint"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Car size={15} className="text-accent" />
        <span className="hidden sm:inline">Fleet</span>
        <span className="text-faint">{vehicles.length}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl"
          role="listbox"
        >
          {vehicles.map((v) => (
            <button
              key={v.id}
              onClick={() => pick(v.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-panel2"
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: v.exteriorColor ?? '#8b9bb4' }}
                aria-hidden
              />
              <span className="flex-1 truncate">{v.displayName}</span>
              {v.state?.chargingState === 'charging' && (
                <Zap size={13} className="text-charging" aria-label="charging" />
              )}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            onClick={() => {
              setOpen(false);
              navigate('/showroom');
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-subtle hover:bg-panel2"
          >
            <Boxes size={14} /> Open showroom
          </button>
        </div>
      )}
    </div>
  );
}

function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-2 text-subtle hover:bg-panel2 hover:text-ink"
        aria-label="Theme"
        aria-expanded={open}
      >
        <Palette size={17} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-line bg-panel p-1 shadow-2xl"
          role="menu"
        >
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              onClick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-panel2"
            >
              {t.id.includes('light') ? <Sun size={14} /> : <Moon size={14} />}
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountMenu({ align = 'left', email }: { align?: 'left' | 'right'; email: string }) {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-subtle hover:bg-panel2 hover:text-ink"
        aria-label="Account menu"
        aria-expanded={open}
      >
        <CircleUserRound size={15} />
        <span className="min-w-0 flex-1 truncate">{email}</span>
      </button>
      {open && (
        <div
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} bottom-full z-40 mb-1 w-56 rounded-xl border border-line bg-panel p-1 shadow-2xl`}
          role="menu"
        >
          <p role="none" className="px-2.5 py-1.5 text-xs text-faint">
            Signed in as <span className="text-ink">{email}</span>
          </p>
          <Link
            to="/settings/profile"
            role="menuitem"
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-panel2"
            onClick={() => setOpen(false)}
          >
            <Settings size={15} /> Settings
          </Link>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-danger hover:bg-panel2"
          >
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Shell({ user, children }: { user: UserPublic | null; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const qc = useQueryClient();
  const { logout } = useAuth();
  const { data: unreadData } = useUnread();
  const unread = unreadData?.unread ?? 0;

  // N-PUSH: register the service worker + load VAPID config for signed-in users.
  useEffect(() => {
    if (!user) return;
    prepare().catch(() => undefined);
  }, [user]);

  // Real-time SSE via the singleton so sign-out can stop the stream before
  // the cache is cleared (F-SIGNOUT).
  useEffect(() => {
    realtimeStart({
      vehicle_state: () => void qc.invalidateQueries({ queryKey: ['vehicles'] }),
      notification: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
      command_finished: () => {
        void qc.invalidateQueries({ queryKey: ['commands'] });
        void qc.invalidateQueries({ queryKey: ['vehicles'] });
      },
    });
    return () => realtimeStop();
  }, [qc]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const active = NAV.find((n) =>
    n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to),
  );

  return (
    <div className="flex min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-panel lg:flex">
        <div className="flex h-16 items-center border-b border-line px-4">
          <Link to="/">
            <Logo />
          </Link>
        </div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main navigation">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${
                  isActive || (item.to === '/' && location.pathname === '/')
                    ? 'bg-accent/15 text-accent'
                    : 'text-subtle hover:bg-panel2 hover:text-ink'
                }`
              }
            >
              <item.icon size={16} />
              {item.label}
              {item.to === '/notifications' && unread > 0 && (
                <span className="ml-auto rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">
                  {unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <Link
            to="/presentation"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-subtle hover:bg-panel2 hover:text-ink"
          >
            <MonitorPlay size={16} /> Presentation mode
          </Link>
          <div className="mt-1">
            <AccountMenu email={user?.email ?? ''} />
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-line bg-panel p-2">
            <div className="flex h-14 items-center justify-between border-b border-line px-2">
              <Logo />
              <button
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-lg p-2 text-subtle hover:bg-panel2"
              >
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className="mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-subtle hover:bg-panel2 hover:text-ink"
                >
                  <item.icon size={16} /> {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="border-t border-line p-2">
              <button
                onClick={() => {
                  setMobileOpen(false);
                  void logout();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-danger hover:bg-panel2"
              >
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-line bg-canvas/90 px-3 backdrop-blur sm:px-4">
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg p-2 text-subtle hover:bg-panel2 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={18} />
            </button>
            <div className="lg:hidden">
              <Logo />
            </div>
            <h1 className="hidden text-sm font-bold text-subtle lg:block">
              {active?.label ?? 'Overview'}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <VehicleSwitcher />
            <Link
              to="/notifications"
              className="relative rounded-lg p-2 text-subtle hover:bg-panel2 hover:text-ink"
              aria-label={`Notifications (${unread} unread)`}
            >
              <Bell size={17} />
              {unread > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-danger" />
              )}
            </Link>
            <div className="lg:hidden">
              <AccountMenu align="right" email={user?.email ?? ''} />
            </div>
            <ThemeMenu />
            <Link
              to="/settings/profile"
              className="rounded-lg p-2 text-subtle hover:bg-panel2 hover:text-ink"
              aria-label="Settings"
            >
              <Settings size={17} />
            </Link>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-3 sm:p-5">{children}</main>

        {/* Mobile bottom nav */}
        <nav
          className="sticky bottom-0 z-20 flex justify-around border-t border-line bg-panel px-1 py-1.5 lg:hidden"
          aria-label="Mobile navigation"
        >
          {NAV.slice(0, 5).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 text-[10px] ${isActive ? 'text-accent' : 'text-faint'}`
              }
              aria-label={item.label}
            >
              <item.icon size={17} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ChargingBadge() {
  return (
    <Badge tone="charging" pulse>
      Charging
    </Badge>
  );
}
