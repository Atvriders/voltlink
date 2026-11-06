import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme } from './auth/AuthContext';
import { ErrorBoundary, RootErrorFallback } from './components/boundaries';
import { AnnouncerProvider } from './lib/announcer';
import { installDefaultPreloadGuard } from './lib/preloadGuard';

applyTheme();

// R2-37: a failing chunk may reload at most once per 30s — a persistent
// failure lands on the route error card instead of a blank reload loop.
installDefaultPreloadGuard();

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => console.error('[voltlink] uncaught:', error),
  onCaughtError: (error) => console.error('[voltlink] caught:', error),
}).render(
  <StrictMode>
    <AnnouncerProvider>
      <ErrorBoundary fallback={() => <RootErrorFallback />}>
        <App />
      </ErrorBoundary>
    </AnnouncerProvider>
  </StrictMode>,
);
