import { useRef, useState } from 'react';
import type { PlanItem } from '@segue/engine';
import { isCalendarBlock } from '../lib/calendar';
import { clock, duration, minutesBetween } from '../lib/format';

/** Height of one hour, in px. Tall enough to tap the top or bottom half. */
export const HOUR_PX = 72;
const SNAP_MIN = 15;

interface Props {
  items: PlanItem[];
  now: Date;
  /** ISO: the grid runs at least until here */
  endOfDay: string;
  /** items that can't be dragged (fixed, calendar) are decided by the item itself */
  lockedIds: Set<string>;
  /** before there's a plan, the items are just the fixed points of the day */
  preview: boolean;
  onOpen: (item: PlanItem) => void;
  onMove: (id: string, hhmm: string) => void;
  onAddAt: (hhmm: string) => void;
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const hourLabel = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours();
  return h === 12 ? 'Noon' : `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`;
};

function GripIcon() {
  return (
    <svg viewBox="0 0 12 20" width="10" height="16" aria-hidden="true">
      {[3, 9].map((x) => [4, 10, 16].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" fill="currentColor" />))}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

/**
 * The day, hour by hour. Tap an empty spot to add something then; tap an item
 * for its details; drag an item by its handle to move it (it snaps to 15
 * minutes and stays pinned). Meetings and set-time items don't move.
 */
export function HourPlanner({ items, now, endOfDay, lockedIds, preview, onOpen, onMove, onAddAt }: Props) {
  const nowMs = now.getTime();
  const firstMs = Math.min(nowMs, ...items.map((i) => Date.parse(i.start)));
  const first = new Date(firstMs);
  first.setMinutes(0, 0, 0);
  const lastMs = Math.max(Date.parse(endOfDay), ...items.map((i) => Date.parse(i.end)));
  const hours = Math.max(2, Math.ceil((lastMs - first.getTime()) / 3_600_000));
  const top = (ms: number) => ((ms - first.getTime()) / 3_600_000) * HOUR_PX;

  const [drag, setDrag] = useState<{ id: string; dy: number } | null>(null);
  const start = useRef<{ id: string; y: number; pointer: number } | null>(null);

  /** Where a dragged item would land: snapped, and never before now. */
  const landing = (item: PlanItem, dy: number) => {
    const raw = Date.parse(item.start) + (dy / HOUR_PX) * 3_600_000;
    const snapped = Math.round(raw / (SNAP_MIN * 60_000)) * SNAP_MIN * 60_000;
    const earliest = Math.ceil(nowMs / (SNAP_MIN * 60_000)) * SNAP_MIN * 60_000;
    return Math.max(snapped, earliest);
  };

  return (
    <div className="hours" style={{ height: hours * HOUR_PX }}>
      {Array.from({ length: hours }, (_, h) => {
        const ms = first.getTime() + h * 3_600_000;
        const past = ms + 3_600_000 <= nowMs;
        return (
          <div key={h} className={`hour-row${past ? ' past' : ''}`} style={{ top: h * HOUR_PX, height: HOUR_PX }}>
            <span className="hour-label">{hourLabel(ms)}</span>
            {!past && (
              <button
                type="button"
                className="hour-slot"
                aria-label={`Add something at ${clock(new Date(ms).toISOString())}`}
                onClick={(e) => {
                  // Top half of the hour starts on the hour, bottom half at half past.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const half = e.clientY - rect.top > rect.height / 2 && e.detail > 0;
                  const at = Math.max(ms + (half ? 30 : 0) * 60_000, Math.ceil(nowMs / (SNAP_MIN * 60_000)) * SNAP_MIN * 60_000);
                  onAddAt(hhmm(at));
                }}
              >
                <span className="hour-plus" aria-hidden="true">
                  +
                </span>
              </button>
            )}
          </div>
        );
      })}

      {items.map((item, idx) => {
        // Two commitments at the same time sit side by side instead of on top of each other.
        const clashLeft = !!item.conflict && items.slice(idx + 1).some((o) => o.conflict && Date.parse(o.start) < Date.parse(item.end));
        const clashRight = !!item.conflict && items.slice(0, idx).some((o) => o.conflict && Date.parse(item.start) < Date.parse(o.end));
        const y = top(Date.parse(item.start));
        const height = Math.max(30, top(Date.parse(item.end)) - y - 3);
        const travel = (item.travelMinutesBefore / 60) * HOUR_PX;
        const calendar = isCalendarBlock(item.blockId);
        const movable = !preview && !item.fixed && !calendar;
        const dragging = drag?.id === item.blockId;
        const target = dragging ? landing(item, drag.dy) : 0;
        const past = Date.parse(item.end) <= nowMs;
        return (
          <div key={item.blockId}>
            {travel >= 8 && !dragging && <div className="hour-travel" style={{ top: y - travel, height: travel }} title={`${item.travelMinutesBefore} min travel`} />}
            <div
              className={`hour-item${calendar ? ' cal' : item.fixed ? ' fixed' : ''}${dragging ? ' dragging' : ''}${past ? ' past' : ''}${preview ? ' preview' : ''}${height < 46 ? ' short' : ''}${clashRight ? ' clash-right' : clashLeft ? ' clash-left' : ''}`}
              style={{ top: y, height, transform: dragging ? `translateY(${drag.dy}px)` : undefined }}
            >
              <button type="button" className="hour-item-body" onClick={() => !preview && onOpen(item)} disabled={preview}>
                <strong>
                  {item.conflict && (
                    <span className="clash-mark" title={item.conflict}>
                      <span aria-hidden="true">⚠</span>
                      <span className="visually-hidden">Heads up: {item.conflict}. </span>
                    </span>
                  )}
                  {item.title}
                  {lockedIds.has(item.blockId) && <span className="tag">Pinned</span>}
                </strong>
                <span>
                  {dragging ? `Move to ${clock(new Date(target).toISOString())}` : `${clock(item.start)}–${clock(item.end)}`}
                  {height >= 52 && !dragging && ` · ${item.place?.name ?? duration(minutesBetween(item.start, item.end))}`}
                </span>
              </button>
              {movable ? (
                <span
                  className="hour-grip"
                  role="button"
                  tabIndex={-1}
                  aria-label={`Drag to move ${item.title}`}
                  onPointerDown={(e) => {
                    start.current = { id: item.blockId, y: e.clientY, pointer: e.pointerId };
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ id: item.blockId, dy: 0 });
                  }}
                  onPointerMove={(e) => {
                    if (start.current?.pointer !== e.pointerId) return;
                    setDrag({ id: item.blockId, dy: e.clientY - start.current.y });
                  }}
                  onPointerUp={() => {
                    const d = drag;
                    start.current = null;
                    setDrag(null);
                    if (!d || Math.abs(d.dy) < 6) return;
                    const to = landing(item, d.dy);
                    if (to !== Date.parse(item.start)) onMove(item.blockId, hhmm(to));
                  }}
                  onPointerCancel={() => {
                    start.current = null;
                    setDrag(null);
                  }}
                >
                  <GripIcon />
                </span>
              ) : (
                <span className="hour-lock" title={calendar ? 'From your calendar' : 'Set time'}>
                  <LockIcon />
                </span>
              )}
            </div>
          </div>
        );
      })}

      {nowMs >= first.getTime() && nowMs <= first.getTime() + hours * 3_600_000 && (
        <div className="hour-now" style={{ top: top(nowMs) }}>
          <span>{clock(now.toISOString())}</span>
        </div>
      )}
    </div>
  );
}
