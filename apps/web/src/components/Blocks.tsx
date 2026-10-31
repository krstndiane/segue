import { useState } from 'react';
import type { Energy, PlaceCategory, Priority, Requirement, TimePref } from '@segue/engine';
import { duration } from '../lib/format';
import { CATEGORY_LABEL, PRIORITY_LABEL, REQUIREMENT_LABEL, WEEKDAY_SHORT, localDate, newId, repeatLabel, type StoredBlock } from '../lib/model';
import { Segmented, Sheet } from './Sheet';

function BlockRow({ b, onEdit, onToggle }: { b: StoredBlock; onEdit: (id: string) => void; onToggle: (id: string) => void }) {
  return (
    <li className={b.active ? '' : 'paused'}>
      <button type="button" className="block-main" onClick={() => onEdit(b.id)}>
        <span className="stave-title">{b.title}</span>
        <span className="stave-sub">
          {!b.date && b.days?.length && b.days.length < 7 ? `${repeatLabel(b.days)} · ` : ''}
          {b.fixedStart ? `${b.fixedStart}–${b.fixedEnd}` : duration(b.maxMinutes)} · {CATEGORY_LABEL[b.category]}
          {b.priority !== 'should' && ` · ${PRIORITY_LABEL[b.priority]}`}
        </span>
      </button>
      <label className="switch">
        <input type="checkbox" checked={b.active} onChange={() => onToggle(b.id)} />
        <span className="visually-hidden">Plan {b.title}</span>
        <span className="track" aria-hidden="true" />
      </label>
    </li>
  );
}

/** Routines repeat every day; one-offs belong to today only. */
export function RoutinesView({
  blocks,
  today,
  onEdit,
  onAdd,
  onToggle,
}: {
  blocks: StoredBlock[];
  today: string;
  onEdit: (id: string) => void;
  onAdd: () => void;
  onToggle: (id: string) => void;
}) {
  const oneOffs = blocks.filter((b) => b.date === today);
  const routines = blocks.filter((b) => !b.date);
  return (
    <>
      <p className="muted intro">Routines repeat on the days you choose. Switch one off to pause it; switch it back on to resume. Segue finds the time and place each day.</p>
      {oneOffs.length > 0 && (
        <section aria-label="Today only">
          <h3 className="section-title">Today only</h3>
          <ul className="blocks">
            {oneOffs.map((b) => (
              <BlockRow key={b.id} b={b} onEdit={onEdit} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Routines">
        <h3 className="section-title">Routines</h3>
        {routines.length === 0 ? (
          <div className="empty-state">
            <p>Build a routine around something you want to do regularly.</p>
            <p className="muted small">A morning read, a workout on weekdays, a weekly call home: Segue fits it into each of those days.</p>
          </div>
        ) : (
          <ul className="blocks">
            {routines.map((b) => (
              <BlockRow key={b.id} b={b} onEdit={onEdit} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </section>
      <button type="button" className="ghost wide" onClick={onAdd}>
        Add a routine
      </button>
    </>
  );
}

const CATEGORIES = Object.keys(CATEGORY_LABEL) as PlaceCategory[];
const REQUIREMENTS = Object.keys(REQUIREMENT_LABEL) as Requirement[];

export function BlockForm({
  initial,
  isNew,
  onSave,
  onDelete,
  onClose,
}: {
  initial?: StoredBlock;
  /** a draft from quick add, not yet saved */
  isNew?: boolean;
  onSave: (b: StoredBlock) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [b, setB] = useState<StoredBlock>(
    initial ?? {
      id: newId(),
      title: '',
      minMinutes: 30,
      maxMinutes: 60,
      priority: 'should',
      category: 'none',
      requirements: [],
      active: true,
    },
  );
  const [fixed, setFixed] = useState(Boolean(initial?.fixedStart));
  const editing = !!initial && !isNew;
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<StoredBlock>) => setB((prev) => ({ ...prev, ...patch }));

  function submit() {
    if (!b.title.trim()) return setError('Give it a name.');
    if (fixed && (!b.fixedStart || !b.fixedEnd || b.fixedEnd <= b.fixedStart)) {
      return setError('A fixed block needs a start and an end time, with the end after the start.');
    }
    if (!fixed && b.maxMinutes < b.minMinutes) return setError('The longest time can’t be shorter than the shortest.');
    const out: StoredBlock = { ...b, title: b.title.trim() };
    if (!fixed) {
      delete out.fixedStart;
      delete out.fixedEnd;
      delete out.fixedPlace;
    } else {
      const mins = (Number(b.fixedEnd!.slice(0, 2)) * 60 + Number(b.fixedEnd!.slice(3))) - (Number(b.fixedStart!.slice(0, 2)) * 60 + Number(b.fixedStart!.slice(3)));
      out.minMinutes = out.maxMinutes = mins;
      out.category = 'none';
      out.requirements = [];
    }
    onSave(out);
  }

  return (
    <Sheet title={editing ? 'Edit' : b.date ? 'Add to today' : 'New routine'} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={b.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Study for the quiz" maxLength={80} />
        </label>

        <Segmented
          label="When"
          value={b.date ? 'today' : 'daily'}
          onChange={(v) => set({ date: v === 'today' ? localDate() : undefined })}
          options={[
            { value: 'today', label: 'Today only' },
            { value: 'daily', label: 'Repeats' },
          ]}
        />

        {!b.date && (
          <fieldset className="field repeat-days">
            <legend>
              On <span className="muted">· {repeatLabel(b.days)}</span>
            </legend>
            <div className="chips">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const all = b.days?.length ? b.days : [0, 1, 2, 3, 4, 5, 6];
                const on = all.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    className={`chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    // A routine repeats on at least one day.
                    disabled={on && all.length === 1}
                    onClick={() => {
                      const next = on ? all.filter((x) => x !== d) : [...all, d];
                      set({ days: next.length === 7 ? undefined : next.sort() });
                    }}
                  >
                    {WEEKDAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        <Segmented
          label="How important"
          value={b.priority}
          onChange={(priority) => set({ priority })}
          options={(['must', 'should', 'nice'] as const).map((v) => ({ value: v, label: PRIORITY_LABEL[v] }))}
        />

        <label className="check">
          <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
          <span>It happens at a set time (a class, a meeting)</span>
        </label>

        {fixed ? (
          <>
            <div className="pair">
              <label className="field">
                <span>Starts</span>
                <input type="time" value={b.fixedStart ?? ''} onChange={(e) => set({ fixedStart: e.target.value })} />
              </label>
              <label className="field">
                <span>Ends</span>
                <input type="time" value={b.fixedEnd ?? ''} onChange={(e) => set({ fixedEnd: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span>Where (optional)</span>
              <input value={b.fixedPlace ?? ''} onChange={(e) => set({ fixedPlace: e.target.value || undefined })} placeholder="e.g. Room 304" />
            </label>
          </>
        ) : (
          <details className="more" open={editing && !!(b.earliest || b.latest || b.timePref || b.energy || b.requirements.length)}>
            <summary>More options: how long, where, when</summary>
            <div className="pair">
              <label className="field">
                <span>At least (min)</span>
                <input type="number" min={5} max={720} step={5} value={b.minMinutes} onChange={(e) => set({ minMinutes: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Ideally (min)</span>
                <input type="number" min={5} max={720} step={5} value={b.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />
              </label>
            </div>

            <label className="field">
              <span>Where it happens</span>
              <select value={b.category} onChange={(e) => set({ category: e.target.value as PlaceCategory })}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>

            {b.category !== 'none' && (
              <fieldset className="field">
                <legend>The place needs</legend>
                <div className="chips">
                  {REQUIREMENTS.map((r) => {
                    const on = b.requirements.includes(r);
                    return (
                      <button
                        key={r}
                        type="button"
                        aria-pressed={on}
                        className={on ? 'chip on' : 'chip'}
                        onClick={() => set({ requirements: on ? b.requirements.filter((x) => x !== r) : [...b.requirements, r] })}
                      >
                        {REQUIREMENT_LABEL[r]}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <div className="pair">
              <label className="field">
                <span>Not before</span>
                <input type="time" value={b.earliest ?? ''} onChange={(e) => set({ earliest: e.target.value || undefined })} />
              </label>
              <label className="field">
                <span>Done by</span>
                <input type="time" value={b.latest ?? ''} onChange={(e) => set({ latest: e.target.value || undefined })} />
              </label>
            </div>

            <div className="pair">
              <label className="field">
                <span>Best time</span>
                <select value={b.timePref ?? ''} onChange={(e) => set({ timePref: (e.target.value || undefined) as TimePref | undefined })}>
                  <option value="">Any time</option>
                  <option value="morning">Morning</option>
                  <option value="afternoon">Afternoon</option>
                  <option value="evening">Evening</option>
                </select>
              </label>
              <label className="field">
                <span>Energy it takes</span>
                <select value={b.energy ?? ''} onChange={(e) => set({ energy: (e.target.value || undefined) as Energy | undefined })}>
                  <option value="">Not sure</option>
                  <option value="low">Low</option>
                  <option value="medium">Some</option>
                  <option value="high">A lot</option>
                </select>
              </label>
            </div>

            {b.category !== 'none' && (
              <label className="field">
                <span>If no place fits, instead</span>
                <input value={b.fallback ?? ''} onChange={(e) => set({ fallback: e.target.value || undefined })} placeholder="e.g. Bodyweight workout at home" maxLength={120} />
              </label>
            )}
          </details>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary wide">
          {editing ? 'Save' : 'Add'}
        </button>
        {editing && onDelete && (
          <button type="button" className="danger wide" onClick={() => onDelete(initial!.id)}>
            Delete
          </button>
        )}
      </form>
    </Sheet>
  );
}
