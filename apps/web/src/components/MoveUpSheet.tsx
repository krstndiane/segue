import type { MoveUpResult } from '../lib/moveUp';
import { clock } from '../lib/format';
import { Sheet } from './Sheet';

/**
 * The preview for "Move tasks up". Nothing has changed yet: Apply makes the
 * change, anything else (Keep, closing, going offline) leaves the day as it is.
 */
export function MoveUpSheet(props: { busy: boolean; result: MoveUpResult | null; note?: string; onApply: () => void; onKeep: () => void }) {
  const r = props.result;
  return (
    <Sheet title="Suggested schedule adjustment" onClose={props.onKeep}>
      <div className="form">
        {props.note && <p className="muted small">{props.note}</p>}
        {props.busy || !r ? (
          <p className="muted" role="status">
            Checking what can start earlier…
          </p>
        ) : r.kind === 'moves' ? (
          <>
            <ul className="moveup-list">
              {r.moves.map((m) => (
                <li key={m.blockId}>
                  <strong>{m.title}</strong>: {clock(m.from)} → {clock(m.to)}
                </li>
              ))}
            </ul>
            <p className="muted small">Everything else stays where it is. Set times, trips and opening hours are respected.</p>
            <div className="row-actions">
              <button type="button" className="primary" onClick={props.onApply}>
                Apply changes
              </button>
              <button type="button" className="ghost" onClick={props.onKeep}>
                Keep current schedule
              </button>
            </div>
          </>
        ) : (
          <>
            <p role="status">{r.reason}</p>
            <button type="button" className="ghost" onClick={props.onKeep}>
              OK
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}
