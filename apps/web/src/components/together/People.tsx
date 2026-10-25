/** Finding people to share a note with or invite. */
import { useEffect, useState } from 'react';
import type { PublicProfile } from '@segue/schemas';
import { searchUsers } from '../../lib/social';
import { Avatar } from '../Account';

export function PersonLine({ person, extra }: { person: PublicProfile; extra?: string }) {
  return (
    <span className="person">
      <Avatar person={person} size={32} />
      <span className="person-text">
        <strong>{person.displayName}</strong>
        <span className="muted small"> @{person.username}{extra ? ` · ${extra}` : ''}</span>
      </span>
    </span>
  );
}

export function PeoplePicker({
  label,
  selected,
  onChange,
  locked = false,
}: {
  label: string;
  selected: PublicProfile[];
  onChange: (people: PublicProfile[]) => void;
  /** show the people without letting them change (editing a sent invitation) */
  locked?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PublicProfile[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setState('idle');
      return;
    }
    setState('loading');
    const t = setTimeout(() => {
      searchUsers(term)
        .then((r) => {
          setResults(r.users);
          setState('idle');
        })
        .catch(() => setState('error'));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const chosen = new Set(selected.map((p) => p.id));
  return (
    <fieldset className="field people-picker">
      <legend>{label}</legend>
      {selected.length > 0 && (
        <ul className="chips" aria-label="Chosen">
          {selected.map((p) => (
            <li key={p.id} className="chip static person-chip">
              <Avatar person={p} size={20} />
              {p.displayName}
              {!locked && (
                <button type="button" className="chip-x" aria-label={`Remove ${p.displayName}`} onClick={() => onChange(selected.filter((x) => x.id !== p.id))}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <>
          <input type="search" placeholder="Search by name or @username" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
          {state === 'loading' && <span className="muted small">Searching…</span>}
          {state === 'error' && <span className="error">Couldn't search just now.</span>}
          {state === 'idle' && q.trim().length >= 2 && results.length === 0 && (
            <span className="muted small">Nobody found. Only people who let others find them show up here.</span>
          )}
          {results.length > 0 && (
            <ul className="pick-people">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="pick-person"
                    aria-pressed={chosen.has(p.id)}
                    onClick={() => onChange(chosen.has(p.id) ? selected.filter((x) => x.id !== p.id) : [...selected, p])}
                  >
                    <PersonLine person={p} />
                    <span className="pick-mark" aria-hidden="true">
                      {chosen.has(p.id) ? '✓' : '+'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}
