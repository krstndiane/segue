import { useEffect, useState, type ReactNode } from 'react';
import type { CalendarEvent } from '../lib/calendar';
import {
  WEEKDAYS_SHORT,
  addDays,
  addMonths,
  dayLabel,
  inMonth,
  monthGrid,
  monthLabel,
  monthOf,
  oneOffsOn,
  parseKey,
  relativeDay,
  weekOf,
  type ArchivedItem,
  type DayArchive,
} from '../lib/days';
import { clock, duration, minutesBetween } from '../lib/format';
import { CATEGORY_LABEL, plannedToday, todayAt, type DayState, type StoredBlock } from '../lib/model';

/** What a day holds, for the dots under its number. */
export interface DayMarks {
  events: number;
  plans: number;
}

/** Counts for a day: Google events, and Segue's own things (planned ahead, today's plan, or a past day's plan). */
export function marksFor(
  key: string,
  ctx: { today: string; day: DayState; blocks: StoredBlock[]; archive: DayArchive; events: Record<string, CalendarEvent[]>; todayEvents: CalendarEvent[] },
): DayMarks {
  const events = key === ctx.today ? ctx.todayEvents.length : (ctx.events[key]?.length ?? 0);
  let plans = oneOffsOn(ctx.blocks, key).filter((b) => b.active).length;
  if (key === ctx.today && ctx.day.plan) plans = ctx.day.plan.items.length;
  else if (key < ctx.today) plans = ctx.archive[key]?.items.length ?? 0;
  return { events, plans };
}

function Dots({ marks }: { marks: DayMarks }) {
  return (
    <span className="cal-dots" aria-hidden="true">
      {marks.events > 0 && <i className="dot-event" />}
      {marks.plans > 0 && <i className="dot-plan" />}
    </span>
  );
}

function marksText(m: DayMarks): string {
  const parts = [];
  if (m.events) parts.push(m.events === 1 ? '1 event' : `${m.events} events`);
  if (m.plans) parts.push(m.plans === 1 ? '1 plan' : `${m.plans} plans`);
  return parts.length ? `: ${parts.join(', ')}` : '';
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface StripProps {
  /** any day in the week to show */
  anchor: string;
  today: string;
  selected: string;
  onSelect: (key: string) => void;
  marks: (key: string) => DayMarks;
  onPrev: () => void;
  onNext: () => void;
  /** e.g. a "Month" button */
  extra?: ReactNode;
}

/** Seven days in a row. Used on the Calendar screen and at the top of Plan. */
export function WeekStrip({ anchor, today, selected, onSelect, marks, onPrev, onNext, extra }: StripProps) {
  const days = weekOf(anchor);
  const first = days[0]!;
  const last = days[6]!;
  const range =
    first.slice(0, 7) === last.slice(0, 7)
      ? `${dayLabel(first, { month: 'long', day: 'numeric' })} – ${dayLabel(last, { day: 'numeric' })}`
      : `${dayLabel(first, { month: 'short', day: 'numeric' })} – ${dayLabel(last, { month: 'short', day: 'numeric' })}`;
  return (
    <div className="week-strip">
      <div className="cal-bar">
        <button type="button" className="cal-arrow" aria-label="Previous week" onClick={onPrev}>
          <Chevron dir="left" />
        </button>
        <span className="cal-title">{range}</span>
        <button type="button" className="cal-arrow" aria-label="Next week" onClick={onNext}>
          <Chevron dir="right" />
        </button>
        {extra}
      </div>
      <div className="week-days" role="group" aria-label="Days of the week">
        {days.map((k) => {
          const m = marks(k);
          const d = parseKey(k);
          return (
            <button
              key={k}
              type="button"
              className={`week-day${k === today ? ' is-today' : ''}${k < today ? ' is-past' : ''}`}
              aria-pressed={k === selected}
              aria-label={`${dayLabel(k)}${k === today ? ', today' : ''}${marksText(m)}`}
              onClick={() => onSelect(k)}
            >
              <span className="wd-name" aria-hidden="true">
                {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d)}
              </span>
              <span className="wd-num" aria-hidden="true">
                {d.getDate()}
              </span>
              <Dots marks={m} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface GridProps {
  month: string;
  today: string;
  selected: string;
  onSelect: (key: string) => void;
  marks: (key: string) => DayMarks;
  onPrev: () => void;
  onNext: () => void;
  extra?: ReactNode;
}

export function MonthGrid({ month, today, selected, onSelect, marks, onPrev, onNext, extra }: GridProps) {
  const cells = monthGrid(month);
  return (
    <div className="month-grid">
      <div className="cal-bar">
        <button type="button" className="cal-arrow" aria-label="Previous month" onClick={onPrev}>
          <Chevron dir="left" />
        </button>
        <span className="cal-title">{monthLabel(month)}</span>
        <button type="button" className="cal-arrow" aria-label="Next month" onClick={onNext}>
          <Chevron dir="right" />
        </button>
        {extra}
      </div>
      <div className="month-head" aria-hidden="true">
        {WEEKDAYS_SHORT.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="month-cells" role="group" aria-label={monthLabel(month)}>
        {cells.map((k) => {
          const m = marks(k);
          return (
            <button
              key={k}
              type="button"
              className={`month-day${inMonth(k, month) ? '' : ' is-outside'}${k === today ? ' is-today' : ''}${k < today ? ' is-past' : ''}`}
              aria-pressed={k === selected}
              aria-label={`${dayLabel(k)}${k === today ? ', today' : ''}${marksText(m)}`}
              onClick={() => onSelect(k)}
            >
              <span className="md-num" aria-hidden="true">
                {parseKey(k).getDate()}
              </span>
              <Dots marks={m} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<ArchivedItem['status'], string> = { done: 'Done', skipped: 'Skipped', planned: 'Planned' };

function EventList({ events }: { events: CalendarEvent[] }) {
  return (
    <ul className="pick-list">
      {events.map((e) => (
        <li key={`${e.id}|${e.start}`}>
          <span className="pick-time">{clock(e.start)}</span>
          <span className="pick-body">
            <strong>{e.title}</strong>
            <span className="muted small">
              {duration(minutesBetween(e.start, e.end))}
              {e.location && ` · ${e.location}`}
            </span>
          </span>
          <span className="tag-cal">Calendar</span>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  now: Date;
  today: string;
  selected: string;
  onSelect: (key: string) => void;
  day: DayState;
  blocks: StoredBlock[];
  archive: DayArchive;
  /** saved events by day */
  events: Record<string, CalendarEvent[]>;
  /** today's events, kept fresh by sync and re-route */
  todayEvents: CalendarEvent[];
  connected: boolean;
  syncedAt?: string;
  loading: boolean;
  error: string | null;
  /** fetch events for [from, to); `interactive` when it comes from a tap */
  onLoad: (from: string, toExclusive: string, interactive: boolean) => void;
  onConnect: () => void;
  /** quick-add bar that adds things for the selected day */
  adder: ReactNode;
  onRemoveBlock: (id: string) => void;
  onEditBlock: (id: string) => void;
  onOpenToday: () => void;
  onPlanToday: () => void;
}

export function DaysPage(props: Props) {
  const { today, selected, onSelect, day, blocks, archive, connected } = props;
  const [view, setView] = useState<'month' | 'week'>('month');
  const [month, setMonth] = useState(() => monthOf(selected));
  const [anchor, setAnchor] = useState(selected);

  // Picking a day elsewhere (like the week strip on Plan) brings its month and week into view.
  useEffect(() => {
    setMonth(monthOf(selected));
    setAnchor(selected);
  }, [selected]);

  const shown = view === 'month' ? monthGrid(month) : weekOf(anchor);
  const from = shown[0]!;
  const to = addDays(shown[shown.length - 1]!, 1);
  // Bring in Google events for what's on screen (quietly; only when signed in this session).
  useEffect(() => {
    props.onLoad(from, to, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, connected]);

  const marks = (k: string) => marksFor(k, { today, day, blocks, archive, events: props.events, todayEvents: props.todayEvents });
  const toggle = (
    <span className="view-toggle" role="group" aria-label="Calendar view">
      <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>
        Week
      </button>
      <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>
        Month
      </button>
    </span>
  );

  const rel = relativeDay(selected, today);
  const isPast = selected < today;
  const isToday = selected === today;
  const events = isToday ? props.todayEvents : props.events[selected];
  const loadedHere = isToday || selected in props.events;
  const ahead = oneOffsOn(blocks, selected);
  const routineCount = blocks.filter((b) => !b.date && plannedToday(b, selected)).length;
  const past = archive[selected];
  const finished = new Set([...day.doneIds, ...day.skippedIds]);

  return (
    <div className="page days-page">
      <header className="page-head plain">
        <div>
          <h2 className="page-title">Calendar</h2>
          <p className="muted">Tap a day to see its events and plans.</p>
        </div>
      </header>

      <section className="panel cal-panel" aria-label="Calendar">
        {view === 'month' ? (
          <MonthGrid
            month={month}
            today={today}
            selected={selected}
            onSelect={onSelect}
            marks={marks}
            onPrev={() => setMonth((m) => addMonths(m, -1))}
            onNext={() => setMonth((m) => addMonths(m, 1))}
            extra={toggle}
          />
        ) : (
          <WeekStrip
            anchor={anchor}
            today={today}
            selected={selected}
            onSelect={onSelect}
            marks={marks}
            onPrev={() => setAnchor((a) => addDays(a, -7))}
            onNext={() => setAnchor((a) => addDays(a, 7))}
            extra={toggle}
          />
        )}
        <div className="cal-foot">
          <span className="cal-legend">
            <span>
              <i className="dot-event" /> Google Calendar
            </span>
            <span>
              <i className="dot-plan" /> Your plans
            </span>
          </span>
          {connected ? (
            <button type="button" className="text-button" disabled={props.loading} onClick={() => props.onLoad(from, to, true)}>
              {props.loading ? 'Syncing…' : 'Sync'}
            </button>
          ) : (
            <button type="button" className="text-button" onClick={props.onConnect}>
              Connect Google Calendar
            </button>
          )}
        </div>
        {props.error && <p className="small warn-text">{props.error}</p>}
        {selected !== today && (
          <button type="button" className="text-button cal-jump" onClick={() => onSelect(today)}>
            Back to today
          </button>
        )}
      </section>

      <section className="panel day-detail" aria-labelledby="day-title">
        <div className="panel-row">
          <h3 id="day-title" className="panel-title">
            {dayLabel(selected)}
          </h3>
          {rel && <span className="rel-chip">{rel}</span>}
        </div>

        <h4 className="sub-title">From Google Calendar</h4>
        {!connected ? (
          <p className="muted small">Connect your calendar or add your first commitment. Segue only reads your Google Calendar, never changes it.</p>
        ) : !loadedHere ? (
          <p className="muted small">
            Not loaded yet.{' '}
            <button type="button" className="text-button" onClick={() => props.onLoad(from, to, true)}>
              Load events
            </button>
          </p>
        ) : !events?.length ? (
          <p className="muted small">No events this day.</p>
        ) : (
          <EventList events={events} />
        )}

        {isToday && (
          <>
            <h4 className="sub-title">Today&apos;s plan</h4>
            {day.plan?.items.length ? (
              <ul className="pick-list">
                {day.plan.items.map((i) => (
                  <li key={i.blockId} className={finished.has(i.blockId) ? 'off' : ''}>
                    <span className="pick-time">{clock(i.start)}</span>
                    <span className="pick-body">
                      <strong>{i.title}</strong>
                      <span className="muted small">{i.place?.name ?? duration(minutesBetween(i.start, i.end))}</span>
                    </span>
                    <span className="muted small">{day.doneIds.includes(i.blockId) ? 'Done' : day.skippedIds.includes(i.blockId) ? 'Skipped' : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Not planned yet.</p>
            )}
            <div className="day-actions">
              <button type="button" className="ghost" onClick={props.onOpenToday}>
                Open today
              </button>
              <button type="button" className="ghost" onClick={props.onPlanToday}>
                {day.plan ? 'Re-plan my day' : 'Plan my day'}
              </button>
            </div>
          </>
        )}

        {isPast && (
          <>
            <h4 className="sub-title">What you planned</h4>
            {past?.items.length ? (
              <ul className="pick-list">
                {past.items.map((i) => (
                  <li key={i.blockId} className={i.status === 'skipped' ? 'off' : ''}>
                    <span className="pick-time">{clock(i.start)}</span>
                    <span className="pick-body">
                      <strong>{i.title}</strong>
                      <span className="muted small">{i.place ?? duration(minutesBetween(i.start, i.end))}</span>
                    </span>
                    <span className={`status-chip is-${i.status}`}>{STATUS_LABEL[i.status]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No plan saved for this day. Segue keeps your plans on this phone from now on.</p>
            )}
          </>
        )}

        {!isPast && !isToday && (
          <>
            <h4 className="sub-title">Planned ahead</h4>
            {ahead.length === 0 ? (
              <p className="muted small">Nothing yet. Add something below and Segue fits it into the day when it comes.</p>
            ) : (
              <ul className="pick-list">
                {ahead.map((b) => (
                  <li key={b.id}>
                    <span className="pick-time">{b.fixedStart ? clock(todayAt(b.fixedStart, parseKey(selected))) : duration(b.maxMinutes)}</span>
                    <button type="button" className="pick-body as-button" onClick={() => props.onEditBlock(b.id)}>
                      <strong>{b.title}</strong>
                      <span className="muted small">{b.fixedStart && b.fixedEnd ? `Until ${clock(todayAt(b.fixedEnd, parseKey(selected)))}` : CATEGORY_LABEL[b.category]}</span>
                    </button>
                    <button type="button" className="text-button" onClick={() => props.onRemoveBlock(b.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {props.adder}
            {routineCount > 0 && (
              <p className="muted small">
                Plus your {routineCount === 1 ? 'routine' : `${routineCount} routines`}. On the day, Segue plans everything around your events.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
