import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { firstName, loadAccount, signUpWithGoogle, type Account } from '../lib/account';
import { DEMO_IDS, demoOptions, demoStart } from '../lib/demo';
import { clock } from '../lib/format';
import { GOOGLE_CLIENT_ID, calendarErrorMessage, preloadGoogle } from '../lib/googleCalendar';
import { parseQuickAdd } from '../lib/quickAdd';
import { enterApp } from '../lib/router';
import { NAV_ICONS, NAV_LABELS, type NavTab } from './BottomNav';
import { GoogleButton } from './GoogleButton';
import { EXAMPLES } from './QuickAdd';
import { Sky, sceneFor } from './Sky';
import { Timeline } from './Timeline';
import '../landing.css';

const PROBLEMS = [
  ['It starts raining', 'and your run is outdoors.'],
  ['A meeting runs late', 'and everything after it is now wrong.'],
  ['The place is closed', 'or too far to reach before your class.'],
];

const CONTEXT = ['Your Google Calendar, kept exactly where it is', 'The weather, hour by hour', 'Real places nearby and their listed opening hours', 'Travel time, rush hour included', 'What has to happen before what'];

/** The app's five tabs, each in terms of what you can do there. Same icons as the app's bottom navigation. */
const TOUR: { tab: NavTab; body: string }[] = [
  { tab: 'today', body: 'See what’s next, tick things off, skip without reshuffling the rest, and get a suggestion when something gets in the way.' },
  { tab: 'plan', body: 'Add what you want to get done the way you’d say it, choose what matters most, and let Segue fit it around your fixed times.' },
  { tab: 'days', body: 'Your Google Calendar events and your own plans, day by day. Segue reads your calendar and never changes it.' },
  { tab: 'routines', body: 'Things you do on certain days, like a weekday workout or a morning read. Segue fits them into each of those days.' },
  { tab: 'together', body: 'Share a plan with people you choose, let them ask to join, and agree on a time. Everything else stays private.' },
];

const TOGETHER_POINTS = [
  'Share one plan, not your whole schedule.',
  '“Can I join?” only asks. You say yes or not this time.',
  'An invitation never changes your day unless you add it.',
];

const PRIVACY = [
  'Your plans are saved on your phone. A Segue account is optional and only syncs your plans between your devices.',
  'Google Calendar is read in your browser. Segue never writes to it.',
  'Your location is used to plan and check the weather; the weather uses a spot rounded to about 1 km. The server doesn’t store it.',
];

/** The real Today screen on the sample day, at the moment the rain starts. Not interactive here. */
function TodayPreview() {
  const s = useMemo(() => ({ ...demoStart(), raining: true }), []);
  const workout = s.day.plan!.items.find((i) => i.blockId === DEMO_IDS.workout)!;
  return (
    <figure className="lp-preview">
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

/** The core idea, live: the real engine on the sample day, before and after the rain. */
function Scenario() {
  const [raining, setRaining] = useState(false);
  const [pick, setPick] = useState(0);
  const base = useMemo(() => demoStart(), []);
  const result = useMemo(() => (raining ? demoOptions({ ...base, raining: true }) : null), [raining, base]);
  const options = result?.options.filter((o) => o.kind !== 'later').slice(0, 3) ?? [];
  const o = options[Math.min(pick, options.length - 1)];
  const workout = base.day.plan!.items.find((i) => i.blockId === DEMO_IDS.workout)!;
  const t = (iso: string) => clock(iso);
  return (
    <div className="lp-scenario">
      <div className="lp-sc-col">
        <p className="lp-sc-head">Your plan</p>
        <ol className="lp-sc-list">
          <li className={raining ? 'hit' : ''}>
            <b>{t(workout.start)}</b> Outdoor workout <span>Ayala Triangle Gardens</span>
          </li>
          <li className="set">
            <b>3:30 PM</b> Class <span className="tag">Calendar</span>
          </li>
        </ol>
        {!raining ? (
          <button type="button" className="lp-rain" onClick={() => setRaining(true)}>
            Make it rain
          </button>
        ) : (
          <p className="lp-sc-alert">
            <strong>It starts raining.</strong> 90% chance until about 5 PM, and the workout is outdoors.
          </p>
        )}
      </div>

      <div className={`lp-sc-col lp-sc-after${raining ? ' on' : ''}`} aria-live="polite">
        <p className="lp-sc-head">What Segue does</p>
        {!raining || !o ? (
          <p className="lp-sc-wait">Press “Make it rain” to see what Segue checks and suggests.</p>
        ) : (
          <>
            <ul className="lp-sc-checks">
              <li>Sees the workout is outdoors and it’s going to rain</li>
              <li>Looks for indoor places nearby and checks their listed hours</li>
              <li>Counts the trip there and the time before Class</li>
              <li>Keeps Class at 3:30 PM exactly where it is</li>
            </ul>
            <div className="lp-sc-pick" role="radiogroup" aria-label="Options Segue found">
              {options.map((x, i) => (
                <button key={x.id} type="button" role="radio" aria-checked={i === pick} className={i === pick ? 'on' : ''} onClick={() => setPick(i)}>
                  {x.label.replace(/ instead$/, '')}
                </button>
              ))}
            </div>
            <ol className="lp-sc-list after">
              <li className="changed">
                <b>{t(o.start)}</b> {o.label.replace(/ instead$/, '')}
                <span>{o.facts.map((f) => f.text).filter((x) => /Open|Leaves|No trip|min to get/.test(x)).join(' · ')}</span>
              </li>
              <li className="set">
                <b>3:30 PM</b> Class <span>Unchanged</span>
              </li>
            </ol>
            <p className="lp-sc-note">Nothing changes until you choose “Use this”.</p>
          </>
        )}
      </div>
      <p className="lp-sc-foot">
        Sample scenario: sample weather and real places from an OpenStreetMap snapshot of Makati, run through Segue’s actual planner.{' '}
        <a href="/demo">Try the full demo</a>
      </p>
    </div>
  );
}

function TryIt() {
  const [text, setText] = useState('Gym 1h after 5pm');
  const parsed = useMemo(() => (text.trim() ? parseQuickAdd(text, new Date()) : null), [text]);
  return (
    <div className="lp-try-box">
      <label htmlFor="lp-try" className="visually-hidden">
        Type something you want to do today
      </label>
      <input id="lp-try" value={text} onChange={(e) => setText(e.target.value)} placeholder="Try: Lunch with Ana 12:30 at Greenbelt" autoComplete="off" />
      <div className="lp-try-result" aria-live="polite">
        {parsed ? (
          <>
            <strong>{parsed.block.title}</strong>
            <span className="chips">
              {parsed.chips.map((c) => (
                <span key={c} className="chip static">
                  {c}
                </span>
              ))}
            </span>
          </>
        ) : (
          <span className="muted">Type something you want to do today.</span>
        )}
      </div>
      <div className="chips">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" className="chip" onClick={() => setText(e)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Into the app without a page load, so a Google sign-in made here carries over. */
function openApp(e: MouseEvent) {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  enterApp('');
}

/** Start planning (the app, no account needed), or see the one-minute sample day; Google sign-up underneath. */
function SignUp({ account, busy, error, onSignUp, place }: { account: Account | null; busy: boolean; error: string | null; onSignUp: () => void; place: 'hero' | 'final' }) {
  return (
    <>
      <div className="lp-ctas">
        <a className="lp-primary" href="/app" onClick={openApp}>
          {account ? `Continue as ${firstName(account)}` : 'Get started'}
        </a>
        <a className={place === 'hero' ? 'lp-secondary' : 'lp-secondary dark'} href="/demo">
          See how it works
        </a>
      </div>
      {!account && GOOGLE_CLIENT_ID && (
        <div className="lp-google-row">
          <span className="lp-micro">Use Google Calendar? Bring it in from the start:</span>
          <GoogleButton className="lp-google" busy={busy} onClick={onSignUp} />
        </div>
      )}
      <p className="lp-micro">Free. No account needed to start. “See how it works” is a sample day, not your data.</p>
      {error && (
        <p className="lp-error" role="alert">
          {error}{' '}
          <a href="/demo">Try the demo</a> ·{' '}
          <a href="/app" onClick={openApp}>
            Use Segue without Google
          </a>
        </p>
      )}
    </>
  );
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
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAccount().then((a) => setAccount(a ?? null));
    // Load Google's sign-in early so its window opens straight from the tap.
    if (GOOGLE_CLIENT_ID) preloadGoogle().catch(() => {});
  }, []);

  async function signUp() {
    setBusy(true);
    setError(null);
    try {
      await signUpWithGoogle();
      enterApp('');
    } catch (e) {
      setError(calendarErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    document.title = 'Segue · Intelligent daily planner';
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
            <a href="/demo">Demo</a>
          </div>
          <a className="lp-open" href="/app" onClick={openApp}>
            Open Segue
          </a>
        </nav>

        <div className="lp-hero-inner">
          <div className="lp-copy">
            <p className="lp-kicker">Intelligent daily planner</p>
            <h1>Your day, planned around real life.</h1>
            <p className="lp-sub">
              Segue organizes your tasks, routines and Google Calendar into one realistic day. When it rains, a meeting runs late or a place is closed, it
              suggests what to do next, and you decide.
            </p>
            <SignUp account={account} busy={busy} error={error} onSignUp={() => void signUp()} place="hero" />
          </div>
          <TodayPreview />
        </div>
      </header>

      <main>
        <section className="lp-section lp-problem" aria-labelledby="problem-title">
          <p className="lp-eyebrow">The problem</p>
          <h2 id="problem-title">You planned your day. Then the day happened.</h2>
          <ul className="lp-problems">
            {PROBLEMS.map(([a, b]) => (
              <li key={a}>
                <strong>{a}</strong> {b}
              </li>
            ))}
          </ul>
          <p className="lp-big">
            You planned to work out outside. Then it started raining, and your class is still at 3:30. Now what? A calendar shows what you planned. Segue
            helps with what to do next.
          </p>
        </section>

        <section id="how" className="lp-section" aria-labelledby="how-title">
          <p className="lp-eyebrow">How it works</p>
          <h2 id="how-title">Plan, understand, adapt</h2>
          <ol className="lp-how">
            <li>
              <span className="lp-step-n">01</span>
              <div>
                <h3>Plan</h3>
                <p>Add your tasks, routines and commitments, and say what matters most. Type them the way you’d say them. Try one:</p>
                <TryIt />
              </div>
            </li>
            <li>
              <span className="lp-step-n">02</span>
              <div>
                <h3>Understand</h3>
                <p>Segue finds a time and a place for each thing, checking:</p>
                <ul className="lp-checks">
                  {CONTEXT.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </li>
            <li>
              <span className="lp-step-n">03</span>
              <div>
                <h3>Adapt</h3>
                <p>
                  When rain, a late meeting or a closed door gets in the way, Segue offers realistic alternatives for the part of your day that’s affected. You see
                  what would change, and nothing moves until you say yes.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section id="tour" className="lp-section" aria-labelledby="tour-title">
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
        </section>

        <section id="example" className="lp-section lp-example" aria-labelledby="example-title">
          <p className="lp-eyebrow">When plans change</p>
          <h2 id="example-title">A workout at 2, class at 3:30, and then it rains</h2>
          <p className="lp-lead">
            Segue spots the outdoor plan the rain affects, finds real places nearby that are open, checks there’s still time to reach your class, and lets you
            choose. Press the button to see it on the real planner.
          </p>
          <Scenario />
        </section>

        <section id="together" className="lp-section lp-together" aria-labelledby="together-title">
          <div className="lp-split">
            <div>
              <p className="lp-eyebrow">Plan together</p>
              <h2 id="together-title">Make time for the people who matter</h2>
              <p className="lp-lead">Share an activity with people you trust, invite them, and agree on a time, without handing over your whole calendar.</p>
            </div>
            <ul className="lp-checks">
              {TOGETHER_POINTS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="privacy" className="lp-section lp-privacy" aria-labelledby="privacy-title">
          <div className="lp-split">
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
          <p>Free, and it works without an account. Bring in your Google Calendar whenever you like, or watch a one-minute sample day first.</p>
          <SignUp account={account} busy={busy} error={error} onSignUp={() => void signUp()} place="final" />
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
              <em>Segue</em> (n.): in music, moving from one piece into the next without a pause. A day planner that adapts when your day changes.
            </p>
          </div>

          <nav className="lp-footer-col" aria-labelledby="ft-explore">
            <h2 id="ft-explore">Explore</h2>
            <ul>
              <li><a href="/demo">Demo</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#example">The rain example</a></li>
              <li><a href="#tour">Features</a></li>
              <li><a href="#together">Plan together</a></li>
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
              <li><a href="/app" onClick={openApp}>Open Segue</a></li>
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
