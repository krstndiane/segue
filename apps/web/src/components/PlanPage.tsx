import type { ReactNode } from 'react';
import type { Energy, PlanItem, TravelMode } from '@segue/engine';
import { calendarBlockId, type CalendarEvent } from '../lib/calendar';
import { clock, duration, longDate, minutesBetween } from '../lib/format';
import {
  CATEGORY_LABEL,
  ENERGY_LABEL,
  MODE_LABEL,
  PRIORITY_LABEL,
  repeatsOn,
  todayAt,
  type DayState,
  type Settings,
  type StoredBlock,
} from '../lib/model';
import { HourPlanner } from './HourPlanner';
import { PrecautionStrip } from './Precautions';
import type { Precaution } from '../lib/precautions';
import { Segmented } from './Sheet';

interface Props {
  now: Date;
  today: string;
  day: DayState;
  blocks: StoredBlock[];
  settings: Settings;
  onSettings: (patch: Partial<Settings>) => void;
  calendarConnected: boolean;
  calendarEvents: CalendarEvent[];
  excluded: Set<string>;
  onToggleExclude: (id: string) => void;
  /** the quick-add bar */
  adder: ReactNode;
  onRemoveBlock: (id: string) => void;
  onEditBlock: (id: string) => void;
  onOpenCalendar: () => void;
  onOpenItem: (item: PlanItem) => void;
  onMoveItem: (id: string, hhmm: string) => void;
  onAddAt: (hhmm: string) => void;
  onPlan: () => void;
  busy: boolean;
  precautions: Precaution[];
  /** the week strip: tap another day to see it on the calendar */
  week?: ReactNode;
}

/** Before there's a plan, the grid shows the day's fixed points: calendar events and set times. */
function fixedPoints(events: CalendarEvent[], blocks: StoredBlock[], now: Date): PlanItem[] {
  const base = { travelMinutesBefore: 0, confidence: 'no-place' as const, fixed: true, fallbacks: [] };
  return [
    ...events.map((e) => ({ ...base, blockId: calendarBlockId(e.id), title: e.title, start: e.start, end: e.end })),
    ...blocks
      .filter((b) => b.fixedStart && b.fixedEnd)
      .map((b) => ({
        ...base,
        blockId: b.id,
        title: b.title,
        start: new Date(todayAt(b.fixedStart!, now)).toISOString(),
        end: new Date(todayAt(b.fixedEnd!, now)).toISOString(),
      })),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function PlanPage(props: Props) {
  const { now, today, day, blocks, settings, excluded } = props;
  const oneOffs = blocks.filter((b) => b.date === today);
  // Routines that repeat today (a weekdays-only routine isn't part of a Saturday).
  const routines = blocks.filter((b) => !b.date && repeatsOn(b, today));
  const inToday = [...oneOffs.filter((b) => b.active), ...routines.filter((b) => b.active && !excluded.has(b.id))];
  const events = props.calendarEvents.filter((e) => !excluded.has(calendarBlockId(e.id)));

  const endOfDay = todayAt(settings.endOfDay, now);
  const available = Math.max(0, minutesBetween(now.toISOString(), endOfDay));
  const wanted =
    inToday.reduce((s, b) => s + (b.fixedStart ? 0 : b.minMinutes), 0) +
    [...inToday.filter((b) => b.fixedStart), ...events].reduce(
      (s, x) => s + ('start' in x ? minutesBetween(x.start, x.end) : x.maxMinutes),
      0,
    );
  const count = inToday.length + events.length;
  const tooMuch = wanted > available;

  const finished = new Set([...day.doneIds, ...day.skippedIds]);
  const planned = day.plan?.items.filter((i) => !finished.has(i.blockId));
  const preview = !planned;
  const gridItems = planned ?? fixedPoints(events, inToday, now);
  const unfit = day.plan?.unscheduled.filter((u) => !finished.has(u.blockId)) ?? [];

  return (
    <div className="page plan-page">
      <header className="page-head plain">
        <div>
          <h2 className="page-title">Plan your day</h2>
          <p className="muted">{longDate(now)}</p>
        </div>
      </header>

      {props.week}

      <details className="panel day-settings">
        <summary>
          <span>
            Ends {clock(endOfDay)} · Feeling {ENERGY_LABEL[settings.energy].toLowerCase()} · {MODE_LABEL[settings.mode]}
          </span>
          <span className="text-button">Change</span>
        </summary>
        <div className="pair">
          <label className="field">
            <span>Day ends around</span>
            <input type="time" value={settings.endOfDay} onChange={(e) => e.target.value && props.onSettings({ endOfDay: e.target.value })} />
          </label>
          <label className="field">
            <span>Getting around</span>
            <select value={settings.mode} onChange={(e) => props.onSettings({ mode: e.target.value as TravelMode })}>
              {(Object.keys(MODE_LABEL) as TravelMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Segmented
          label="How are you feeling?"
          value={settings.energy}
          onChange={(energy: Energy) => props.onSettings({ energy })}
          options={(['low', 'medium', 'high'] as const).map((v) => ({ value: v, label: ENERGY_LABEL[v] }))}
        />
      </details>

      <PrecautionStrip items={props.precautions} />
      {props.adder}

      <section className="panel hours-panel" aria-labelledby="hours-title">
        <div className="panel-row">
          <h3 id="hours-title" className="panel-title">
            Hour by hour
          </h3>
          {!props.calendarConnected ? (
            <button type="button" className="text-button" onClick={props.onOpenCalendar}>
              Connect calendar
            </button>
          ) : day.plan ? (
            <span className="muted small">{day.plan.totalTravelMinutes} min travel</span>
          ) : (
            <span className="muted small">Not planned yet</span>
          )}
        </div>
        <p className="muted small hours-hint">
          {preview
            ? 'These are the fixed points of your day. Tap an hour to add something, then Plan my day fits everything around them.'
            : 'Tap an hour to add something. Tap an item for details, or drag its handle to move it.'}
        </p>
        <HourPlanner
          items={gridItems}
          now={now}
          endOfDay={endOfDay}
          lockedIds={new Set(day.lockedIds)}
          preview={preview}
          onOpen={props.onOpenItem}
          onMove={props.onMoveItem}
          onAddAt={props.onAddAt}
        />
        {unfit.length > 0 && (
          <div className="hours-unfit">
            <strong>Didn't fit</strong>
            <ul>
              {unfit.map((u) => (
                <li key={u.blockId}>
                  {u.title}
                  <span className="muted small"> · {u.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <details className="panel">
        <summary className="panel-summary">
          <span className="panel-title">What's in today</span>
          <span className="muted small">
            {count} {count === 1 ? 'thing' : 'things'}
          </span>
        </summary>

        <h4 className="sub-title">
          On your calendar
          <button type="button" className="text-button" onClick={props.onOpenCalendar}>
            {props.calendarConnected ? 'Manage' : 'Connect'}
          </button>
        </h4>
        {!props.calendarConnected ? (
          <p className="muted small">Connect Google Calendar and your meetings and classes become fixed times Segue plans around.</p>
        ) : props.calendarEvents.length === 0 ? (
          <p className="muted small">Nothing from your calendar today.</p>
        ) : (
          <ul className="pick-list">
            {props.calendarEvents.map((e) => {
              const id = calendarBlockId(e.id);
              return (
                <li key={e.id} className={excluded.has(id) ? 'off' : ''}>
                  <span className="pick-time">{clock(e.start)}</span>
                  <span className="pick-body">
                    <strong>{e.title}</strong>
                    <span className="muted small">
                      {duration(minutesBetween(e.start, e.end))}
                      {e.location && ` · ${e.location}`}
                    </span>
                  </span>
                  <label className="switch">
                    <input type="checkbox" checked={!excluded.has(id)} onChange={() => props.onToggleExclude(id)} />
                    <span className="visually-hidden">Plan around {e.title} today</span>
                    <span className="track" aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <h4 className="sub-title">Just for today</h4>
        {oneOffs.length === 0 ? (
          <p className="muted small">Nothing yet. Tap an hour above, or type in the bar.</p>
        ) : (
          <ul className="pick-list">
            {oneOffs.map((b) => (
              <li key={b.id}>
                <span className="pick-time">{b.fixedStart ? clock(todayAt(b.fixedStart, now)) : duration(b.maxMinutes)}</span>
                <button type="button" className="pick-body as-button" onClick={() => props.onEditBlock(b.id)}>
                  <strong>{b.title}</strong>
                  <span className="muted small">
                    {b.fixedStart ? `Until ${clock(todayAt(b.fixedEnd!, now))}` : CATEGORY_LABEL[b.category]}
                    {b.priority !== 'should' && ` · ${PRIORITY_LABEL[b.priority]}`}
                  </span>
                </button>
                <button type="button" className="text-button" onClick={() => props.onRemoveBlock(b.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <h4 className="sub-title">Routines</h4>
        {routines.length === 0 ? (
          <p className="muted small">{blocks.some((b) => !b.date) ? 'None of your routines repeat today.' : 'No routines yet. Add things you do regularly in Routines.'}</p>
        ) : (
          <ul className="pick-list">
            {routines.map((b) => {
              const paused = !b.active;
              const off = paused || excluded.has(b.id);
              return (
                <li key={b.id} className={off ? 'off' : ''}>
                  <span className="pick-time">{b.fixedStart ? clock(todayAt(b.fixedStart, now)) : duration(b.maxMinutes)}</span>
                  <span className="pick-body">
                    <strong>{b.title}</strong>
                    <span className="muted small">{paused ? 'Paused in Routines' : CATEGORY_LABEL[b.category]}</span>
                  </span>
                  <label className="switch">
                    <input type="checkbox" checked={!off} disabled={paused} onChange={() => props.onToggleExclude(b.id)} />
                    <span className="visually-hidden">Include {b.title} today</span>
                    <span className="track" aria-hidden="true" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </details>

      <div className="plan-bar">
        <p className={tooMuch ? 'plan-sum warn-text' : 'plan-sum'}>
          {count === 0
            ? 'Start with something you want to get done.'
            : `${count} ${count === 1 ? 'thing' : 'things'} · about ${duration(Math.max(5, wanted))} of ${duration(available)} left`}
          {tooMuch && count > 0 && <span className="block small">More than fits. Must-dos go first.</span>}
        </p>
        <button type="button" className="primary big" onClick={props.onPlan} disabled={props.busy || count === 0}>
          {props.busy ? 'Planning…' : day.plan ? 'Re-plan my day' : 'Plan my day'}
        </button>
      </div>
    </div>
  );
}
