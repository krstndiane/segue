/**
 * A tiny router: the landing page at "/", the app under "/app".
 * History API only, no dependency. Links keep the query string (e.g. ?sky=storm).
 */
import { useEffect, useState } from 'react';

export type Route = 'today' | 'plan' | 'days' | 'routines' | 'calendar' | 'together';

const PATHS: Record<Route, string> = {
  today: '/app',
  plan: '/app/plan',
  days: '/app/days',
  routines: '/app/routines',
  calendar: '/app/calendar',
  together: '/app/together',
};

export const isAppPath = (path: string) => path === '/app' || path.startsWith('/app/');

/** The guided demo with sample data. */
export const isDemoPath = (path: string) => path.replace(/\/+$/, '') === '/demo';

/** The privacy policy page. */
export const isPrivacyPath = (path: string) => path.replace(/\/+$/, '') === '/privacy';

export function routeFor(path: string): Route {
  const clean = path.replace(/\/+$/, '') || '/';
  return (Object.keys(PATHS) as Route[]).find((r) => PATHS[r] === clean) ?? 'today';
}

export function pathFor(route: Route): string {
  return PATHS[route];
}

export function navigate(route: Route, { replace = false } = {}) {
  const url = PATHS[route] + window.location.search;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeFor(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(routeFor(window.location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}

/** From the landing page into the app, keeping what's in memory (like a Google sign-in). */
export function enterApp(query = window.location.search) {
  history.pushState(null, '', `/app${query}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0 });
}
