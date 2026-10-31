import { useState } from 'react';
import type { FallbackOption, PlanItem, TravelMode } from '@segue/engine';
import { isCalendarBlock, type CalendarEvent } from '../lib/calendar';
import { clock, directionsUrl, duration, minutesBetween, travelLine } from '../lib/format';
import type { StoredBlock } from '../lib/model';
import { Sheet } from './Sheet';

interface Props {
  item: PlanItem;
  block?: StoredBlock;
  event?: CalendarEvent;
  mode: TravelMode;
  locked: boolean;
  savedSpot: boolean;
  onClose: () => void;
  onDone: () => void;
  onSkip: () => void;
  /** one-offs move to tomorrow; routines are left out today (missing for calendar events) */
  onPostpone?: () => void;
  onTogglePin: () => void;
  onMove: (hhmm: string) => void;
  onUseFallback: (f: FallbackOption) => void;
  onToggleSpot: () => void;
  onEdit?: () => void;
  /** realistic other options for this item (flexible items only) */
  onOptions?: () => void;
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Google Calendar "add event" link: no permissions needed, the user confirms in Google. */
function addToCalendarUrl(item: PlanItem): string {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: item.title,
    dates: `${fmt(item.start)}/${fmt(item.end)}`,
    details: 'Planned with Segue',
  });
  if (item.place) params.set('location', item.place.address ?? item.place.name);
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Plain reasons for where and when the item landed. */
function reasons(item: PlanItem, block: StoredBlock | undefined, locked: boolean, mode: TravelMode): string[] {
  const out: string[] = [];
  if (item.conflict) out.push(`${item.conflict}. Segue won't move or drop a set-time commitment, so decide which one to keep, or let people know you'll be late.`);
  if (isCalendarBlock(item.blockId)) out.push("It's on your Google Calendar, so it stays at this time.");
  else if (item.fixed) out.push('It happens at a set time, so it stays put.');
  else if (locked) out.push('You pinned it to this time.');
  if (item.explanation) out.push(item.explanation.endsWith('.') ? item.explanation : `${item.explanation}.`);
  if (item.confidence === 'verified' && item.place) out.push(`${item.place.name} is open for the whole time.`);
  if (item.confidence === 'unconfirmed') out.push("Opening hours aren't confirmed, so check before you go.");
  const travel = travelLine(item, mode);
  if (travel) out.push(`It's ${travel} from your previous stop.`);
  if (block?.priority === 'must') out.push('You marked it as a must do, so it was planned first.');
  if (block?.requirements.length && item.place) out.push('The place has what it needs, as far as Segue knows.');
  return [...new Set(out)];
}

export function ItemSheet(props: Props) {
  const { item, block, event, mode, locked } = props;
  const [time, setTime] = useState(hhmm(item.start));
  const directions = directionsUrl(item);
  const movable = !item.fixed && !isCalendarBlock(item.blockId);

  return (
    <Sheet title={item.title} onClose={props.onClose}>
      <div className="item-sheet">
        <p className="item-when">
          {clock(item.start)}–{clock(item.end)} · {duration(minutesBetween(item.start, item.end))}
        </p>
        <p className="item-where">
          {item.place?.name ?? event?.location ?? (item.explanation && !item.place ? item.explanation : 'Anywhere')}
          {item.place?.address && <span className="muted"> · {item.place.address}</span>}
        </p>

        <section>
          <h3 className="section-title">Why this?</h3>
          <ul className="why-list">
            {reasons(item, block, locked, mode).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>

        {movable && (
          <section>
            <h3 className="section-title">Change the time</h3>
            <div className="move-row">
              <label className="visually-hidden" htmlFor="move-time">
                New start time
              </label>
              <input id="move-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              <button type="button" className="ghost" disabled={!time || time === hhmm(item.start)} onClick={() => props.onMove(time)}>
                Move here
              </button>
            </div>
            <p className="muted small">It stays at the new time; re-route to fit the rest around it.</p>
          </section>
        )}

        {item.fallbacks.length > 0 && (
          <section className="fallbacks">
            <h3 className="section-title">If this doesn't work out</h3>
            <ul>
              {item.fallbacks.map((f) => (
                <li key={f.label}>
                  <span>{f.label}</span>
                  <button type="button" className="text-button" onClick={() => props.onUseFallback(f)}>
                    Use instead
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {movable && props.onOptions && (
          <p className="item-options">
            <button type="button" className="text-button" onClick={props.onOptions}>
              Closed, raining or short on time? See other options
            </button>
          </p>
        )}

        <div className="row-actions">
          <button type="button" className="primary" onClick={props.onDone}>
            Done
          </button>
          <button type="button" className="ghost tall" onClick={props.onSkip}>
            Skip today
          </button>
          {props.onPostpone && (
            <button type="button" className="ghost tall" onClick={props.onPostpone}>
              {props.block?.date ? 'Move to tomorrow' : 'Not today'}
            </button>
          )}
          {directions && (
            <a className="ghost tall" href={directions} target="_blank" rel="noreferrer">
              Directions
            </a>
          )}
        </div>
        <div className="row-actions">
          {movable && (
            <button type="button" className="ghost" aria-pressed={locked} onClick={props.onTogglePin}>
              {locked ? 'Unpin' : 'Pin this time'}
            </button>
          )}
          {item.place && !isCalendarBlock(item.blockId) && (
            <button type="button" className="ghost" aria-pressed={props.savedSpot} onClick={props.onToggleSpot}>
              {props.savedSpot ? 'Saved to My spots' : 'Save to My spots'}
            </button>
          )}
          {!isCalendarBlock(item.blockId) && (
            <a className="ghost" href={addToCalendarUrl(item)} target="_blank" rel="noreferrer">
              Add to Google Calendar
            </a>
          )}
          {props.onEdit && (
            <button type="button" className="ghost" onClick={props.onEdit}>
              Edit
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
