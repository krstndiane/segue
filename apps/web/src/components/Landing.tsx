import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { loadAccount } from '../lib/account';
import { getSession } from '../lib/auth';
import { DEMO_IDS, demoOptions, demoStart } from '../lib/demo';
import { clock } from '../lib/format';
import { enterApp } from '../lib/router';
import { NAV_ICONS, NAV_LABELS, type NavTab } from './BottomNav';
import { RoadRide } from './RoadRide';
import { Sky, sceneFor } from './Sky';
import { Timeline } from './Timeline';
import '../landing.css';

const PROBLEMS = [
  ['It starts raining', 'and your workout is outdoors.'],
  ['A meeting runs late', 'and every stop after it is now off.'],
  ['The place is closed', 'or too far to reach before your class.'],
];

/** The app's five tabs, each in terms of what you can do there. Same icons as the app's bottom navigation. */
const TOUR: { tab: NavTab; body: string }[] = [
  { tab: 'today', body: 'Your day as a route: what’s next, where, and when to leave. Tick things off, skip one without reshuffling the rest.' },
  { tab: 'plan', body: 'Add stops the way you’d say them (“Gym 1h after 5pm”), choose what matters most, and Segue fits them around your fixed times.' },
  { tab: 'days', body: 'Your Google Calendar events and your own plans, day by day. Segue reads your calendar and never changes it.' },
  { tab: 'routines', body: 'The stops you make on certain days, like the gym after class on Mondays. Segue fits them into each of those days.' },
  { tab: 'together', body: 'Share one plan or stop with people you choose, let them ask to join, and agree on a time. Everything else stays private.' },
];

const TOGETHER_POINTS = [
  'Share one stop or plan, never your whole calendar.',
  '“Can I join?” only asks. You approve or decline.',
  'An invitation never changes your day unless you accept it.',
];

const PRIVACY = [
  'Your plans are saved on your device. A Segue account is optional and syncs them between your devices.',
  'Google Calendar is read-only: Segue never writes to it. Signed in, Segue keeps the connection so you aren’t asked again.',
  'Your location is used to plan and check the weather; the weather uses a spot rounded to about 1 km. It isn’t stored.',
];

/** The route on the sample day: where you'll be, in order, with the stop the rain affects marked. */
function RouteRibbon() {
  const s = useMemo(() => demoStart(), []);
  const stops = s.day.plan!.items.filter((i) => i.place || i.fixed);
  return (
    <ol className="lp-ribbon" aria-label="The sample day's route">
      <li>
        <i aria-hidden="true" />
        <strong>Home</strong>
        <span>Now</span>
      </li>
      {stops.map((i) => (
        <li key={i.blockId} className={i.fixed ? 'fixed' : i.blockId === DEMO_IDS.workout ? 'hit' : ''}>
          <i aria-hidden="true" />
          <strong>{i.place?.name ?? i.title}</strong>
          <span>
            {clock(i.start)}
            {i.fixed ? ' · fixed' : ' · rain'}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The real Today screen on the sample day, at the moment the rain starts. Not interactive here. */
function TodayPreview() {
  const s = useMemo(() => ({ ...demoStart(), raining: true }), []);
  const workout = s.day.plan!.items.find((i) => i.blockId === DEMO_IDS.workout)!;
  return (
    <figure className="lp-preview">
      <RouteRibbon />
      <div className="lp-phone" inert>
        <div className="lp-phone-sky rain">
          <img src="/wordmark-light.svg" alt="" />
          <span>26° · Rain · {clock(s.now.toISOString())}</span>
        </div>
        <div className="lp-phone-app">
          <Timeline
            day={s.day}
            now={s.now}
            mode="local"
            calendarEvents={s.calendarEvents}
            nudges={[{ id: 'rain', kind: 'rain', title: `It's raining, and ${workout.title} is outdoors`, body: 'See options that still leave time for Class.', action: 'options', item: workout, at: 0 }]}
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
      <figcaption>Segue’s Today screen, on a sample day</figcaption>
    </figure>
  );
}

const STEPS = ['The plan', 'Something changes', 'Segue finds alternatives', 'You decide'] as const;

/**
 * How it works, told once: the sample day on Segue's real planner and
 * alternatives engine, one step and one action at a time. Any of the four
 * steps can be chosen, in any order; the motorcycle rides to the one chosen.
 */
function RouteStory() {
  const [step, setStepState] = useState(0);
  const [visited, setVisited] = useState<number[]>([0]);
  /** Choose a step (a milestone, or a button in the panel): the motorcycle rides there and the panel follows. */
  const setStep = (i: number) => {
    setStepState(i);
    setVisited((v) => (v.includes(i) ? v : [...v, i]));
  };
  const [pick, setPick] = useState(0);
  const roadWrap = useRef<HTMLDivElement>(null);
  const base = useMemo(() => demoStart(), []);
  const result = useMemo(() => (step >= 1 ? demoOptions({ ...base, raining: true }) : null), [step >= 1, base]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = result?.options.filter((o) => o.kind !== 'later').slice(0, 3) ?? [];
  const o = options[Math.min(pick, options.length - 1)];
  const items = base.day.plan!.items;
  const workout = items.find((i) => i.blockId === DEMO_IDS.workout)!;
  const cls = items.find((i) => i.blockId === DEMO_IDS.class)!;
  const later = items.find((i) => i.blockId === DEMO_IDS.personal)!;
  const short = (label: string) => label.replace(/ instead$/, '');

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

      <div className="lp-stage" aria-live="polite">
        {step === 0 && (
          <>
            <h3>Here’s today’s route</h3>
            <p>Two things are already done. Next: a workout outdoors at 2, then class at 3:30 from your Google Calendar, which Segue never moves.</p>
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
              <strong>90% chance until about 5 PM,</strong> and the workout is outdoors. Segue notices before you’re standing in it.
            </p>
            {route(false)}
            <ul className="lp-sc-checks">
              <li>Finds the stop the rain affects</li>
              <li>Looks for indoor places nearby and checks their listed hours</li>
              <li>Counts the trip and the time before class</li>
            </ul>
            <button type="button" className="lp-action" onClick={() => setStep(2)} disabled={!options.length}>
              See options
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h3>Segue finds a practical way forward</h3>
            <p>Real places from OpenStreetMap, open by their listed hours, with time to reach class.</p>
            <div className="lp-sc-pick" role="radiogroup" aria-label="Options Segue found">
              {options.map((x, i) => (
                <button key={x.id} type="button" role="radio" aria-checked={i === pick} className={i === pick ? 'on' : ''} onClick={() => setPick(i)}>
                  {short(x.label)}
                </button>
              ))}
            </div>
            {route(true)}
            <button type="button" className="lp-action" onClick={() => setStep(3)}>
              Use this
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <h3>You decide</h3>
            <p>Nothing moved until you chose. Class stays at {clock(cls.start)}, and Undo is one tap away.</p>
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
                }}
              >
                Start over
              </button>
            </div>
          </>
        )}
      </div>
      <p className="lp-sc-foot">
        A sample day: sample weather and real places from an OpenStreetMap snapshot of Makati, run through Segue’s actual planner.{' '}
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
            <p className="lp-sub">Plan your stops, routines, and commitments in one place. When something changes, Segue helps you find a practical way forward.</p>
            <div className="lp-ctas">
              <MainAction returning={returning} />
              <a className="lp-secondary" href="#how">
                How it works
              </a>
            </div>
            <p className="lp-micro">Free, and it works without an account.</p>
          </div>
          <TodayPreview />
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
            <p className="lp-big">A calendar shows what you planned. Segue helps you find a practical way forward.</p>
          </div>
        </section>

        <section id="how" className="lp-band lp-howband" aria-labelledby="how-title">
          <div className="lp-section">
            <p className="lp-eyebrow">How it works</p>
            <h2 id="how-title">One day, four steps</h2>
            <p className="lp-lead">Press through a real day on Segue’s planner. One step at a time.</p>
            <RouteStory />
          </div>
        </section>

        <section id="tour" className="lp-band" aria-labelledby="tour-title">
          <div className="lp-section">
            <p className="lp-eyebrow">Inside Segue</p>
            <h2 id="tour-title">Five places, one day</h2>
            <p className="lp-lead">The same five tabs you’ll find along the bottom of the app.</p>
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
              <p className="lp-lead">Share where you’re headed with people you trust, and let them ask to come along.</p>
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
          <p>Free, and it works without an account. Bring in your Google Calendar from inside the app whenever you like.</p>
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
              <em>Segue</em> (n.): moving from one thing into the next without a pause. A daily planner built around your route, that adapts when your day changes.
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
              <li><a href="#privacy">Privacy</a></li>
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
