// VoltLink application shell and router.

import { lazy, Suspense, useEffect } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Shell } from './components/Shell';
import { StepUpDialogHost } from './components/StepUpDialog';
import { ErrorBoundary, RouteErrorFallback } from './components/boundaries';
import { Spinner } from './components/ui';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/ResetPasswordPage';
import PublicStatusPage from './pages/PublicStatusPage';
import PresentationPage from './pages/PresentationPage';

const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const LiveVehiclePage = lazy(() => import('./pages/LiveVehiclePage'));
const ShowroomPage = lazy(() => import('./pages/ShowroomPage'));
const MapPage = lazy(() => import('./pages/MapPage'));
const DrivesPage = lazy(() => import('./pages/DrivesPage'));
const DriveDetailPage = lazy(() => import('./pages/DriveDetailPage'));
const ChargingPage = lazy(() => import('./pages/ChargingPage'));
const BatteryPage = lazy(() => import('./pages/BatteryPage'));
const AutomationsPage = lazy(() => import('./pages/AutomationsPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const FleetPage = lazy(() => import('./pages/FleetPage'));
const ProvidersPage = lazy(() => import('./pages/ProvidersPage'));
const StatusAdminPage = lazy(() => import('./pages/StatusAdminPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false },
  },
});

function NotFoundPage() {
  return (
    <section role="alert" className="card mx-auto max-w-lg space-y-3 p-6">
      <h1 className="text-lg font-extrabold">Page not found</h1>
      <p className="text-sm text-subtle">That address does not exist in VoltLink.</p>
      <Link to="/" className="text-sm text-accent hover:underline">
        Back to Overview
      </Link>
    </section>
  );
}

function PageFallback() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner size={22} />
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageFallback />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AuthenticatedLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageFallback />;
  return (
    <Shell user={user}>
      <Suspense fallback={<PageFallback />}>
        <ErrorBoundary
          key={location.pathname}
          fallback={(error, reset) => (
            <RouteErrorFallback error={error} resetErrorBoundary={reset} />
          )}
        >
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/vehicles/:id" element={<LiveVehiclePage />} />
            <Route path="/showroom" element={<ShowroomPage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/drives" element={<DrivesPage />} />
            <Route path="/drives/:id" element={<DriveDetailPage />} />
            <Route path="/charging" element={<ChargingPage />} />
            <Route path="/battery" element={<BatteryPage />} />
            <Route path="/automations" element={<AutomationsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/status-admin" element={<StatusAdminPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/" element={<OverviewPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
      </Suspense>
    </Shell>
  );
}

function AppRoutes() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // N-PUSH: the service worker routes notification clicks back into the SPA.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'voltlink:navigate' && typeof event.data.path === 'string') {
        navigate(event.data.path as string);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, [navigate]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/status" element={<PublicStatusPage />} />
      <Route path="/presentation" element={<PresentationPage />} />
      <Route
        path="*"
        element={
          <Protected>
            <AuthenticatedLayout />
          </Protected>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <StepUpDialogHost />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
