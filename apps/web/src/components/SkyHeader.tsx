import { useEffect, useMemo, type CSSProperties } from 'react';
import { longDate } from '../lib/format';
import { CHIP_ALPHA, headerScrim } from '../lib/pageTheme';
import { toneAt } from '../lib/skyRenderer';
import type { LocationStatus } from '../lib/locationStatus';
import { skyWords, type SkyView } from '../lib/weather';
import { Sky, sceneFor } from './Sky';

export type View = 'today' | 'plan' | 'days' | 'routines' | 'together';

interface Props {
  sky: SkyView;
  now: Date;
  view: View;
  onView: (v: View) => void;
  location: LocationStatus;
  onSettings: () => void;
  /** opens the planning assistant; no button when missing */
  onAssistant?: () => void;
  tempUnit: 'C' | 'F';
  /** first-run setup hides the tabs */
  showNav?: boolean;
  /** show the Together tab (accounts are on in this build) */
  together?: boolean;
  /** unread updates and invitations waiting, on the Together tab */
  badge?: number;
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.3" fill="currentColor" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** What a screen reader hears for the pin. */
const pinLabel = (l: LocationStatus) =>
  l.source === 'finding' ? 'Finding your location' : `Sky for ${l.label}${l.note ? `. ${l.note}` : ''}`;

const temp = (c: number, unit: 'C' | 'F') => `${Math.round(unit === 'F' ? (c * 9) / 5 + 32 : c)}°`;

export function SkyHeader({ sky, now, view, onView, location, onSettings, onAssistant, tempUnit, showNav = true, together = false, badge = 0 }: Props) {
  // A new scene object only when something the renderer draws has changed.
  const scene = useMemo(
    () => sceneFor(sky),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sky.condition, sky.sun?.elevation, sky.sun?.morning, sky.sun?.progress, sky.moon?.cycle, sky.moonPath, sky.southern],
  );
  const tone = toneAt(scene.condition, scene.elevation, scene.morning);
  const top = tone.sky[0];
  // As dark behind the text as this sky needs for AA, and no darker.
  const contrastVars = { '--scrim': String(headerScrim(tone)), '--chip': String(CHIP_ALPHA) } as CSSProperties;

  // Back to the neutral default from index.html when the header goes away.
  // (Declared first, so it reads the neutral colour before the sky's is set.)
  useEffect(() => {
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const neutral = metas.map((m) => m.getAttribute('content'));
    return () => metas.forEach((m, i) => m.setAttribute('content', neutral[i] ?? ''));
  }, []);
  // Tint the phone's status bar to match the sky and time of day.
  useEffect(() => {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', top));
  }, [top]);

  return (
    <header className="sky-band" style={contrastVars}>
      <Sky scene={scene} />
      <div className="sky-content">
        <div className="top">
          <div className="brand">
            <h1 className="wordmark">
              <img src="/wordmark-light.svg" alt="Segue" />
            </h1>
            <p className="date">{longDate(now)}</p>
          </div>
          {showNav && (
            <div className="top-actions">
              <nav className="tabs" aria-label="Sections">
                <button type="button" aria-current={view === 'today' ? 'page' : undefined} onClick={() => onView('today')}>
                  Today
                </button>
                <button type="button" aria-current={view === 'plan' ? 'page' : undefined} onClick={() => onView('plan')}>
                  Plan
                </button>
                <button type="button" aria-current={view === 'days' ? 'page' : undefined} onClick={() => onView('days')}>
                  Calendar
                </button>
                <button type="button" aria-current={view === 'routines' ? 'page' : undefined} onClick={() => onView('routines')}>
                  Routines
                </button>
                {together && (
                  <button
                    type="button"
                    aria-current={view === 'together' ? 'page' : undefined}
                    aria-label={badge ? `Together, ${badge} new` : undefined}
                    onClick={() => onView('together')}
                  >
                    Together
                    {badge > 0 && (
                      <span className="tab-badge" aria-hidden="true">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </button>
                )}
              </nav>
              {onAssistant && (
                <button type="button" className="gear ask" aria-label="Ask about your day" onClick={onAssistant}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    <path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
              <button type="button" className="gear" aria-label="Settings" onClick={onSettings}>
                <GearIcon />
              </button>
            </div>
          )}
        </div>

        <div className="weather-line" aria-live="polite">
          <span className="weather-now">
            {sky.known ? (
              <>
                {sky.temperatureC !== undefined && <span className="temp">{temp(sky.temperatureC, tempUnit)}</span>}
                <span className="condition">
                  {skyWords(sky)}
                  {sky.details?.feelsLikeC !== undefined &&
                    (sky.temperatureC === undefined || Math.abs(sky.details.feelsLikeC - sky.temperatureC) >= 2) && (
                      <span className="feels"> · feels {temp(sky.details.feelsLikeC, tempUnit)}</span>
                    )}
                </span>
                {sky.preview && <span className="preview-tag">Preview</span>}
              </>
            ) : (
              <span className="condition">No weather right now</span>
            )}
          </span>
          {/* Where the sky is. A status, not a control: Segue finds the location on its own. */}
          <p className={`where-button${location.source === 'here' ? ' on' : ' stand-in'}`} role="status" aria-label={pinLabel(location)}>
            <PinIcon />
            <span className="where-name">{location.label}</span>
            {location.note && <span className="where-note">{location.note}</span>}
          </p>
        </div>
      </div>
    </header>
  );
}
