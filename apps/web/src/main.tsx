import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { isAppPath, isDemoPath, isPrivacyPath } from './lib/router';
import './styles.css';

// Each page loads only its own code: the landing page stays light, the app loads under /app.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })));
const Landing = lazy(() => import('./components/Landing').then((m) => ({ default: m.Landing })));
const PrivacyPage = lazy(() => import('./components/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const DemoPage = lazy(() => import('./components/DemoPage').then((m) => ({ default: m.DemoPage })));

const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
// An installed Segue opens straight into the app.
if (!isAppPath(window.location.pathname) && !isPrivacyPath(window.location.pathname) && !isDemoPath(window.location.pathname) && standalone) history.replaceState(null, '', '/app');

/** Landing page, app or privacy policy, following the address bar. Landing and app switch without a page load. */
function Root() {
  const [inApp, setInApp] = useState(() => isAppPath(window.location.pathname));
  useEffect(() => {
    const on = () => setInApp(isAppPath(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const path = window.location.pathname;
  const page = inApp ? <App /> : isPrivacyPath(path) ? <PrivacyPage /> : isDemoPath(path) ? <DemoPage /> : <Landing />;
  return <Suspense fallback={<div className="boot" aria-busy="true" />}>{page}</Suspense>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env?.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a bonus, never a blocker */
    });
  });
}
