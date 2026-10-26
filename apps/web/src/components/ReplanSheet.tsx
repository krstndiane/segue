import { useEffect, useState } from 'react';
import type { Plan } from '@segue/engine';
import { clock } from '../lib/format';
import { REASONS, type ReplanReason } from '../lib/replan';
import { ConflictNote } from './ConflictNote';
import type { RerouteOutcome } from '../lib/reroute';
import { RideLoader } from './RideLoader';
import { Sheet } from './Sheet';

interface Props {
  busy: boolean;
  error: string | null;
  outcome: RerouteOutcome | null;
  reason: ReplanReason | null;
  onReason: (r: ReplanReason | null) => void;
  onAccept: (plan: Plan) => void;
  onClose: () => void;
  onOptions: () => void;
}

const CHANGE_WORD = { added: 'New', removed: 'Dropped', moved: 'Moved', 'place-changed': 'New place', unchanged: '' } as const;

export function ReplanSheet({ busy, error, outcome, reason, onReason, onAccept, onClose, onOptions }: Props) {
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [outcome]);
  const options = outcome ? [outcome.plan, ...outcome.alternatives] : [];
  const chosen = options[pick];
  const changes = outcome && pick === 0 ? outcome.changes.filter((c) => c.kind !== 'unchanged') : [];
  const hint = REASONS.find((r) => r.id === reason)?.hint;

  return (
    <Sheet title="Re-route from here" onClose={onClose}>
      <div className="proposal">
        <fieldset className="field">
          <legend>What changed? (optional)</legend>
          <div className="chips reasons">
            {REASONS.map((r) => (
              <button
                key={r.id}
                type="button"
                className={reason === r.id ? 'chip on' : 'chip'}
                aria-pressed={reason === r.id}
                disabled={busy}
                onClick={() => onReason(reason === r.id ? null : r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          {hint && <p className="muted small">{hint}</p>}
        </fieldset>

        {busy && <RideLoader />}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {!busy && outcome && chosen && (
          <>
            {outcome.warnings.length > 0 && (
              <p className="notice">{outcome.warnings.join(' ')}</p>
            )}

            {options.length > 1 && (
              <div className="segmented" role="tablist" aria-label="Plan options">
                {options.map((p, i) => (
                  <button key={p.label} type="button" role="tab" aria-selected={pick === i} className={pick === i ? 'on' : ''} onClick={() => setPick(i)}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {pick === 0 && changes.length === 0 ? (
              <p className="lede small-lede">Your plan still works. Nothing needed to change.</p>
            ) : (
              changes.length > 0 && (
                <ul className="changes">
                  {changes.map((c) => (
                    <li key={c.blockId}>
                      <span className={`change change-${c.kind}`}>{CHANGE_WORD[c.kind]}</span>
                      <span>
                        <strong>{c.title}</strong> {c.message.charAt(0).toLowerCase() + c.message.slice(1)}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            )}

            <ol className="preview">
              {chosen.items.map((i) => (
                <li key={i.blockId}>
                  <span className="tl-time">{clock(i.start)}</span>
                  <span>
                    {i.title}
                    <span className="muted"> · {i.place?.name ?? 'anywhere'}</span>
                    <ConflictNote item={i} />
                  </span>
                </li>
              ))}
            </ol>
            {chosen.unscheduled.length > 0 && <p className="muted small">Won't fit: {chosen.unscheduled.map((u) => u.title).join(', ')}</p>}

            <button type="button" className="primary wide" onClick={() => onAccept(chosen)}>
              Use this plan
            </button>
            <div className="row-actions center">
              <button type="button" className="text-button" onClick={onClose}>
                Keep my current plan
              </button>
              <button type="button" className="text-button" onClick={onOptions}>
                End time and travel settings
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
