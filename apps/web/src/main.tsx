import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme } from './auth/AuthContext';
import { ErrorBoundary, RootErrorFallback } from './components/boundaries';
import { AnnouncerProvider } from './lib/announcer';

applyTheme();

// F-WEBGLBLANK: nothing — not even a WebGL or chunk error — may blank the app.
window.addEventListener('vite:preloadError', () => location.reload());

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
