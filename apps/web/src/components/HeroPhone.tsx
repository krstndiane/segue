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
 * It plays only while it's on screen and the tab is visible, can be paused,
 * and with reduced motion it starts still (on the rain) and steps without
 * movement when played.
 */

type SceneId = 'day' | 'rain' | 'tapOptions' | 'checking' | 'options' | 'tapUse' | 'done';
const SCENES: { id: SceneId; ms: number; caption: string }[] = [
  { id: 'day', ms: 3400, caption: 'Your day, planned' },
  { id: 'rain', ms: 3200, caption: 'Rain on the outdoor workout' },
  { id: 'tapOptions', ms: 1200, caption: 'See options' },
  { id: 'checking', ms: 1800, caption: 'Checking what’s open' },
  { id: 'options', ms: 4000, caption: 'Options that still make Class' },
  { id: 'tapUse', ms: 1200, caption: 'You pick one' },
  { id: 'done', ms: 4800, caption: 'Updated. Class didn’t move' },
];
/** The still frame: the moment that sets up the whole story. */
const STILL = 1;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function HeroPhone() {
  const base = useMemo(() => demoStart(), []);
  const rain = useMemo(() => ({ ...base, raining: true }), [base]);
  const result = useMemo(() => demoOptions(rain), [rain]);
  const chosen = result.options[0];
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
  const [paused, setPaused] = useState(() => reducedMotion());
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [still, setStill] = useState(reducedMotion);
  const frame = useRef<HTMLDivElement>(null);
  const [tap, setTap] = useState<{ x: number; y: number } | null>(null);

  const id = SCENES[scene]!.id;
  const raining = id !== 'day';
  const sheetOpen = id === 'checking' || id === 'options' || id === 'tapUse';
  const updated = id === 'done';
  const running = !paused && onScreen && tabVisible;

  // Follow reduced-motion changes while the page is open.
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const on = () => {
      setStill(m.matches);
      if (m.matches) setPaused(true);
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

  // Where the finger goes: the real button on screen, measured, so it lands on it at any size.
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    root.querySelectorAll('.lp-tapped').forEach((b) => b.classList.remove('lp-tapped'));
    const target = id === 'tapOptions' ? root.querySelector<HTMLElement>('.nudge .ghost') : id === 'tapUse' ? root.querySelector<HTMLElement>('.lp-phone-sheet .alt-option .primary') : null;
    if (!target) {
      setTap(null);
      return;
    }
    const a = root.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    setTap({ x: b.left - a.left + b.width / 2, y: b.top - a.top + b.height / 2 });
    target.classList.add('lp-tapped');
  }, [id]);

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
        <div className={`lp-phone-sky ${raining ? 'rain' : 'partly-cloudy'}`}>
          <img src="/wordmark-light.svg" alt="" />
          <span>{raining ? '26° · Rain' : '30° · Partly cloudy'} · {clock(base.now.toISOString())}</span>
        </div>
        <div className="lp-phone-app">
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
            <AlternativesBody busy={id === 'checking'} error={null} outcome={outcome} onUse={() => {}} onNotThis={() => {}} onMaxMinutes={() => {}} onClose={() => {}} />
          </div>
        </div>
        {tap && <span className="lp-touch" style={{ left: tap.x, top: tap.y }} />}
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
        <button
          type="button"
          className="lp-phone-play"
          aria-pressed={!paused}
          aria-label={paused ? 'Play the phone animation' : 'Pause the phone animation'}
          onClick={() => setPaused((p) => !p)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            {paused ? <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" /> : <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />}
          </svg>
          {paused ? 'Play' : 'Pause'}
        </button>
      </figcaption>
    </figure>
  );
}
