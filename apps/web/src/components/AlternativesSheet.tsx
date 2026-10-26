import type { AlternativeOption, Fact } from '@segue/engine';
import type { AlternativesOutcome } from '../lib/alternatives';
import { clock, duration } from '../lib/format';
import { RideLoader } from './RideLoader';
import { Sheet } from './Sheet';

interface Props {
  title: string;
  busy: boolean;
  error: string | null;
  outcome: AlternativesOutcome | null;
  onUse: (option: AlternativeOption) => void;
  /** don't offer this place again today */
  onNotThis: (placeId: string) => void;
  /** "I only have …" (undefined = as planned) */
  onMaxMinutes: (minutes: number | undefined) => void;
  onClose: () => void;
}

const LIMITS = [30, 45, 60];

function FactLine({ fact }: { fact: Fact }) {
  // Unknowns are said as unknowns, with a word, not only a colour.
  return <li className={`alt-fact alt-fact-${fact.kind}`}>{fact.kind === 'unknown' ? <><span className="visually-hidden">Not confirmed: </span>{fact.text}</> : fact.text}</li>;
}

/** Realistic options for one item, each checked against the rest of the day. Nothing changes until "Use this". */
export function AlternativesSheet({ title, busy, error, outcome, onUse, onNotThis, onMaxMinutes, onClose }: Props) {
  const r = outcome?.result;
  const limit = outcome?.request.maxMinutes;
  return (
    <Sheet title={`Other options for ${title}`} onClose={onClose}>
      <div className="proposal alternatives" aria-busy={busy}>
        {busy && <RideLoader label="Checking what's open and what fits…" />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {!busy && r && (
          <>
            {outcome!.warnings.length > 0 && <p className="notice">{outcome!.warnings.join(' ')}</p>}
            {r.problem && <p className={`lede small-lede alt-problem alt-problem-${r.problem.kind}`}>{r.problem.text}.</p>}
            {r.nextCommitment && (
              <p className="muted small">
                Next set time: <strong>{r.nextCommitment.title}</strong> at {clock(r.nextCommitment.start)}. Every option leaves room for it.
              </p>
            )}

            {r.options.length > 0 ? (
              <ol className="alt-list">
                {r.options.map((o) => (
                  <li key={o.id} className="alt-option">
                    <p className="alt-when">
                      {clock(o.start)}–{clock(o.end)} · {duration(o.minutes)}
                      {o.travelMinutes > 0 && ` · about ${o.travelMinutes} min away`}
                    </p>
                    <h3 className="alt-label">{o.label}</h3>
                    <ul className="alt-facts">
                      {o.facts.map((f) => (
                        <FactLine key={f.text} fact={f} />
                      ))}
                      {o.tradeoffs.map((t) => (
                        <li key={t} className="alt-fact alt-tradeoff">
                          <span className="visually-hidden">Trade-off: </span>
                          {t}
                        </li>
                      ))}
                    </ul>
                    <div className="alt-actions">
                      <button type="button" className="primary" onClick={() => onUse(o)}>
                        Use this
                      </button>
                      {o.place && (
                        <button type="button" className="text-button" onClick={() => onNotThis(o.place!.id)}>
                          Not this place
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="lede small-lede">Nothing realistic fits right now.</p>
            )}

            <fieldset className="field">
              <legend>How much time do you have?</legend>
              <div className="chips">
                <button type="button" className={limit === undefined ? 'chip on' : 'chip'} aria-pressed={limit === undefined} onClick={() => onMaxMinutes(undefined)}>
                  As planned
                </button>
                {LIMITS.map((m) => (
                  <button key={m} type="button" className={limit === m ? 'chip on' : 'chip'} aria-pressed={limit === m} onClick={() => onMaxMinutes(m)}>
                    {duration(m)}
                  </button>
                ))}
              </div>
            </fieldset>

            {r.excluded.length > 0 && (
              <details className="alt-excluded">
                <summary>Why not other places ({r.excluded.length})</summary>
                <ul>
                  {r.excluded.map((e) => (
                    <li key={e.label + (e.placeId ?? '')}>
                      <strong>{e.label}</strong>: {e.reason}.
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {r.notes.length > 0 && (
              <ul className="alt-notes muted small">
                {r.notes.map((n) => (
                  <li key={n.text}>{n.text}.</li>
                ))}
              </ul>
            )}

            <div className="row-actions center">
              <button type="button" className="text-button" onClick={onClose}>
                Keep my plan
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
