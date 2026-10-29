import type { PlanItem } from '@segue/engine';
import type { AllDayEvent, CalendarDiff, CalendarEvent } from '../lib/calendar';
import { isCalendarBlock } from '../lib/calendar';
import { clock } from '../lib/format';

interface Props {
  connected: boolean;
  /** today's events are loaded (not an earlier day's) */
  loadedToday: boolean;
  syncedAt?: string;
  allDay: AllDayEvent[];
  diff: CalendarDiff;
  /** today's plan, to say which flexible items a new event overlaps */
  items: PlanItem[];
  hasPlan: boolean;
  /** Google needs a tap to sign in again before it can refresh */
  needsTap: boolean;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onUpdatePlan: () => void;
}

const overlaps = (e: CalendarEvent, items: PlanItem[]) =>
  items.filter((i) => !i.fixed && !isCalendarBlock(i.blockId) && Date.parse(i.start) < Date.parse(e.end) && Date.parse(i.end) > Date.parse(e.start)).map((i) => i.title);

/**
 * Google Calendar on Today: what's loaded, what changed since the plan was
 * made, and what to tap. It never changes the plan itself; "Update my plan"
 * opens the usual proposal.
 */
export function CalendarNotice(p: Props) {
  if (!p.connected) return null;
  const refresh = (
    <button type="button" className="ghost" onClick={p.onRefresh} disabled={p.busy}>
      {p.busy ? 'Refreshing…' : p.loadedToday ? 'Refresh' : 'Refresh calendar'}
    </button>
  );

  if (!p.loadedToday) {
    return (
      <div className="nudge nudge-calendar" role="status">
        <div>
          <strong>Today&apos;s Google Calendar isn&apos;t loaded yet</strong>
          <p>
            {p.error ??
              (p.needsTap
                ? 'Tap Refresh calendar to bring in today’s events. Google asks you to confirm about once an hour.'
                : 'Loading today’s events…')}
          </p>
        </div>
        <div className="nudge-actions">{refresh}</div>
      </div>
    );
  }

  const { missing, changed, gone } = p.diff;
  const pending = p.hasPlan && missing.length + changed.length + gone.length > 0;
  const synced = p.syncedAt ? `synced ${clock(p.syncedAt)}` : 'synced';

  return (
    <>
      {pending && (
        <div className="nudge nudge-calendar" role="status">
          <div>
            <strong>Your calendar changed since this plan was made</strong>
            <ul className="calendar-changes">
              {missing.map((e) => {
                const hit = overlaps(e, p.items);
                return (
                  <li key={`m-${e.id}`}>
                    New: {clock(e.start)}–{clock(e.end)} {e.title}
                    {hit.length ? ` (overlaps ${hit.join(', ')})` : ''}
                  </li>
                );
              })}
              {changed.map((e) => (
                <li key={`c-${e.id}`}>
                  Moved: {e.title}, now {clock(e.start)}–{clock(e.end)}
                </li>
              ))}
              {gone.map((g) => (
                <li key={`g-${g.blockId}`}>No longer in your calendar: {g.title}</li>
              ))}
            </ul>
            <p className="muted small">Nothing changes until you look at the new plan and tap Use this plan.</p>
          </div>
          <div className="nudge-actions">
            <button type="button" className="ghost" onClick={p.onUpdatePlan}>
              Update my plan
            </button>
          </div>
        </div>
      )}
      <p className="calendar-line muted small" role="status">
        {p.allDay.length > 0 && (
          <>
            <span>All day: {p.allDay.map((a) => a.title).join(', ')}</span>
            <span aria-hidden="true"> · </span>
          </>
        )}
        <span>
          Google Calendar {synced}
          {p.error ? `. ${p.error}` : ''}
        </span>{' '}
        {(p.needsTap || p.error) && refresh}
      </p>
    </>
  );
}
