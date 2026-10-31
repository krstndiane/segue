import type { ReactNode } from 'react';
import { pathFor, type Route } from '../lib/router';

/** The tabs a person moves between. "calendar" (connecting Google) belongs to the Calendar tab. */
export type NavTab = 'today' | 'plan' | 'days' | 'routines' | 'together';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS: Record<NavTab, ReactNode> = {
  // a sun on the horizon: today
  today: (
    <>
      <path d="M4 17h16" {...stroke} />
      <path d="M7.5 17a4.5 4.5 0 0 1 9 0" {...stroke} />
      <path d="M12 5.5v2M5.6 8.6l1.4 1.4M18.4 8.6 17 10" {...stroke} />
    </>
  ),
  // a list with a plus: things to plan
  plan: (
    <>
      <path d="M5 7h9M5 12h9M5 17h5" {...stroke} />
      <path d="M17.5 14v6M14.5 17h6" {...stroke} />
    </>
  ),
  days: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" {...stroke} />
      <path d="M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5" {...stroke} />
    </>
  ),
  // a loop: things that repeat
  routines: (
    <>
      <path d="M19 12a7 7 0 0 1-12 4.9" {...stroke} />
      <path d="M5 12a7 7 0 0 1 12-4.9" {...stroke} />
      <path d="M17.5 3.8v3.6h-3.6M6.5 20.2v-3.6h3.6" {...stroke} />
    </>
  ),
  together: (
    <>
      <circle cx="9" cy="9" r="3" {...stroke} />
      <circle cx="16.5" cy="10" r="2.4" {...stroke} />
      <path d="M3.8 19a5.2 5.2 0 0 1 10.4 0M14 15.4a4.4 4.4 0 0 1 6.2 3.6" {...stroke} />
    </>
  ),
};

const LABELS: Record<NavTab, string> = { today: 'Today', plan: 'Plan', days: 'Calendar', routines: 'Routines', together: 'Together' };

/**
 * The app's sections, along the bottom where a thumb reaches them. Real links,
 * so a long press, a middle click or "open in new tab" all work, and the
 * address bar, refresh, back and forward follow along (see router.ts).
 */
export function BottomNav({ route, together, badge, onGo }: { route: Route; together: boolean; badge: number; onGo: (r: Route) => void }) {
  const current: NavTab = route === 'calendar' ? 'days' : route;
  const tabs: NavTab[] = together ? ['today', 'plan', 'days', 'routines', 'together'] : ['today', 'plan', 'days', 'routines'];
  return (
    <nav className="bottom-nav" aria-label="Sections">
      <ul>
        {tabs.map((t) => (
          <li key={t}>
            <a
              href={pathFor(t)}
              aria-current={current === t ? 'page' : undefined}
              aria-label={t === 'together' && badge ? `Together, ${badge} new` : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onGo(t);
              }}
            >
              <span className="bn-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24">
                  {ICONS[t]}
                </svg>
                {t === 'together' && badge > 0 && <span className="bn-badge">{badge > 9 ? '9+' : badge}</span>}
              </span>
              <span className="bn-label">{LABELS[t]}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
