import { useRef, useState, type ReactNode } from 'react';
import type { PlanItem, TravelMode } from '@segue/engine';
import { calendarBlockId, isCalendarBlock, type CalendarEvent } from '../lib/calendar';
import { clock, clockParts, directionsUrl, duration, minutesBetween, travelLine } from '../lib/format';
import type { DayState } from '../lib/model';
import type { Nudge } from '../lib/nudges';
import { ConflictNote } from './ConflictNote';

interface Props {
  day: DayState;
  now: Date;
  mode: TravelMode;
  calendarEvents: CalendarEvent[];
  nudges: Nudge[];
  /** weather precautions, e.g. "Bring an umbrella" */
  weather?: ReactNode;
  /** Google Calendar status and changes not yet in the plan */
  calendar?: ReactNode;
  /** the quick-add bar */
  adder: ReactNode;
  onOpen: (item: PlanItem) => void;
  onDone: (id: string) => void;
  onSkip: (id: string) => void;
  /** bring a done or skipped item back */
  onReopen: (id: string) => void;
  onReplan: () => void;
  /** other options for one item, e.g. from the rain nudge */
  onOptions: (item: PlanItem, trigger: 'rain') => void;
  onFillGap: (from: string) => void;
  onDismissNudge: (id: string) => void;
}

/** Free time worth offering to fill. */
const GAP_MIN = 20;

function placeLabel(item: PlanItem, events: Map<string, CalendarEvent>, otherwise: string): string {
  if (item.place) return item.place.name;
  if (isCalendarBlock(item.blockId)) return events.get(item.blockId)?.location ?? 'From Google Calendar';
  return item.explanation ?? otherwise;
}

/** One line for the plan's state; details one tap away. */
function StatusLine({ day }: { day: DayState }) {
  const [open, setOpen] = useState(false);
  if (!day.generatedAt && !day.warnings.length) return null;
  const offline = day.source === 'device';
  const first = day.warnings[0];
  const label = first
    ? first.split(/[.:]/)[0]
    : `Planned at ${clock(day.generatedAt!)}${offline ? ' on your phone' : ''}`;
  return (
    <div className={`status-line${first ? ' warn' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!first}>
        <span className="status-dot" aria-hidden="true" />
        <span className="status-text">{label}</span>
        {day.warnings.length > 1 && <span className="status-more">+{day.warnings.length - 1}</span>}
      </button>
      {open && (
        <ul className="status-details">
          {day.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NudgeBanner({ nudge, onReplan, onOptions, onDismiss }: { nudge: Nudge; onReplan: () => void; onOptions: () => void; onDismiss: () => void }) {
  const directions = nudge.item ? directionsUrl(nudge.item) : null;
  return (
    <div className={`nudge nudge-${nudge.kind}`} role="status">
      <div>
        <strong>{nudge.title}</strong>
        <p>{nudge.body}</p>
      </div>
      <div className="nudge-actions">
        {nudge.action === 'directions' && directions ? (
          <a className="ghost" href={directions} target="_blank" rel="noreferrer">
            Directions
          </a>
        ) : nudge.action === 'replan' ? (
          <button type="button" className="ghost" onClick={onReplan}>
            Re-route
          </button>
        ) : nudge.action === 'options' && nudge.item ? (
          <button type="button" className="ghost" onClick={onOptions}>
            See options
          </button>
        ) : null}
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const Check = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * A row you can swipe right for done, left to skip, with a ✓ button beside it
 * for one-tap done. Tapping the row opens it. Calendar events (their status is
 * Google Calendar's) have neither.
 */
function SwipeRow({ onDone, onSkip, onOpen, children, label, title, markable }: { onDone: () => void; onSkip: () => void; onOpen: () => void; children: ReactNode; label: string; title: string; markable: boolean }) {
  const [dx, setDx] = useState(0);
  const [doing, setDoing] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const THRESHOLD = 90;

  return (
    <div className={`swipe${markable ? ' with-quick' : ''}`}>
      {markable && (
        <div className="swipe-bg" aria-hidden="true">
          <span className={dx > 20 ? 'on done' : 'done'}>Done</span>
          <span className={dx < -20 ? 'on skip' : 'skip'}>Skip</span>
        </div>
      )}
      <button
        type="button"
        className="tl-card"
        aria-label={label}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: start.current ? 'none' : undefined }}
        onPointerDown={(e) => {
          if (!markable) return;
          start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          moved.current = false;
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s || s.id !== e.pointerId) return;
          const x = e.clientX - s.x;
          if (!moved.current && Math.abs(x) > 8 && Math.abs(x) > Math.abs(e.clientY - s.y)) {
            moved.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }
          if (moved.current) setDx(Math.max(-140, Math.min(140, x)));
        }}
        onPointerUp={() => {
          const was = dx;
          start.current = null;
          setDx(0);
          if (was > THRESHOLD) onDone();
          else if (was < -THRESHOLD) onSkip();
        }}
        onPointerCancel={() => {
          start.current = null;
          setDx(0);
        }}
        onClick={() => {
          if (!moved.current) onOpen();
        }}
      >
        {children}
      </button>
      {markable && (
        <button
          type="button"
          className={`quick-done${doing ? ' doing' : ''}`}
          aria-label={`Mark ${title} as done`}
          disabled={doing}
          onClick={() => {
            // One tap: a short tick, then it's done. Further taps do nothing.
            setDoing(true);
            setTimeout(onDone, 180);
          }}
        >
          <Check />
        </button>
      )}
    </div>
  );
}

export function Timeline(props: Props) {
  const { day, now, mode } = props;
  const events = new Map(props.calendarEvents.map((e) => [calendarBlockId(e.id), e]));
  const finished = new Set([...day.doneIds, ...day.skippedIds]);
  const items = (day.plan?.items ?? []).filter((i) => !finished.has(i.blockId));
  const upcoming = items.filter((i) => Date.parse(i.end) > now.getTime());
  const [next, ...rest] = upcoming;
  const locked = new Set(day.lockedIds);
  const nowLive = next && Date.parse(next.start) <= now.getTime();

  const tags = (item: PlanItem) => (
    <>
      {isCalendarBlock(item.blockId) ? <span className="tag">Calendar</span> : item.fixed && <span className="tag">Set time</span>}
      {locked.has(item.blockId) && <span className="tag">Pinned</span>}
    </>
  );

  return (
    <>
      <StatusLine day={day} />
      {props.nudges.map((n) => (
        <NudgeBanner key={n.id} nudge={n} onReplan={props.onReplan} onOptions={() => n.item && props.onOptions(n.item, 'rain')} onDismiss={() => props.onDismissNudge(n.id)} />
      ))}
      {props.calendar}
      {props.weather}
      {props.adder}

      {!day.plan ? (
        <section className="empty">
          <p className="lede">Your day is open.</p>
          <p className="muted">Add something you&apos;d like to accomplish above, like &ldquo;Gym 1h after 5pm&rdquo;. Segue finds the time and the place.</p>
        </section>
      ) : !next ? (
        <section className="empty">
          <p className="lede">You're clear for the rest of today.</p>
          <p className="muted">Add something above if a new plan comes up.</p>
        </section>
      ) : (
        <section className="next" aria-labelledby="next-title">
          <p className="next-when">
            {nowLive ? (
              <span className="live">Now · until {clock(next.end)}</span>
            ) : (
              <>
                <span className="next-time">{clockParts(next.start).time}</span>
                <span className="next-period">{clockParts(next.start).period}</span>
                <span className="next-in">in {duration(Math.max(1, minutesBetween(now.toISOString(), next.start)))}</span>
              </>
            )}
          </p>
          <h2 id="next-title" className="next-title">
            {next.title}
          </h2>
          <p className="next-place">
            {placeLabel(next, events, 'Wherever you are')}
            {next.place && travelLine(next, mode) && <span className="muted"> · {travelLine(next, mode)}</span>}
          </p>
          <ConflictNote item={next} className="next-conflict" />
          <p className="next-meta">
            <span>{duration(minutesBetween(next.start, next.end))}</span>
            {next.confidence === 'verified' && <span className="conf conf-ok">Open then</span>}
            {next.confidence === 'unconfirmed' && <span className="conf conf-unknown">Hours unconfirmed</span>}
            {tags(next)}
          </p>
          <div className="row-actions">
            {!isCalendarBlock(next.blockId) && (
              <>
                <button type="button" className="primary" aria-label={`Mark ${next.title} as done`} onClick={() => props.onDone(next.blockId)}>
                  <Check /> Done
                </button>
                <button type="button" className="ghost tall" onClick={() => props.onSkip(next.blockId)}>
                  Skip
                </button>
              </>
            )}
            {directionsUrl(next) && (
              <a className="ghost tall" href={directionsUrl(next)!} target="_blank" rel="noreferrer">
                Directions
              </a>
            )}
            <button type="button" className="ghost tall" onClick={() => props.onOpen(next)}>
              Details
            </button>
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <section aria-label="Later today">
          <h3 className="section-title">Later today</h3>
          <ol className="timeline">
            {rest.map((item, i) => {
              const prev = i === 0 ? next! : rest[i - 1]!;
              const freeFrom = Date.parse(prev.end);
              const freeMin = Math.round((Date.parse(item.start) - item.travelMinutesBefore * 60_000 - freeFrom) / 60_000);
              const travel = travelLine(item, mode);
              return (
                <li key={item.blockId}>
                  {freeMin >= GAP_MIN && (
                    <div className="tl-gap">
                      <span>{duration(freeMin)} free</span>
                      <button type="button" className="text-button" onClick={() => props.onFillGap(clock(prev.end))}>
                        Add something
                      </button>
                    </div>
                  )}
                  {travel && <div className="tl-leg">{travel}</div>}
                  <SwipeRow
                    title={item.title}
                    markable={!isCalendarBlock(item.blockId)}
                    label={`${clock(item.start)}, ${item.title}.${item.conflict ? ` Heads up: ${item.conflict}.` : ''} Tap for details.`}
                    onDone={() => props.onDone(item.blockId)}
                    onSkip={() => props.onSkip(item.blockId)}
                    onOpen={() => props.onOpen(item)}
                  >
                    <span className="tl-time">{clock(item.start)}</span>
                    <span className="tl-body">
                      <span className="tl-title">
                        {item.title}
                        {tags(item)}
                      </span>
                      <span className="tl-sub">{placeLabel(item, events, 'Anywhere')}</span>
                      <ConflictNote item={item} />
                    </span>
                    <span className="tl-dur">{duration(minutesBetween(item.start, item.end))}</span>
                  </SwipeRow>
                </li>
              );
            })}
          </ol>
          <p className="muted small swipe-hint">Tap ✓ for done. Swipe left to skip; the rest of your day stays put.</p>
        </section>
      )}

      {day.plan && day.plan.unscheduled.filter((u) => !finished.has(u.blockId)).length > 0 && (
        <section aria-label="Didn't fit today">
          <h3 className="section-title">Didn't fit today</h3>
          <ul className="unfit">
            {day.plan.unscheduled
              .filter((u) => !finished.has(u.blockId))
              .map((u) => (
                <li key={u.blockId}>
                  <strong>{u.title}</strong>
                  <span className="muted">{u.reason}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {(day.doneIds.length > 0 || day.skippedIds.length > 0) && (
        <details className="finished">
          <summary className="muted small tally">
            {day.doneIds.length} done{day.skippedIds.length ? `, ${day.skippedIds.length} skipped` : ''} today
          </summary>
          <ul>
            {[...day.doneIds.map((id) => [id, 'Done'] as const), ...day.skippedIds.map((id) => [id, 'Skipped'] as const)].map(([id, what]) => {
              const title = day.plan?.items.find((i) => i.blockId === id)?.title ?? day.plan?.unscheduled.find((u) => u.blockId === id)?.title ?? 'Removed item';
              return (
                <li key={id}>
                  <span className={`finished-mark ${what === 'Done' ? 'is-done' : 'is-skipped'}`}>{what === 'Done' ? <Check /> : '–'}</span>
                  <span className="finished-title">
                    {title} <span className="muted small">· {what}</span>
                  </span>
                  <button type="button" className="text-button" onClick={() => props.onReopen(id)}>
                    Bring back
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </>
  );
}
