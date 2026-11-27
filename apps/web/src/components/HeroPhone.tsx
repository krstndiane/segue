import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Nudge } from '../lib/nudges';
import { applyAlternative, type AlternativesOutcome } from '../lib/alternatives';
import { DEMO_IDS, DEMO_PLACES, demoOptions, demoStart } from '../lib/demo';
import { clock } from '../lib/format';
import { AlternativesBody } from './AlternativesSheet';
import { Timeline } from './Timeline';

/**
 * The hero's phone: Segue's real Today screen on the sample day, played as a
 * short story. A planned day, rain on the outdoor workout, See options, Segue
 * checking what's open and still fits, the person choosing one, and the day
 * updated with Class where it was. Everything shown is drawn by the app's own
 * components from the sample day and the real alternatives engine; nothing is
 * stored, and nothing on the phone can be pressed.
 *
 * It loops on its own, only while it's on screen and the tab is visible.
 * With reduced motion it holds still on the rain frame.
 */

type SceneId = 'day' | 'scroll' | 'rain' | 'tapOptions' | 'checking' | 'options' | 'tapUse' | 'done';
const SCENES: { id: SceneId; ms: number; caption: string }[] = [
  { id: 'day', ms: 1300, caption: 'Your day, planned' },
  { id: 'scroll', ms: 1700, caption: 'A look at the rest of the day' },
  { id: 'rain', ms: 1700, caption: 'Rain on the outdoor workout' },
  { id: 'tapOptions', ms: 1000, caption: 'See options' },
  { id: 'checking', ms: 1000, caption: 'Checking what’s open' },
  { id: 'options', ms: 2300, caption: 'Comparing options' },
  { id: 'tapUse', ms: 1000, caption: 'You pick one' },
  { id: 'done', ms: 2800, caption: 'Updated. Class didn’t move' },
]
/** The still frame: the moment that sets up the whole story. */
const STILL = 2;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function HeroPhone() {
  const base = useMemo(() => demoStart(), []);
  const rain = useMemo(() => ({ ...base, raining: true }), [base]);
  const result = useMemo(() => demoOptions(rain), [rain]);
  // The person scrolls past the first option and picks the second, as people do when comparing.
  const chosen = result.options[1] ?? result.options[0];
  const after = useMemo(() => (chosen ? applyAlternative(base.day, chosen) : base.day), [base, chosen]);
  const workout = base.day.plan!.items.find((i) => i.blockId === DEMO_IDS.workout)!;
  const cls = base.day.plan!.items.find((i) => i.blockId === DEMO_IDS.class)!;

  // The first two options, as the sheet lists them; the rest would be below the fold of a real phone.
  const outcome: AlternativesOutcome = useMemo(
    () => ({
      result: { ...result, options: result.options.slice(0, 2), excluded: [], notes: [] },
      places: DEMO_PLACES,
      source: 'device',
      warnings: [],
      request: { blockId: DEMO_IDS.workout } as AlternativesOutcome['request'],
    }),
    [result],
  );

  const [scene, setScene] = useState(() => (reducedMotion() ? STILL : 0));
  // Always looping; with reduced motion it holds still on the rain frame instead.
  const [paused, setPaused] = useState(() => reducedMotion());
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [still, setStill] = useState(reducedMotion);
  const frame = useRef<HTMLDivElement>(null);
  /** The finger: where it is, whether it's touching the glass, and whether it's in view. */
  const [finger, setFinger] = useState({ x: 0, y: 0, down: false, show: false });
  /** How far the Today screen and the sheet are scrolled, in the screen's own (unzoomed) pixels. */
  const [todayY, setTodayY] = useState(0);
  const [sheetY, setSheetY] = useState(0);

  const id = SCENES[scene]!.id;
  const raining = id !== 'day' && id !== 'scroll';
  const sheetOpen = id === 'checking' || id === 'options' || id === 'tapUse';
  const updated = id === 'done';
  const running = !paused && onScreen && tabVisible;

  // Follow reduced-motion changes while the page is open.
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const on = () => {
      setStill(m.matches);
      setPaused(m.matches);
    };
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);

  // Only while the phone is on screen and the tab is visible.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(!!e?.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    const vis = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', vis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setScene((s) => (s + 1) % SCENES.length), SCENES[scene]!.ms);
    return () => window.clearTimeout(t);
  }, [running, scene]);

  // The finger and the scrolling, scene by scene. Taps land on the real buttons, measured, at any size.
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    const timers: number[] = [];
    const later = (ms: number, f: () => void) => timers.push(window.setTimeout(f, still ? 0 : ms));
    const box = root.getBoundingClientRect();
    const at = (fx: number, fy: number) => ({ x: box.width * fx, y: box.height * fy });
    const centre = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left - box.left + b.width / 2, y: b.top - box.top + b.height / 2 };
    };
    root.querySelectorAll('.lp-tapped').forEach((b) => b.classList.remove('lp-tapped'));
    const tapOn = (sel: string, reach: number) => {
      const el = root.querySelector(sel);
      const c = centre(el);
      if (!el || !c) return;
      setFinger((f) => ({ ...f, ...c, show: true, down: false }));
      later(reach, () => {
        setFinger((f) => ({ ...f, down: true }));
        el.classList.add('lp-tapped');
      });
      later(reach + 220, () => setFinger((f) => ({ ...f, down: false })));
    };

    if (id === 'day') {
      setTodayY(0);
      setSheetY(0);
      setFinger({ ...at(0.62, 1.05), down: false, show: false });
    } else if (id === 'scroll') {
      // A thumb drags up the timeline to look at later today, then lets go.
      setFinger({ ...at(0.62, 0.86), down: false, show: true });
      later(120, () => setFinger((f) => ({ ...f, down: true })));
      later(260, () => {
        setFinger((f) => ({ ...f, ...at(0.6, 0.5) }));
        setTodayY(-190);
      });
      later(1050, () => setFinger((f) => ({ ...f, down: false, show: false })));
    } else if (id === 'rain') {
      // The notice arrives; the screen springs back to the top to show it.
      setTodayY(0);
      setFinger((f) => ({ ...f, show: false, down: false }));
    } else if (id === 'tapOptions') {
      tapOn('.nudge .ghost', 480);
    } else if (id === 'checking') {
      setFinger((f) => ({ ...f, ...at(0.7, 1.05), show: false }));
    } else if (id === 'options') {
      // Swipe up the sheet to see the second option.
      setSheetY(0);
      setFinger({ ...at(0.55, 0.9), down: false, show: true });
      later(500, () => setFinger((f) => ({ ...f, down: true })));
      later(640, () => {
        setFinger((f) => ({ ...f, ...at(0.55, 0.62) }));
        setSheetY(-235);
      });
      later(1400, () => setFinger((f) => ({ ...f, down: false })));
    } else if (id === 'tapUse') {
      tapOn('.lp-phone-sheet .alt-option:nth-child(2) .primary', 420);
    } else if (id === 'done') {
      setFinger((f) => ({ ...f, ...at(0.75, 1.08), show: false, down: false }));
      later(600, () => setSheetY(0));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [id, still]);

  const nudges: Nudge[] = raining && !updated ? [{ id: 'rain', kind: 'rain', title: `It's raining, and ${workout.title} is outdoors`, body: 'See options that still leave time for Class.', action: 'options', item: workout, at: 0 }] : [];
  const stop = updated && chosen?.place ? { name: chosen.place.name, when: `${clock(chosen.start)} · indoors`, cls: 'changed' } : { name: workout.place!.name, when: `${clock(workout.start)} · ${raining ? 'rain' : 'outdoors'}`, cls: raining ? 'hit' : '' };

  return (
    <figure className={`lp-preview lp-hero-phone scene-${id}${still ? ' still' : ''}`}>
      <ol className="lp-ribbon" aria-label="The sample day's route">
        <li>
          <i aria-hidden="true" />
          <strong>Home</strong>
          <span>Now</span>
        </li>
        <li className={stop.cls}>
          <i aria-hidden="true" />
          <strong>{stop.name}</strong>
          <span>{stop.when}</span>
        </li>
        <li className="fixed">
          <i aria-hidden="true" />
          <strong>{cls.title}</strong>
          <span>{clock(cls.start)} · fixed</span>
        </li>
      </ol>

      <div className="lp-phone" ref={frame} inert aria-hidden="true">
        <div className="lp-status" aria-hidden="true">
          <span>{clock(base.now.toISOString()).replace(/\s?[AP]M$/, '')}</span>
          <i className="lp-island" />
          <span className="lp-status-icons">
            <svg viewBox="0 0 18 12" width="17" height="11"><path d="M1 11h2V8H1zm4 0h2V6H5zm4 0h2V3H9zm4 0h2V1h-2z" fill="currentColor" /></svg>
            <svg viewBox="0 0 16 12" width="15" height="11"><path d="M8 11.5 10.2 9a3.2 3.2 0 0 0-4.4 0zM3.6 6.8l1.4 1.5a4.3 4.3 0 0 1 6 0l1.4-1.5a6.3 6.3 0 0 0-8.8 0zM1 4.2l1.4 1.4a8 8 0 0 1 11.2 0L15 4.2a10 10 0 0 0-14 0z" fill="currentColor" /></svg>
            <svg viewBox="0 0 26 12" width="24" height="11"><rect x=".5" y=".5" width="22" height="11" rx="3" fill="none" stroke="currentColor" opacity=".5" /><rect x="2" y="2" width="16" height="8" rx="1.6" fill="currentColor" /><rect x="23.5" y="4" width="1.8" height="4" rx=".8" fill="currentColor" opacity=".5" /></svg>
          </span>
        </div>
        <div className={`lp-phone-sky ${raining ? 'rain' : 'partly-cloudy'}`}>
          <img src="/wordmark-light.svg" alt="" />
          <span>{raining ? '26° · Rain' : '30° · Partly cloudy'} · {clock(base.now.toISOString())}</span>
        </div>
        <div className="lp-phone-app">
          <div className="lp-scroll" style={{ transform: `translateY(${todayY}px)` }}>
          <Timeline
            day={updated ? after : base.day}
            now={base.now}
            mode="local"
            calendarEvents={base.calendarEvents}
            nudges={nudges}
            adder={null}
            onOpen={() => {}}
            onDone={() => {}}
            onSkip={() => {}}
            onReopen={() => {}}
            onReplan={() => {}}
            onOptions={() => {}}
            onFillGap={() => {}}
            onDismissNudge={() => {}}
          />
          </div>
        </div>
        {updated && chosen && (
          <div className="toast lp-phone-toast">
            <span>Changed: {chosen.label}.</span>
            <span className="toast-undo">Undo</span>
          </div>
        )}
        <div className={`lp-phone-sheet${sheetOpen ? ' open' : ''}`}>
          <div className="lp-phone-sheet-inner">
            <div className="sheet-head">
              <h2>Other options for {workout.title}</h2>
            </div>
            <div className="lp-scroll" style={{ transform: `translateY(${sheetY}px)` }}>
            <AlternativesBody busy={id === 'checking'} error={null} outcome={outcome} onUse={() => {}} onNotThis={() => {}} onMaxMinutes={() => {}} onClose={() => {}} />
            </div>
          </div>
        </div>
        <span className={`lp-finger${finger.show ? ' show' : ''}${finger.down ? ' down' : ''}`} style={{ left: finger.x, top: finger.y }} />
        <i className="lp-home-bar" />
        <i className="lp-glare" />
      </div>

      <figcaption>
        <span className="visually-hidden">
          Segue’s Today screen on a sample day, shown as a short animation: it starts raining on an outdoor workout, the person opens See options, Segue lists indoor places that are open and leave time for Class at {clock(cls.start)}, the person chooses one, and the plan updates with Class unchanged. Nothing changes until the person chooses.
        </span>
        <span className="lp-phone-step" aria-hidden="true">
          <b>
            Sample day · {scene + 1}/{SCENES.length}
          </b>{' '}
          {SCENES[scene]!.caption}
        </span>
      </figcaption>
    </figure>
  );
}
