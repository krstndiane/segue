import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { firstName, loadAccount, signUpWithGoogle, type Account } from '../lib/account';
import { GOOGLE_CLIENT_ID, calendarErrorMessage, preloadGoogle } from '../lib/googleCalendar';
import { parseQuickAdd } from '../lib/quickAdd';
import { enterApp } from '../lib/router';
import { REASONS } from '../lib/replan';
import type { SkyCondition } from '../lib/weather';
import { GoogleButton } from './GoogleButton';
import { EXAMPLES } from './QuickAdd';
import { Sky, sceneFor } from './Sky';
import '../landing.css';

const SKIES: { id: SkyCondition; label: string }[] = [
  { id: 'clear', label: 'Sunny' },
  { id: 'partly-cloudy', label: 'Partly cloudy' },
  { id: 'cloudy', label: 'Cloudy' },
  { id: 'fog', label: 'Fog' },
  { id: 'rain', label: 'Rain' },
  { id: 'heavy-rain', label: 'Heavy rain' },
  { id: 'storm', label: 'Storm' },
];

const STEPS = [
  {
    title: "Say what's on today",
    body: 'Gym 1h after 5pm. Lunch with Ana 12:30 at Greenbelt. Groceries before 8. Type it the way you would text a friend.',
  },
  {
    title: 'Segue fits it together',
    body: 'It picks a time and a place for each one, checks opening hours and travel, and puts your must-dos first.',
  },
  {
    title: 'Re-route when plans change',
    body: 'Running late or caught in the rain? One tap rebuilds the rest of the day, and you see what moved before you accept it.',
  },
];

const FEATURES = [
  {
    title: 'The weather outside',
    body: 'When it rains, outdoor plans move inside and Segue tells you to bring an umbrella. On hot days it says when to wear sunscreen and find shade, and in heavy rain, to drive safely.',
    icon: 'M7 18h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 18zM9 21l1-2M13 21l1-2',
  },
  {
    title: 'Your Google Calendar',
    body: 'Meetings and classes stay exactly where they are, and Segue plans the gaps between them. It only reads your calendar.',
    icon: 'M5 6h14v13H5zM5 10h14M9 3v4M15 3v4',
  },
  {
    title: 'Jeepneys, trikes and rush hour',
    body: 'Travel time includes waiting for a ride, and rides take longer from 7 to 10 AM and 5 to 8 PM on weekdays.',
    icon: 'M4 16V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8M4 12h16M7 19a1.5 1.5 0 1 0 0-.1M17 19a1.5 1.5 0 1 0 0-.1',
  },
  {
    title: "What's open",
    body: "Segue checks opening hours before it sends you somewhere, and says so when a place's hours aren't confirmed.",
    icon: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  },
  {
    title: 'A nudge at the right time',
    body: '"Leave by 1:16 PM." "Still on deep work?" "It\'s raining and your run is outside." Each one comes with the next step.',
    icon: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  },
  {
    title: 'Your usual spots',
    body: 'Save the café with good Wi-Fi or the gym near home, and Segue picks them whenever they fit.',
    icon: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
  },
];

const PRIVACY = [
  'Your plans, routines and history are saved on your phone. Signing up with Google keeps your name and calendar on this device too.',
  'A Segue account is optional. With one, your plans follow you to every device, but never your location or calendar events, and nothing you write is shared unless you choose to.',
  'Planning works with no signal, using the places from your last connection.',
  "Your location is sent only when Segue plans your day, checks the weather or names where you are. The weather and name use a spot rounded to about 1 km. Segue's server doesn't save it.",
  "Google Calendar is read in your browser, and Segue's server never sees your Google sign-in. When you re-route, your event titles and times go to the server so it can plan around them. They aren't saved.",
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A static picture of the app's Today screen. */
function PhoneMock({ condition }: { condition: SkyCondition }) {
  const wet = condition === 'rain' || condition === 'heavy-rain' || condition === 'storm';
  return (
    <div className="lp-phone" aria-hidden="true">
      <div className={`lp-phone-sky ${condition}`}>
        <img src="/wordmark-light.svg" alt="" />
        <span>
          {wet
            ? '26° · Rain'
            : condition === 'cloudy'
              ? '28° · Cloudy'
              : condition === 'fog'
                ? '24° · Foggy'
                : condition === 'partly-cloudy'
                  ? '30° · Partly cloudy'
                  : '31° · Clear and sunny'}
        </span>
      </div>
      <div className="lp-phone-body">
        <div className="lp-phone-input">Add something… e.g. Gym 1h after 5pm</div>
        {wet && (
          <div className="lp-phone-nudge">
            <strong>It's raining: Run is outside</strong>
            <span>Re-route to move it indoors or to later.</span>
          </div>
        )}
        <div className="lp-phone-next">
          <span className="lp-phone-time">
            1:40 <em>PM</em>
            <small>in 25 min</small>
          </span>
          <strong>Coffee and emails</strong>
          <span>Tasa Café · 12 min walk</span>
          <span className="lp-phone-open">Open then</span>
        </div>
        <ol className="lp-phone-list">
          <li>
            <b>3:00 PM</b> Standup <i>Calendar</i>
          </li>
          <li className="gap">1 h 30 min free · Add something</li>
          <li>
            <b>5:30 PM</b> {wet ? 'Gym instead of run' : 'Run'} <span>{wet ? 'Pulse Fitness' : 'Ayala Triangle'}</span>
          </li>
          <li>
            <b>7:15 PM</b> Groceries <span>Daily Mart</span>
          </li>
        </ol>
        <div className="lp-phone-cta">Re-route from here</div>
      </div>
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

/** Sign up with Google (connects the calendar), or go in without an account. */
function SignUp({ account, busy, error, onSignUp, place }: { account: Account | null; busy: boolean; error: string | null; onSignUp: () => void; place: 'hero' | 'final' }) {
  if (account) {
    return (
      <div className="lp-ctas">
        <a className="lp-primary" href="/app" onClick={openApp}>
          Continue as {firstName(account)}
        </a>
      </div>
    );
  }
  if (!GOOGLE_CLIENT_ID) {
    return (
      <>
        <div className="lp-ctas">
          <a className="lp-primary" href="/app" onClick={openApp}>
            Plan my day
          </a>
          {place === 'hero' && (
            <a className="lp-secondary" href="#how">
              See how it works
            </a>
          )}
        </div>
        {place === 'hero' && <p className="lp-micro">Free. No account needed. Works offline.</p>}
      </>
    );
  }
  return (
    <>
      <div className="lp-ctas">
        <GoogleButton className="lp-google" busy={busy} onClick={onSignUp} />
        <a className={place === 'hero' ? 'lp-secondary' : 'lp-secondary dark'} href="/app" onClick={openApp}>
          Try it without signing up
        </a>
      </div>
      <p className="lp-micro">Free. Signing up with Google brings in your calendar, so Segue plans around your meetings. It only ever reads it.</p>
      {error && (
        <p className="lp-error" role="alert">
          {error}
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

  const [sky, setSky] = useState<SkyCondition>('clear');

  useEffect(() => {
    document.title = 'Segue · A day planner that re-routes when plans change';
  }, []);

  return (
    <div className="landing">
      <header className="lp-hero">
        {/* Always the daytime sky here, so the chips match what you see. */}
        <Sky scene={sceneFor({ condition: sky })} />
        <nav className="lp-nav" aria-label="Segue">
          <a href="/" className="lp-logo">
            <img src="/wordmark-light.svg" alt="Segue" />
          </a>
          <div className="lp-links">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#privacy">Privacy</a>
          </div>
          <a className="lp-open" href="/app" onClick={openApp}>
            Open Segue
          </a>
        </nav>

        <div className="lp-hero-inner">
          <div className="lp-copy">
            <h1>Missed the jeep? Café closed? Re-route your day in one tap.</h1>
            <p className="lp-sub">
              Tell Segue what you want to get done, the way you'd say it. It finds the time and the place around what's open, the weather, rush hour
              and your Google Calendar.
            </p>
            <SignUp account={account} busy={busy} error={error} onSignUp={() => void signUp()} place="hero" />
            <div className="lp-sky-switch" role="group" aria-label="Change the sky">
              <span>The sky follows your weather. Try it:</span>
              {SKIES.map((s) => (
                <button key={s.id} type="button" aria-pressed={sky === s.id} className={sky === s.id ? 'on' : ''} onClick={() => setSky(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <PhoneMock condition={sky} />
        </div>
      </header>

      <main>
        <section id="try" className="lp-section lp-try" aria-labelledby="try-title">
          <div className="lp-split">
            <div>
              <p className="lp-eyebrow">Plain words in</p>
              <h2 id="try-title">Type it the way you'd say it</h2>
              <p>
                Segue reads times, how long things take, and the kind of place you need. Anything it doesn't recognize stays in the title, so nothing
                you typed is lost. Try one.
              </p>
            </div>
            <TryIt />
          </div>
        </section>

        <section id="how" className="lp-section" aria-labelledby="how-title">
          <p className="lp-eyebrow">How it works</p>
          <h2 id="how-title">From a list in your head to a plan you can follow</h2>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="lp-step-n">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="reasons" className="lp-section lp-reasons" aria-labelledby="reasons-title">
          <div className="lp-split">
            <div>
              <p className="lp-eyebrow">When the day goes sideways</p>
              <h2 id="reasons-title">Tell it what happened</h2>
              <p>
                Tap Re-route and Segue plans from where you are now. If you say why, it knows what to change. You always see the new plan before it
                replaces the old one, and you can undo it.
              </p>
            </div>
            <ul className="lp-reason-list">
              {REASONS.map((r) => (
                <li key={r.id}>
                  <span className="chip on">{r.label}</span>
                  <span>{r.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="features" className="lp-section" aria-labelledby="features-title">
          <p className="lp-eyebrow">What it plans around</p>
          <h2 id="features-title">The things that usually wreck a plan</h2>
          <ul className="lp-features">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="lp-feature-icon">
                  <Icon d={f.icon} />
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="privacy" className="lp-section lp-privacy" aria-labelledby="privacy-title">
          <div className="lp-split">
            <div>
              <p className="lp-eyebrow">Privacy</p>
              <h2 id="privacy-title">Your day stays on your phone</h2>
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
          <h2 id="final-title">Start with what's on today</h2>
          <p>
            {GOOGLE_CLIENT_ID && !account
              ? 'Sign up with Google and your meetings are already in your plan. Add it to your home screen and it opens like an app.'
              : 'Add a few things, and Segue plans the rest of your day. Add it to your home screen and it opens like an app.'}
          </p>
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
              <em>Segue</em> (n.): in music, moving from one piece into the next without a pause. A day planner that
              re-routes itself when life goes off-script.
            </p>
          </div>

          <nav className="lp-footer-col" aria-labelledby="ft-explore">
            <h2 id="ft-explore">Explore</h2>
            <ul>
              <li><a href="#try">Try it</a></li>
              <li><a href="#how">How it works</a></li>
              <li><a href="#reasons">Re-route with a reason</a></li>
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
