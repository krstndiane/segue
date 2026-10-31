import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { firstName, loadAccount, signUpWithGoogle, type Account } from '../lib/account';
import { DEMO_IDS, demoOptions, demoStart } from '../lib/demo';
import { clock } from '../lib/format';
import { GOOGLE_CLIENT_ID, calendarErrorMessage, preloadGoogle } from '../lib/googleCalendar';
import { parseQuickAdd } from '../lib/quickAdd';
import { enterApp } from '../lib/router';
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

const CAPABILITIES: { title: string; body: string }[] = [
  { title: 'Google Calendar', body: 'Meetings and classes come in as set times that Segue plans around. It only reads your calendar; it never changes it.' },
  { title: 'Real places nearby', body: 'Gyms, cafés, libraries and parks from OpenStreetMap, with their listed hours. When hours aren’t listed, Segue says so instead of guessing.' },
  { title: 'Weather-aware', body: 'Outdoor plans get an indoor option or a drier time when the forecast turns. Umbrella and heat reminders when they matter.' },
  { title: 'One tap to finish', body: 'Tick things off as you go. Skipping one never reshuffles the rest; Segue offers to move things up and waits for your yes.' },
  { title: 'Together', body: 'Share a plan with the people you choose, let them ask to join, and agree on a time. Private plans stay private.' },
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

/** The demo first; then Google (brings in the calendar) or planning without an account. */
function SignUp({ account, busy, error, onSignUp, place }: { account: Account | null; busy: boolean; error: string | null; onSignUp: () => void; place: 'hero' | 'final' }) {
  return (
    <>
      <div className="lp-ctas">
        <a className="lp-primary" href="/demo">
          See how it works
        </a>
        {account ? (
          <a className={place === 'hero' ? 'lp-secondary' : 'lp-secondary dark'} href="/app" onClick={openApp}>
            Continue as {firstName(account)}
          </a>
        ) : GOOGLE_CLIENT_ID ? (
          <GoogleButton className="lp-google" busy={busy} onClick={onSignUp} />
        ) : (
          <a className={place === 'hero' ? 'lp-secondary' : 'lp-secondary dark'} href="/app" onClick={openApp}>
            Start planning
          </a>
        )}
      </div>
      <p className="lp-micro">
        Free. The demo is a sample day and needs no account.{' '}
        {GOOGLE_CLIENT_ID && !account && (
          <>
            Or{' '}
            <a href="/app" onClick={openApp}>
              start without signing up
            </a>
            .
          </>
        )}
      </p>
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
    document.title = 'Segue · A day planner that adapts when plans change';
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
            <a href="/demo">Demo</a>
            <a href="#privacy">Privacy</a>
          </div>
          <a className="lp-open" href="/app" onClick={openApp}>
            Open Segue
          </a>
        </nav>

        <div className="lp-hero-inner">
          <div className="lp-copy">
            <p className="lp-kicker">A day planner for days that don’t go to plan</p>
            <h1>Your day changes. Segue knows what to do next.</h1>
            <p className="lp-sub">
              Tell Segue what you want to get done. It plans around your calendar, the weather, travel time and what’s open. When it rains, a meeting runs
              late or a place is closed, it suggests a realistic new plan, and you decide.
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
            A calendar keeps your plan. It doesn’t tell you what to do when the plan stops working. That’s the part Segue is for.
          </p>
        </section>

        <section id="how" className="lp-section" aria-labelledby="how-title">
          <p className="lp-eyebrow">How it works</p>
          <h2 id="how-title">Three steps, and the third is the point</h2>
          <ol className="lp-how">
            <li>
              <span className="lp-step-n">01</span>
              <div>
                <h3>Plan your day</h3>
                <p>Type what you want to do the way you’d say it. Segue reads the time, how long it takes and the kind of place you need. Try one:</p>
                <TryIt />
              </div>
            </li>
            <li>
              <span className="lp-step-n">02</span>
              <div>
                <h3>Segue works around your day</h3>
                <p>It finds a time and a place for each thing, checking:</p>
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
                <h3>Adapt when something changes</h3>
                <p>
                  When rain, a late meeting or a closed door gets in the way, Segue offers realistic alternatives for the part of your day that’s affected. You see
                  what would change, and nothing moves until you say yes.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section id="example" className="lp-section lp-example" aria-labelledby="example-title">
          <p className="lp-eyebrow">See the difference</p>
          <h2 id="example-title">A workout at 2, class at 3:30, and then it rains</h2>
          <p className="lp-lead">Press the button. Segue’s real planner works out what still fits.</p>
          <Scenario />
        </section>

        <section id="features" className="lp-section" aria-labelledby="features-title">
          <p className="lp-eyebrow">What’s inside</p>
          <h2 id="features-title">Built around one idea: a plan that keeps up with you</h2>
          <dl className="lp-caps">
            {CAPABILITIES.map((c) => (
              <div key={c.title}>
                <dt>{c.title}</dt>
                <dd>{c.body}</dd>
              </div>
            ))}
          </dl>
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
          <h2 id="final-title">See a day go sideways, and how Segue handles it</h2>
          <p>The demo takes about a minute. Then plan your own day, with or without your Google Calendar.</p>
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
              <li><a href="#features">Features</a></li>
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
