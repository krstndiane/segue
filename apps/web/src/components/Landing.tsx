import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { loadAccount } from '../lib/account';
import { getSession } from '../lib/auth';
import { DEMO_HOME, DEMO_IDS, demoOptions, demoStart } from '../lib/demo';
import { clock } from '../lib/format';
import { enterApp } from '../lib/router';
import { NAV_ICONS, NAV_LABELS, type NavTab } from './BottomNav';
import { HeroPhone } from './HeroPhone';
import { RoadRide } from './RoadRide';
import { StoryMap, type StoryOption } from './StoryMap';
import { Sky, sceneFor } from './Sky';
import '../landing.css';

const PROBLEMS = [
  ['It starts raining', 'and your workout is outdoors.'],
  ['A meeting runs late', 'and every stop after it is now off.'],
  ['The place is closed', 'or too far to reach before your class.'],
];

/** The app's five tabs, each in terms of what you can do there. Same icons as the app's bottom navigation. */
const TOUR: { tab: NavTab; body: string }[] = [
  { tab: 'today', body: 'What’s next, where, and when to leave.' },
  { tab: 'plan', body: 'Add things the way you’d say them: “Gym 1h after 5pm”.' },
  { tab: 'days', body: 'Your Google Calendar and your plans, day by day. Read-only.' },
  { tab: 'routines', body: 'Things you do on certain days, fitted in each time.' },
  { tab: 'together', body: 'Share one plan or stop with people you choose.' },
];

const TOGETHER_POINTS = [
  'Share one stop or plan, never your whole calendar.',
  '“Can I join?” only asks. You decide.',
  'An invitation changes nothing until you accept it.',
];

const PRIVACY = [
  'Your plans stay on your device. An account is optional, for syncing.',
  'Google Calendar is read-only. Segue never writes to it.',
  'Location is used to plan and check the weather (rounded to about 1 km), and isn’t stored.',
];

const STEPS = ['The plan', 'Something changes', 'Segue finds alternatives', 'You decide'] as const;

/** How long each step stays on screen while the story plays on its own. */
const PLAY_MS = 5200;

/**
 * How it works, told once: the sample day on Segue's real planner and
 * alternatives engine, one step and one action at a time. Any of the four
 * steps can be chosen, in any order; the motorcycle rides to the one chosen.
 * Play runs the same four steps on its own; any press of a step or an action
 * hands control back.
 */
function RouteStory() {
  const [step, setStepState] = useState(0);
  const [visited, setVisited] = useState<number[]>([0]);
  const [playing, setPlaying] = useState(false);
  const go = (i: number) => {
    setStepState(i);
    setVisited((v) => (v.includes(i) ? v : [...v, i]));
  };
  /** Choose a step (a milestone, or a button in the panel): the motorcycle rides there and the panel follows. */
  const setStep = (i: number) => {
    setPlaying(false);
    go(i);
  };
  useEffect(() => {
    if (!playing) return;
    if (step >= STEPS.length - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => go(step + 1), PLAY_MS);
    return () => window.clearTimeout(t);
  }, [playing, step]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (step >= STEPS.length - 1) {
      setPick(0);
      setVisited([0]);
      setStepState(0);
    }
    setPlaying(true);
  };
  const [pick, setPick] = useState(0);
  const roadWrap = useRef<HTMLDivElement>(null);
  const base = useMemo(() => demoStart(), []);
  // Worked out once, so the map can fit every stop from the first step and never jumps.
  const result = useMemo(() => demoOptions({ ...base, raining: true }), [base]);
  const options = result.options.filter((o) => o.kind !== 'later').slice(0, 3);
  const o = options[Math.min(pick, options.length - 1)];
  const items = base.day.plan!.items;
  const workout = items.find((i) => i.blockId === DEMO_IDS.workout)!;
  const cls = items.find((i) => i.blockId === DEMO_IDS.class)!;
  const later = items.find((i) => i.blockId === DEMO_IDS.personal)!;
  const short = (label: string) => label.replace(/ instead$/, '');
  const mapOptions: StoryOption[] = options.flatMap((x, i) => (x.place ? [{ id: x.id, n: i + 1, label: x.place.name, at: x.place.location }] : []));
  const classAt = base.blocks.find((b) => b.id === DEMO_IDS.class)?.fixed?.location ?? DEMO_HOME;

  const route = (changed: boolean) => (
    <ol className="lp-sc-list">
      {changed && o ? (
        <li className="changed">
          <b>{clock(o.start)}</b> {short(o.label)}
          <span>{o.facts.map((f) => f.text).filter((x) => /Open|Leaves|No trip|min to get/.test(x)).join(' · ')}</span>
        </li>
      ) : (
        <li className={step === 1 ? 'hit' : ''}>
          <b>{clock(workout.start)}</b> {workout.title}
          <span>
            {workout.place?.name} · {workout.travelMinutesBefore} min away · outdoors
          </span>
        </li>
      )}
      <li className="set">
        <b>{clock(cls.start)}</b> {cls.title} <span className="tag">Calendar · fixed</span>
        {changed && <span>Unchanged</span>}
      </li>
      <li>
        <b>{clock(later.start)}</b> {later.title}
      </li>
    </ol>
  );

  return (
    <div className="lp-story">
      <div className="lp-steps-wrap" ref={roadWrap}>
        <RoadRide wrap={roadWrap} step={step} />
        <ol className="lp-steps">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined} className={i === step ? 'on' : visited.includes(i) ? 'visited' : ''}>
              <button type="button" onClick={() => i !== step && setStep(i)} aria-label={`Step ${i + 1}: ${label}`}>
                <span className="lp-step-dot" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="lp-step-label">{label}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="lp-play-row">
        <button type="button" className="lp-play" aria-pressed={playing} onClick={play}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {playing ? <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" /> : <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />}
          </svg>
          {playing ? 'Pause' : step === STEPS.length - 1 ? 'Play again' : 'Play the story'}
        </button>
        <span className="lp-play-count">
          Step {step + 1} of {STEPS.length}
        </span>
      </div>

      <div className="lp-stage-wrap">
      <StoryMap
        step={step}
        home={{ id: 'home', label: 'Home', at: DEMO_HOME }}
        planned={{ id: 'park', label: 'Park', at: workout.place!.location }}
        fixed={{ id: 'class', label: `Class ${clock(cls.start)}`, at: classAt }}
        options={mapOptions}
        chosen={mapOptions.find((m) => m.id === o?.id)}
        chosenAtHome={!!o && !o.place}
      />
      <div className="lp-stage" aria-live="polite">
        {step === 0 && (
          <>
            <h3>Here’s today’s route</h3>
            <p>A workout outdoors at 2, then class at 3:30. Class is on your calendar, so it never moves.</p>
            {route(false)}
            <button type="button" className="lp-action" onClick={() => setStep(1)}>
              Make it rain
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <h3>It starts raining</h3>
            <p className="lp-sc-alert">
              <strong>90% chance until about 5 PM,</strong> and the workout is outdoors.
            </p>
            {route(false)}
            <button type="button" className="lp-action" onClick={() => setStep(2)} disabled={!options.length}>
              See options
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h3>Segue finds a practical way forward</h3>
            <p>Real places nearby, open then, each with time to reach class.</p>
            <div className="lp-sc-pick" role="radiogroup" aria-label="Options Segue found">
              {options.map((x, i) => (
                <button key={x.id} type="button" role="radio" aria-checked={i === pick} className={i === pick ? 'on' : ''} onClick={() => {
                    setPlaying(false);
                    setPick(i);
                  }}>
                  <span className="lp-sc-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  {short(x.label)}
                </button>
              ))}
            </div>
            {o && (
              <p className="lp-sc-why">
                <strong>Why this works:</strong> {o.why}.
              </p>
            )}
            {route(true)}
            <button type="button" className="lp-action" onClick={() => setStep(3)}>
              Use this
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <h3>You decide</h3>
            <p>Nothing changed until you chose. Class stays at {clock(cls.start)}. Undo is one tap away.</p>
            {route(true)}
            <div className="lp-stage-end">
              <a className="lp-primary" href="/app" onClick={openApp}>
                Try Segue
              </a>
              <button
                type="button"
                className="lp-text"
                onClick={() => {
                  setStep(0);
                  setVisited([0]);
                  setPick(0);
                }}
              >
                Start over
              </button>
            </div>
          </>
        )}
      </div>
      </div>
      <p className="lp-sc-foot">
        Sample weather, real places from OpenStreetMap (Makati), Segue’s real planner.{' '}
        <a href="/demo">Open the full-screen demo</a>
      </p>
    </div>
  );
}

/** Into the app without a page load. */
function openApp(e: MouseEvent) {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  enterApp('');
}

/** The one main action, named for what it does. */
function MainAction({ returning, className = 'lp-primary' }: { returning: boolean; className?: string }) {
  return (
    <a className={className} href="/app" onClick={openApp}>
      {returning ? 'Open Segue' : 'Try Segue'}
    </a>
  );
}

/** Problems come in one at a time as they scroll into view (all at once with reduced motion). */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.lp-reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.25 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

const CONTACT_EMAIL = 'pdyntechnology@gmail.com';

/** PDYN Technologies: the studio behind Segue. The tile takes the text colour, so it works on light and dark. */
function PdynLockup() {
  return (
    <span className="pdyn">
      <svg className="pdyn-mark" viewBox="0 0 100 100" width="40" height="40" aria-hidden="true">
        <rect width="100" height="100" rx="22" fill="currentColor" />
        <path d="M23 37 L44 63 L76 31 M52 30 H77 V55" fill="none" stroke="var(--fog)" strokeWidth="8" strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
      <span className="pdyn-words">
        <span className="pdyn-name">PDYN</span>
        <span className="pdyn-sub">Technologies</span>
      </span>
    </span>
  );
}

export function Landing() {
  const [returning, setReturning] = useState(false);
  useReveal();

  useEffect(() => {
    void loadAccount().then((a) => setReturning((r) => r || !!a));
    setReturning(!!getSession());
    document.title = 'Segue · Your route-aware daily planner';
  }, []);

  return (
    <div className="landing">
      <header className="lp-hero">
        <Sky scene={sceneFor({ condition: 'partly-cloudy' })} />
        <nav className="lp-nav" aria-label="Segue">
          <a href="/" className="lp-logo">
            <img src="/wordmark-light.svg" alt="Segue" />
          </a>
          <div className="lp-links">
            <a href="#how">How it works</a>
            <a href="#tour">Features</a>
            <a href="#privacy">Privacy</a>
          </div>
          <MainAction returning={returning} className="lp-open" />
        </nav>

        <div className="lp-hero-inner">
          <div className="lp-copy">
            <p className="lp-kicker">Your route-aware daily planner</p>
            <h1>Your day has a route. Segue helps you find your way.</h1>
            <p className="lp-sub">Plan your stops and commitments in one place. When something changes, Segue suggests another way, and you decide.</p>
            <div className="lp-ctas">
              <MainAction returning={returning} />
              <a className="lp-secondary" href="#how">
                How it works
              </a>
            </div>
            <p className="lp-micro">Free, and it works without an account.</p>
          </div>
          <HeroPhone />
        </div>
      </header>

      <main>
        <section className="lp-band lp-cream">
          <div className="lp-section lp-problem" aria-labelledby="problem-title">
            <p className="lp-eyebrow">The problem</p>
            <h2 id="problem-title">You planned your day. Then the day happened.</h2>
            <ul className="lp-problems">
              {PROBLEMS.map(([a, b], i) => (
                <li key={a} className="lp-reveal" style={{ transitionDelay: `${i * 140}ms` }}>
                  <strong>{a}</strong> {b}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="how" className="lp-band lp-howband" aria-labelledby="how-title">
          <div className="lp-section">
            <p className="lp-eyebrow">How it works</p>
            <h2 id="how-title">One day, four steps</h2>
            <p className="lp-lead">Press play, or go one step at a time.</p>
            <RouteStory />
          </div>
        </section>

        <section id="tour" className="lp-band" aria-labelledby="tour-title">
          <div className="lp-section">
            <p className="lp-eyebrow">Inside Segue</p>
            <h2 id="tour-title">Five places, one day</h2>
            <ul className="lp-tour">
              {TOUR.map((t) => (
                <li key={t.tab}>
                  <span className="lp-tour-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="24" height="24">
                      {NAV_ICONS[t.tab]}
                    </svg>
                  </span>
                  <div>
                    <h3>{NAV_LABELS[t.tab]}</h3>
                    <p>{t.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="together" className="lp-band lp-navy" aria-labelledby="together-title">
          <div className="lp-section lp-split">
            <div>
              <p className="lp-eyebrow">Plan together</p>
              <h2 id="together-title">Make time for the people and places that matter</h2>
            </div>
            <ul className="lp-checks">
              {TOGETHER_POINTS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="privacy" className="lp-band" aria-labelledby="privacy-title">
          <div className="lp-section lp-split">
            <div>
              <p className="lp-eyebrow">Privacy</p>
              <h2 id="privacy-title">Your day stays yours</h2>
            </div>
            <ul className="lp-checks">
              {PRIVACY.map((p) => (
                <li key={p}>{p}</li>
              ))}
              <li>
                <a href="/privacy">Read the full privacy policy</a>
              </li>
            </ul>
          </div>
        </section>

        <section className="lp-final" aria-labelledby="final-title">
          <img src="/icon.svg" alt="" width="88" height="88" />
          <h2 id="final-title">Start planning your day</h2>
          <div className="lp-ctas">
            <MainAction returning={returning} />
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <picture>
              <source srcSet="/wordmark-light.svg" media="(prefers-color-scheme: dark)" />
              <img src="/wordmark.svg" alt="Segue" className="lp-footer-mark" />
            </picture>
            <p>
              <em>Segue</em> (n.): moving from one thing into the next without a pause.
            </p>
          </div>

          <nav className="lp-footer-col" aria-labelledby="ft-explore">
            <h2 id="ft-explore">Explore</h2>
            <ul>
              <li><a href="#how">How it works</a></li>
              <li><a href="#tour">Features</a></li>
              <li><a href="#together">Plan together</a></li>
              <li><a href="/demo">Full-screen demo</a></li>
            </ul>
          </nav>

          <nav className="lp-footer-col" aria-labelledby="ft-about">
            <h2 id="ft-about">About</h2>
            <ul>
              <li><a href="/privacy">Privacy policy</a></li>
              <li><a href={`mailto:${CONTACT_EMAIL}`}>Contact us</a></li>
              <li><a href={`mailto:${CONTACT_EMAIL}?subject=Segue%20feedback`}>Send feedback</a></li>
            </ul>
          </nav>

          <nav className="lp-footer-col" aria-labelledby="ft-app">
            <h2 id="ft-app">Use Segue</h2>
            <ul>
              <li><MainAction returning={returning} className="" /></li>
              <li><a href="#final-title">Add it to your home screen</a></li>
            </ul>
          </nav>
        </div>

        <div className="lp-footer-bottom">
          <p className="lp-footer-copy">© {new Date().getFullYear()} Segue. All rights reserved.</p>
          <p className="lp-footer-by">
            <span className="visually-hidden">Built by </span>
            <PdynLockup />
          </p>
          <a className="lp-footer-mail" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
        </div>
      </footer>
    </div>
  );
}
