import { useEffect, useState } from 'react';
import { WEEKDAY_SHORT, repeatLabel, type StoredBlock } from '../lib/model';
import { CATEGORY_WORDS, timeWords, type RoutineCategory, type RoutineKind, type Suggestion } from '../lib/routines';
import type { useRoutineLearning } from '../lib/useRoutineLearning';
import { Segmented } from './Sheet';

type Learning = ReturnType<typeof useRoutineLearning>;
const CATS = Object.keys(CATEGORY_WORDS) as RoutineCategory[];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const KIND_WORDS: Record<RoutineKind, string> = { fixed: 'Fixed', flexible: 'Flexible' };
const KIND_HELP: Record<RoutineKind, string> = {
  fixed: 'Fixed: it happens at this time. Segue plans around it and never moves it.',
  flexible: 'Flexible: Segue can move it a little (an hour before to an hour and a half after) when the day needs it.',
};

/** One suggestion: what Segue saw, and the person's choices. Editing keeps it a suggestion until saved. */
function SuggestionCard({ s, other, learning }: { s: Suggestion; other?: Suggestion; learning: Learning }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s);
  useEffect(() => setDraft(s), [s]);
  const toggleDay = (d: number) => setDraft((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort((a, b) => a - b) }));
  const valid = draft.name.trim() && draft.days.length > 0 && draft.end > draft.start;

  return (
    <li className={`rl-card${s.needsReview ? ' unsure' : ''}`} id={`rl-${s.id}`}>
      <div className="rl-top">
        <span className={`rl-cat c-${s.category}`}>{CATEGORY_WORDS[s.category]}</span>
        <span className="rl-kind">{KIND_WORDS[s.kind]}</span>
      </div>
      <h4 className="rl-name">{s.name}</h4>
      <p className="rl-when">
        {repeatLabel(s.days)} · {timeWords(s.start)}–{timeWords(s.end)}
        {s.location ? ` · ${s.location}` : ''}
      </p>
      <p className="muted small">{s.needsReview ? `Not sure about this one. ${s.reason}` : s.reason}</p>

      {other && (
        <p className="rl-similar small">
          Looks like the same thing as “{other.name}”.{' '}
          <button type="button" className="text-button" onClick={() => learning.merge(s.id, other.id)}>
            Merge them
          </button>
        </p>
      )}

      {editing ? (
        <form
          className="form rl-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            learning.confirm(s.id, { name: draft.name.trim(), category: draft.category, kind: draft.kind, days: draft.days, start: draft.start, end: draft.end });
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            <span>What kind</span>
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as RoutineCategory })}>
              {CATS.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_WORDS[c]}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Can Segue move it?</span>
            <Segmented<RoutineKind>
              label="Fixed or flexible"
              value={draft.kind}
              onChange={(kind) => setDraft({ ...draft, kind })}
              options={[
                { value: 'fixed', label: 'Fixed' },
                { value: 'flexible', label: 'Flexible' },
              ]}
            />
            <span className="muted small">{KIND_HELP[draft.kind]}</span>
          </div>
          <fieldset className="field">
            <legend>Days</legend>
            <div className="repeat-days">
              {WEEK.map((d) => (
                <button key={d} type="button" className={`chip${draft.days.includes(d) ? ' on' : ''}`} aria-pressed={draft.days.includes(d)} onClick={() => toggleDay(d)}>
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="pair">
            <label className="field">
              <span>From</span>
              <input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
            </label>
            <label className="field">
              <span>Until</span>
              <input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
            </label>
          </div>
          {!valid && <p className="error small">Give it a name, at least one day, and an end after the start.</p>}
          <div className="rl-actions">
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!valid}>
              Save routine
            </button>
          </div>
        </form>
      ) : (
        <div className="rl-actions">
          <button type="button" className="text-button" onClick={() => learning.exclude(s.id)}>
            Not a routine
          </button>
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            Change
          </button>
          <button type="button" className="primary" onClick={() => learning.confirm(s.id)}>
            {s.needsReview ? 'Yes, save it' : 'Save routine'}
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * What Segue learned from the calendar, waiting for the person: new routines
 * to confirm, and changes to routines already confirmed. Nothing here changes
 * a plan until the person says so.
 */
export function RoutineReview({ learning, blocks }: { learning: Learning; blocks: StoredBlock[] }) {
  const { suggestions, changes } = learning;
  // Decided once per visit, so marking it as introduced doesn't change the heading under the person.
  const [first] = useState(() => !learning.state.introduced);
  useEffect(() => {
    if (suggestions.length) learning.introduced();
  }, [suggestions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!suggestions.length && !changes.length) return null;
  const sure = suggestions.filter((s) => !s.needsReview).length;
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  return (
    <section className="rl" aria-labelledby="rl-title">
      <h3 id="rl-title" className="rl-title">
        {first && suggestions.length ? 'We’ve started learning your weekly routine.' : 'Segue noticed something in your calendar'}
      </h3>
      <p className="muted small">From the last four weeks of your Google Calendar. Nothing is saved or changed until you say so.</p>

      {changes.length > 0 && (
        <ul className="rl-list">
          {changes.map((c) => {
            const r = blocks.find((b) => b.id === c.routineId);
            if (!r) return null;
            return (
              <li key={c.id} className="rl-card change">
                <p>{c.reason}</p>
                {c.kind === 'gone' && <p className="muted small">One missed week doesn’t count; this has been three.</p>}
                <div className="rl-actions">
                  <button type="button" className="ghost" onClick={() => learning.dismiss(c.id)}>
                    {c.kind === 'gone' ? 'Keep it' : 'Keep it as it is'}
                  </button>
                  <button type="button" className="primary" onClick={() => learning.applyChange(c.id)}>
                    {c.kind === 'gone' ? 'Remove the routine' : c.kind === 'time' ? `Move it to ${timeWords(c.start!)}` : `Change to ${repeatLabel(c.days)}`}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {sure >= 2 && (
        <button type="button" className="ghost wide" onClick={() => learning.confirmSure()}>
          Save the {sure} Segue is sure about
        </button>
      )}
      <ul className="rl-list">
        {suggestions.map((s) => (
          <SuggestionCard key={s.id} s={s} other={s.similarTo ? byId.get(s.similarTo) : undefined} learning={learning} />
        ))}
      </ul>
    </section>
  );
}

/** On Today: there's something to look at in Routines. */
export function RoutineNudge({ learning, onOpen }: { learning: Learning; onOpen: () => void }) {
  const n = learning.suggestions.length;
  const c = learning.changes.length;
  if (!n && !c) return null;
  const first = !learning.state.introduced && n > 0;
  return (
    <button type="button" className="together-card routine-nudge" onClick={onOpen}>
      <strong>{first ? 'We’ve started learning your weekly routine' : c ? 'A routine looks different in your calendar' : 'Segue found more routines in your calendar'}</strong>
      <span className="muted small block">
        {n ? `${n} to review` : ''}
        {n && c ? ' · ' : ''}
        {c ? `${c} change${c === 1 ? '' : 's'} to look at` : ''}. Nothing changes until you confirm.
      </span>
    </button>
  );
}

/** Mon to Sun: what the week looks like with the routines you have. */
export function WeekOverview({ blocks }: { blocks: StoredBlock[] }) {
  const routines = blocks.filter((b) => !b.date && b.active);
  if (!routines.length) return null;
  const at = (b: StoredBlock) => b.fixedStart ?? b.earliest ?? '';
  return (
    <section className="week-overview" aria-label="Your week">
      <h3 className="section-title">Your week</h3>
      <ol>
        {WEEK.map((d) => {
          const on = routines.filter((b) => !b.days?.length || b.days.includes(d)).sort((a, b) => at(a).localeCompare(at(b)));
          return (
            <li key={d}>
              <span className="wo-day">{WEEKDAY_SHORT[d]}</span>
              {on.length ? (
                <span className="wo-items">
                  {on.map((b) => (
                    <span key={b.id} className={b.fixedStart ? 'wo-item fixed' : 'wo-item'}>
                      {b.fixedStart ? `${timeWords(b.fixedStart)} ` : ''}
                      {b.title}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="muted small">Open</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
