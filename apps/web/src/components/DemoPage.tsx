/**
 * The guided demo at /demo. It runs Segue's real Today screen, alternatives
 * engine and "apply an option" logic on a sample day kept in memory: nothing
 * is saved, nothing touches an account or a calendar, every visitor gets their
 * own copy, and Restart (or reloading) puts it back as it was.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlternativeOption, AlternativesResult, Place, PlaceCategory, PlanItem } from '@segue/engine';
import { applyAlternative } from '../lib/alternatives';
import { DEMO_HOME, DEMO_IDS, DEMO_PLACES, DEMO_SOURCE, demoOptions, demoStart, type DemoState } from '../lib/demo';
import { clock, duration } from '../lib/format';
import { moveUp, type MoveUpResult } from '../lib/moveUp';
import type { Nudge } from '../lib/nudges';
import { API_URL } from '../lib/reroute';
import { enterApp } from '../lib/router';
import { MiniMap, type MapPoint } from './MiniMap';
import { Sky, sceneFor } from './Sky';
import { Timeline } from './Timeline';
import '../demo.css';

type Step =
  | { kind: 'intro' }
  | { kind: 'rain' }
  | { kind: 'options' }
  | { kind: 'applied'; option: AlternativeOption; before: PlanItem }
  | { kind: 'kept' }
  | { kind: 'item'; item: PlanItem }
  | { kind: 'skipped'; title: string; moveUp?: MoveUpResult }
  | { kind: 'add' };

const STAGES = ['The plan', 'Something changes', 'Segue’s options', 'You decide'];
const stageOf = (s: Step) => (s.kind === 'intro' || s.kind === 'item' || s.kind === 'add' ? 0 : s.kind === 'rain' ? 1 : s.kind === 'options' ? 2 : 3);
const LETTERS = ['A', 'B', 'C', 'D'];

export function DemoPage() {
  const [state, setState] = useState<DemoState>(() => demoStart());
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [avoid, setAvoid] = useState<string[]>([]);
  const [places, setPlaces] = useState<{ byCategory: Partial<Record<PlaceCategory, Place[]>>; live: boolean; note?: string }>({ byCategory: DEMO_PLACES, live: false });
  const [liveBusy, setLiveBusy] = useState(false);
  const guide = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<DemoState[]>([]);

  useEffect(() => {
    document.title = 'Segue demo · A sample day that adapts to rain';
  }, []);

  const options: AlternativesResult | null = useMemo(
    () => (state.raining && state.day.plan ? demoOptions(state, places.byCategory, avoid) : null),
    [state, places, avoid],
  );
  const workout = state.day.plan?.items.find((i) => i.blockId === DEMO_IDS.workout);
  const cls = state.day.plan?.items.find((i) => i.blockId === DEMO_IDS.class);
  const stillOutdoors = !!workout?.place && DEMO_PLACES.park!.some((p) => p.id === workout.place!.id) && !state.day.doneIds.includes(DEMO_IDS.workout) && !state.day.skippedIds.includes(DEMO_IDS.workout);

  const go = (s: Step) => {
    setStep(s);
    // On phones the guide sits above the timeline: bring it into view.
    if (window.matchMedia?.('(max-width: 959px)').matches) guide.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const change = (next: DemoState) => {
    setHistory((h) => [state, ...h].slice(0, 20));
    setState(next);
  };

  function restart() {
    setState(demoStart());
    setHistory([]);
    setAvoid([]);
    setPlaces({ byCategory: DEMO_PLACES, live: false });
    setStep({ kind: 'intro' });
    window.scrollTo({ top: 0 });
  }

  function makeItRain() {
    change({ ...state, raining: true });
    go({ kind: 'rain' });
  }

  function use(o: AlternativeOption) {
    if (!workout) return;
    change({ ...state, day: applyAlternative(state.day, o) });
    go({ kind: 'applied', option: o, before: workout });
  }

  function undo() {
    const [prev, ...rest] = history;
    if (!prev) return;
    setState(prev);
    setHistory(rest);
    go(prev.raining ? { kind: 'options' } : { kind: 'intro' });
  }

  async function livePlaces() {
    setLiveBusy(true);
    try {
      const get = async (category: PlaceCategory) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 9000);
        const res = await fetch(`${API_URL}/v1/places/nearby?lat=${DEMO_HOME.lat}&lng=${DEMO_HOME.lng}&category=${category}&radius=2000&limit=15`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(String(res.status));
        const list = ((await res.json()) as { places: Place[] }).places.filter((p) => p.source !== 'mock');
        if (!list.length) throw new Error('empty');
        return list;
      };
      const [park, gym, mall] = await Promise.all([get('park'), get('gym'), get('mall')]);
      setPlaces({ byCategory: { park, gym, mall }, live: true, note: `Live places from OpenStreetMap, fetched at ${clock(new Date().toISOString())}.` });
    } catch {
      setPlaces({ byCategory: DEMO_PLACES, live: false, note: "Live map data isn't available right now, so this still uses the sample snapshot." });
    } finally {
      setLiveBusy(false);
    }
  }

  // The real Today screen's callbacks, on the sample day.
  const mark = (field: 'doneIds' | 'skippedIds', id: string) => {
    const it = state.day.plan?.items.find((i) => i.blockId === id);
    const day = { ...state.day, [field]: [...new Set([...state.day[field], id])] };
    change({ ...state, day });
    if (field === 'skippedIds' && it) go({ kind: 'skipped', title: it.title });
  };
  const reopen = (id: string) => change({ ...state, day: { ...state.day, doneIds: state.day.doneIds.filter((x) => x !== id), skippedIds: state.day.skippedIds.filter((x) => x !== id) } });
  function proposeMoveUp(title: string) {
    if (!state.day.plan) return;
    const r = moveUp(state.day.plan, [...state.day.doneIds, ...state.day.skippedIds], {
      now: state.now.getTime(),
      location: DEMO_HOME,
      mode: 'local',
      utcOffsetMinutes: -state.now.getTimezoneOffset(),
      earliest: {},
      places: [...(places.byCategory.park ?? []), ...(places.byCategory.gym ?? []), ...(places.byCategory.mall ?? [])],
      pinned: state.day.lockedIds,
    });
    go({ kind: 'skipped', title, moveUp: r });
  }

  const nudges: Nudge[] =
    state.raining && stillOutdoors && workout
      ? [{ id: 'demo-rain', kind: 'rain', title: `It's raining, and ${workout.title} is outdoors`, body: 'Sample weather. See options that still leave time to get to Class.', action: 'options', item: workout, at: state.now.getTime() }]
      : [];

  const mapPoints: MapPoint[] = [
    { id: 'you', label: 'You (Ayala Avenue)', mark: '', at: DEMO_HOME, kind: 'you' },
    ...(cls ? [{ id: 'class', label: 'Class at 3:30 PM (set time)', mark: '', at: { lat: 14.5609, lng: 121.0195 }, kind: 'fixed' as const }] : []),
    ...(workout?.place && stillOutdoors ? [{ id: 'planned', label: `${workout.place.name} (planned, outdoors)`, mark: '', at: workout.place.location, kind: 'planned' as const }] : []),
    ...(step.kind === 'options' && options
      ? options.options.filter((o) => o.place).map((o, i) => ({ id: o.id, label: `${LETTERS[options.options.indexOf(o)] ?? i + 1}: ${o.place!.name}`, mark: LETTERS[options.options.indexOf(o)] ?? '', at: o.place!.location, kind: 'option' as const }))
      : []),
    ...(step.kind === 'applied' && step.option.place ? [{ id: 'chosen', label: `${step.option.place.name} (your choice)`, mark: '✓', at: step.option.place.location, kind: 'chosen' as const }] : []),
  ];

  return (
    <div className="demo">
      <header className="demo-bar">
        <a href="/" className="demo-logo" aria-label="Segue home">
          <picture>
            <source srcSet="/wordmark-light.svg" media="(prefers-color-scheme: dark)" />
            <img src="/wordmark.svg" alt="Segue" />
          </picture>
        </a>
        <span className="demo-badge">Demo · sample data</span>
        <div className="demo-bar-actions">
          <button type="button" className="ghost" onClick={restart}>
            Restart demo
          </button>
          <a className="primary demo-start" href="/app" onClick={(e) => (e.preventDefault(), enterApp(''))}>
            Plan my own day
          </a>
        </div>
      </header>

      <ol className="demo-stages" aria-label="Demo progress">
        {STAGES.map((s, i) => (
          <li key={s} className={i === stageOf(step) ? 'on' : i < stageOf(step) ? 'done' : ''} aria-current={i === stageOf(step) ? 'step' : undefined}>
            <span>{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      <div className="demo-grid">
        <div className="demo-guide" ref={guide} aria-live="polite">
          <Guide
            step={step}
            state={state}
            options={options}
            places={places}
            liveBusy={liveBusy}
            mapPoints={mapPoints}
            canUndo={history.length > 0}
            onRain={makeItRain}
            onOptions={() => go({ kind: 'options' })}
            onUse={use}
            onNotThis={(id) => setAvoid((a) => [...a, id])}
            onKeep={() => go({ kind: 'kept' })}
            onLive={() => void livePlaces()}
            onUndo={undo}
            onRestart={restart}
            onMoveUp={proposeMoveUp}
            onApplyMoveUp={(r) => {
              if (r.kind !== 'moves') return;
              change({ ...state, day: { ...state.day, plan: r.plan } });
              go({ kind: 'intro' });
            }}
            onBack={() => go(state.raining ? (stillOutdoors ? { kind: 'options' } : { kind: 'intro' }) : { kind: 'intro' })}
          />
        </div>

        <div className="demo-phone" aria-label="Segue's Today screen, with the sample day">
          <div className={`demo-sky ${state.raining ? 'wet' : ''}`}>
            <Sky scene={sceneFor({ condition: state.raining ? 'rain' : 'partly-cloudy' })} />
            <div className="demo-sky-text">
              <img src="/wordmark-light.svg" alt="" />
              <span>{state.raining ? '26° · Rain' : '30° · Partly cloudy'}</span>
              <span className="demo-sample">Sample weather · today, {clock(state.now.toISOString())}</span>
            </div>
          </div>
          <div className="demo-app">
            <Timeline
              day={state.day}
              now={state.now}
              mode="local"
              calendarEvents={state.calendarEvents}
              nudges={nudges}
              calendar={<p className="calendar-line muted small">Sample calendar: Class comes from a sample event, not your Google Calendar.</p>}
              adder={null}
              onOpen={(item) => (item.blockId === DEMO_IDS.workout && state.raining && stillOutdoors ? go({ kind: 'options' }) : go({ kind: 'item', item }))}
              onDone={(id) => mark('doneIds', id)}
              onSkip={(id) => mark('skippedIds', id)}
              onReopen={reopen}
              onReplan={() => go({ kind: 'options' })}
              onOptions={() => go({ kind: 'options' })}
              onFillGap={() => go({ kind: 'add' })}
              onDismissNudge={() => go({ kind: 'intro' })}
            />
          </div>
        </div>
      </div>

      <footer className="demo-foot muted small">
        {DEMO_SOURCE} Data © OpenStreetMap contributors (ODbL). Nothing in the demo is saved or sent to an account.
      </footer>
    </div>
  );
}

interface GuideProps {
  step: Step;
  state: DemoState;
  options: AlternativesResult | null;
  places: { live: boolean; note?: string };
  liveBusy: boolean;
  mapPoints: MapPoint[];
  canUndo: boolean;
  onRain: () => void;
  onOptions: () => void;
  onUse: (o: AlternativeOption) => void;
  onNotThis: (placeId: string) => void;
  onKeep: () => void;
  onLive: () => void;
  onUndo: () => void;
  onRestart: () => void;
  onMoveUp: (title: string) => void;
  onApplyMoveUp: (r: MoveUpResult) => void;
  onBack: () => void;
}

function Guide(p: GuideProps) {
  const { step, state } = p;
  const mapCaption = `${p.places.live ? 'Live places from OpenStreetMap.' : 'Sample places (OpenStreetMap snapshot).'} Drawn to scale from their coordinates; not a street map.`;

  if (step.kind === 'intro') {
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">Sample day · it's {clock(state.now.toISOString())}</p>
        <h1>This is a planned day in Segue</h1>
        <p>Two things are done. Next is an outdoor workout at 2:00 PM, then Class at 3:30 PM.</p>
        <ul className="demo-legend">
          <li>
            <span className="tag">Calendar</span> <span className="tag">Set time</span> Commitments. Segue plans around them and never moves them.
          </li>
          <li>
            <span className="demo-flex">Flexible</span> Everything else. Segue can suggest a better time or place when things change.
          </li>
        </ul>
        <p className="muted small">The timeline is Segue’s real Today screen. Try ✓ to mark something done, or Skip on the next item.</p>
        <div className="row-actions">
          <button type="button" className="primary" onClick={p.onRain} disabled={state.raining}>
            {state.raining ? 'It’s already raining' : 'Make it rain'}
          </button>
          {state.raining && (
            <button type="button" className="ghost" onClick={p.onOptions}>
              See Segue’s options
            </button>
          )}
        </div>
        <p className="muted small">Starts a sample rain scenario. Real Segue uses your live forecast.</p>
      </section>
    );
  }

  if (step.kind === 'rain') {
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">Something changes · sample weather</p>
        <h1>It started raining</h1>
        <p>The forecast says 90% chance of rain until about 5 PM. Your 2:00 PM workout is in a park.</p>
        <p>
          A calendar would leave you to work it out. Segue checks what still fits before Class at 3:30, which nearby places are open, and how long it takes to
          get there.
        </p>
        <div className="row-actions">
          <button type="button" className="primary" onClick={p.onOptions}>
            See what Segue suggests
          </button>
        </div>
      </section>
    );
  }

  if (step.kind === 'options') {
    const r = p.options;
    return (
      <section className="demo-card alternatives">
        <p className="demo-eyebrow">Segue’s options</p>
        <h1>What still fits before Class</h1>
        {r?.problem && <p className="demo-problem">{r.problem.text.replace('(forecast)', '(sample forecast)')}.</p>}
        {r?.nextCommitment && (
          <p className="muted small">
            Every option leaves time to get to <strong>{r.nextCommitment.title}</strong> by {clock(r.nextCommitment.start)}.
          </p>
        )}
        <MiniMap points={p.mapPoints} caption={mapCaption} />
        {p.places.note && <p className="muted small">{p.places.note}</p>}
        {!p.places.live && (
          <button type="button" className="text-button" onClick={p.onLive} disabled={p.liveBusy}>
            {p.liveBusy ? 'Getting live places…' : 'Use live places near Ayala instead'}
          </button>
        )}
        {r && r.options.length ? (
          <ol className="alt-list demo-options">
            {r.options.map((o, i) => (
              <li key={o.id} className="alt-option">
                <p className="alt-when">
                  <span className="demo-letter">{LETTERS[i]}</span>
                  {clock(o.start)}–{clock(o.end)} · {duration(o.minutes)}
                  {o.travelMinutes > 0 && ` · about ${o.travelMinutes} min away`}
                </p>
                <h3 className="alt-label">{o.label}</h3>
                <ul className="alt-facts">
                  {o.facts.map((f) => (
                    <li key={f.text} className={`alt-fact alt-fact-${f.kind}`}>
                      {f.kind === 'unknown' && <span className="visually-hidden">Not confirmed: </span>}
                      {f.text.replace('(forecast)', '(sample forecast)')}
                    </li>
                  ))}
                  {o.tradeoffs.map((t) => (
                    <li key={t} className="alt-fact alt-tradeoff">
                      <span className="visually-hidden">Trade-off: </span>
                      {t}
                    </li>
                  ))}
                </ul>
                <div className="alt-actions">
                  <button type="button" className="primary" onClick={() => p.onUse(o)}>
                    Use this
                  </button>
                  {o.place && (
                    <button type="button" className="text-button" onClick={() => p.onNotThis(o.place!.id)}>
                      Not this place
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p>Nothing realistic fits before Class right now.</p>
        )}
        {r && r.notes.length > 0 && (
          <ul className="alt-notes muted small">
            {r.notes.map((n) => (
              <li key={n.text}>{n.text}.</li>
            ))}
          </ul>
        )}
        <div className="row-actions">
          <button type="button" className="ghost" onClick={p.onKeep}>
            Keep my original plan
          </button>
        </div>
      </section>
    );
  }

  if (step.kind === 'applied') {
    const o = step.option;
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">You decided</p>
        <h1>Your day, adjusted</h1>
        <p className="demo-change">
          <s>
            {clock(step.before.start)} {step.before.title}
            {step.before.place ? ` at ${step.before.place.name}` : ''}
          </s>
          <br />
          <strong>
            {clock(o.start)} {o.label}
          </strong>
        </p>
        <MiniMap points={p.mapPoints} caption={mapCaption} height={180} />
        <p>Class at 3:30 PM didn’t move. Nothing else in the day changed.</p>
        <p className="demo-eyebrow">What Segue checked</p>
        <ul className="demo-checked">
          {o.facts.map((f) => (
            <li key={f.text}>{f.text.replace('(forecast)', '(sample forecast)')}</li>
          ))}
        </ul>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={p.onUndo} disabled={!p.canUndo}>
            Undo
          </button>
          <button type="button" className="ghost" onClick={p.onRestart}>
            Restart demo
          </button>
          <a className="primary" href="/app" onClick={(e) => (e.preventDefault(), enterApp(''))}>
            Plan my own day
          </a>
        </div>
      </section>
    );
  }

  if (step.kind === 'kept') {
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">You decided</p>
        <h1>Your plan stays as it was</h1>
        <p>Nothing changed. Segue only suggests; you choose. The workout stays at 2:00 PM in the park.</p>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={p.onOptions}>
            See the options again
          </button>
          <button type="button" className="ghost" onClick={p.onRestart}>
            Restart demo
          </button>
          <a className="primary" href="/app" onClick={(e) => (e.preventDefault(), enterApp(''))}>
            Plan my own day
          </a>
        </div>
      </section>
    );
  }

  if (step.kind === 'skipped') {
    const r = step.moveUp;
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">Skipped</p>
        <h1>{step.title} is skipped</h1>
        <p>Nothing else moved. Skipping never rearranges your day by itself.</p>
        {!r && (
          <div className="row-actions">
            <button type="button" className="ghost" onClick={() => p.onMoveUp(step.title)}>
              Move tasks up?
            </button>
            <button type="button" className="ghost" onClick={p.onBack}>
              Keep my schedule
            </button>
          </div>
        )}
        {r?.kind === 'moves' && (
          <>
            <p className="demo-eyebrow">Suggested adjustment</p>
            <ul className="moveup-list">
              {r.moves.map((m) => (
                <li key={m.blockId}>
                  <strong>{m.title}</strong>: {clock(m.from)} → {clock(m.to)}
                </li>
              ))}
            </ul>
            <p className="muted small">Same order, earlier where trips and set times allow. Class stays at 3:30 PM.</p>
            <div className="row-actions">
              <button type="button" className="primary" onClick={() => p.onApplyMoveUp(r)}>
                Apply changes
              </button>
              <button type="button" className="ghost" onClick={p.onBack}>
                Keep current schedule
              </button>
            </div>
          </>
        )}
        {r && r.kind !== 'moves' && (
          <>
            <p>{r.reason}</p>
            <button type="button" className="ghost" onClick={p.onBack}>
              OK
            </button>
          </>
        )}
      </section>
    );
  }

  if (step.kind === 'item') {
    const it = step.item;
    const set = it.fixed || it.blockId.startsWith('gcal_');
    return (
      <section className="demo-card">
        <p className="demo-eyebrow">{set ? 'Set time' : 'Flexible'}</p>
        <h1>{it.title}</h1>
        <p>
          {clock(it.start)}–{clock(it.end)}
          {it.place ? ` at ${it.place.name}` : ''}
          {it.travelMinutesBefore ? `, about ${it.travelMinutesBefore} min to get there (estimate)` : ''}.
        </p>
        <p>{set ? 'This comes from the (sample) calendar. Segue plans around it and never moves it.' : 'Segue can move or change this if your day changes, but only when you say yes.'}</p>
        <button type="button" className="ghost" onClick={p.onBack}>
          Back
        </button>
      </section>
    );
  }

  return (
    <section className="demo-card">
      <p className="demo-eyebrow">Adding things</p>
      <h1>In your own Segue, you’d add something here</h1>
      <p>Type it the way you’d say it, like “Groceries 30 min before 8”, and Segue finds the time and the place. Adding is off in the demo so the story stays the same for everyone.</p>
      <button type="button" className="ghost" onClick={p.onBack}>
        Back
      </button>
    </section>
  );
}
