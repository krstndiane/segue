import { useState, type ReactNode } from 'react';
import type { TravelMode } from '@segue/engine';
import { MODE_LABEL, type Settings, type StoredBlock } from '../lib/model';
import { LOCATION_WHY, type LocationBannerCopy, type LocationStatus } from '../lib/locationStatus';
import { QuickAdd } from './QuickAdd';

interface Props {
  now: Date;
  /** first name, after signing up with Google */
  name?: string;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  location: LocationStatus;
  /** why location is blocked or missing, when it is */
  locationProblem: LocationBannerCopy | null;
  added: StoredBlock[];
  onAdd: (blocks: StoredBlock[]) => void;
  onRemove: (id: string) => void;
  /** the Google Calendar card, when it's set up */
  calendar: ReactNode;
  calendarConnected: boolean;
  onFinish: () => void;
  /** "Already have a Segue account? Sign in" */
  account?: ReactNode;
}

const MODES: TravelMode[] = ['walk', 'local', 'transit', 'drive'];
const MODE_HINT: Record<TravelMode, string> = {
  walk: 'Places within a short walk',
  local: 'Jeepney, tricycle or UV Express',
  transit: 'MRT, LRT or bus',
  drive: 'Your own car, Grab or a taxi',
};

export function Onboarding(props: Props) {
  const [step, setStep] = useState(0);
  const { settings, location, locationProblem } = props;

  return (
    <div className="onboarding">
      <ol className="steps" aria-label={`Step ${step + 1} of 3`}>
        {[0, 1, 2].map((i) => (
          <li key={i} className={i <= step ? 'on' : ''} aria-hidden="true" />
        ))}
      </ol>

      {step === 0 && (
        <section className="ob-step">
          <h2 className="ob-title">{props.name ? `Welcome, ${props.name}` : 'Plan your day around real life'}</h2>
          {props.calendarConnected && (
            <p className="ok-line">Your Google Calendar is connected. Two quick questions and you're set.</p>
          )}
          <ul className="ob-points">
            <li>Tell Segue what you want to get done, in plain words.</li>
            <li>It finds the time and the place, around what's open and the weather.</li>
            <li>When plans change, one tap re-routes the rest of your day.</li>
          </ul>
          <div className="ob-card" aria-live="polite">
            <strong>Where are you?</strong>
            <p className="muted small">{LOCATION_WHY}</p>
            {location.source === 'here' ? (
              <p className="ok-line">Got it. Your sky is set to {location.label}.</p>
            ) : location.source === 'finding' ? (
              <p className="muted small">Finding you… Your browser may ask first.</p>
            ) : locationProblem && locationProblem.kind !== 'asking' ? (
              <p className="muted small">{locationProblem.text}</p>
            ) : (
              <p className="muted small">
                {location.label}
                {location.note && ` · ${location.note}`}
              </p>
            )}
          </div>
          <button type="button" className="primary wide" onClick={() => setStep(1)}>
            {location.source === 'here' ? 'Next' : 'Next, without location for now'}
          </button>
          {props.account}
        </section>
      )}

      {step === 1 && (
        <section className="ob-step">
          <h2 className="ob-title">How do you get around?</h2>
          <div className="mode-grid" role="radiogroup" aria-label="How you get around">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={settings.mode === m}
                className={settings.mode === m ? 'mode on' : 'mode'}
                onClick={() => props.onChange({ mode: m })}
              >
                <strong>{MODE_LABEL[m]}</strong>
                <span className="muted small">{MODE_HINT[m]}</span>
              </button>
            ))}
          </div>
          <label className="field">
            <span>Your day usually ends around</span>
            <input type="time" value={settings.endOfDay} onChange={(e) => e.target.value && props.onChange({ endOfDay: e.target.value })} />
          </label>
          <div className="row-actions">
            <button type="button" className="ghost tall" onClick={() => setStep(0)}>
              Back
            </button>
            <button type="button" className="primary grow" onClick={() => setStep(2)}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="ob-step">
          <h2 className="ob-title">What's on today?</h2>
          <p className="muted">Type it the way you'd say it, or tap an example.</p>
          <QuickAdd now={props.now} onAdd={props.onAdd} showExamples autoFocus />
          {props.added.length > 0 && (
            <ul className="ob-added">
              {props.added.map((b) => (
                <li key={b.id}>
                  <span>
                    {b.title}
                    <span className="muted small">
                      {' '}
                      · {b.fixedStart ? `${b.fixedStart}–${b.fixedEnd}` : `${b.maxMinutes} min`}
                    </span>
                  </span>
                  <button type="button" className="text-button" onClick={() => props.onRemove(b.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {props.calendar}
          <button
            type="button"
            className="primary wide"
            disabled={props.added.length === 0 && !props.calendarConnected}
            onClick={props.onFinish}
          >
            Plan my day
          </button>
          <div className="row-actions center">
            <button type="button" className="text-button" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" className="text-button" onClick={props.onFinish}>
              Skip for now
            </button>
          </div>
          <p className="muted small center">
            Want to see Segue handle a busy day first? <a href="/demo">Watch a sample day</a> (it doesn&apos;t touch your plans).
          </p>
        </section>
      )}
    </div>
  );
}
