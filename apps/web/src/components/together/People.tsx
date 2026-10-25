/** Finding people to share a note with or invite. */
import { useEffect, useState } from 'react';
import type { ConnectionsResponse, ConnectionState, ProfileCard, PublicProfile } from '@segue/schemas';
import {
  acceptConnection,
  ApiError,
  blockUser,
  declineConnection,
  getUser,
  listConnections,
  removeConnection,
  requestConnection,
  searchUsers,
  unblockUser,
} from '../../lib/social';
import { Avatar } from '../Account';
import { Sheet } from '../Sheet';

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

// ---- mutual connections ----

type Found = PublicProfile & { connection?: ConnectionState };

const sayError = (e: unknown) => (e instanceof ApiError ? e.message : "That didn't work. Try again.");

const STATE_WORDS: Record<ConnectionState, string> = {
  none: '',
  mutual: 'Mutuals',
  request_sent: 'Requested',
  request_received: 'Asked to connect',
  blocked: '',
};

/** The People tab: find people, answer requests, see your mutuals and who you've blocked. */
export function PeopleSection({
  connections,
  onChange,
  notify,
}: {
  connections: ConnectionsResponse | null;
  onChange: (c: ConnectionsResponse) => void;
  notify: (text: string) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  async function act(key: string, run: () => Promise<ConnectionsResponse | void>, done?: string) {
    setBusy(key);
    try {
      const next = await run();
      if (next) onChange(next);
      if (done) notify(done);
    } catch (e) {
      notify(sayError(e));
    } finally {
      setBusy(null);
    }
  }

  async function connect(p: Found) {
    setBusy(p.id);
    try {
      const r = await requestConnection(p.id);
      setResults((list) => list.map((x) => (x.id === p.id ? { ...x, connection: r.connection.state } : x)));
      notify(r.connection.state === 'mutual' ? `You and ${p.displayName} are mutuals.` : `Request sent to ${p.displayName}.`);
      onChange(await listConnections());
    } catch (e) {
      notify(sayError(e));
    } finally {
      setBusy(null);
    }
  }

  const c = connections;
  return (
    <section className="together-section" aria-label="People">
      <p className="muted small">Mutuals are people you both agreed to connect with. Nothing is shared until you choose to share it.</p>
      <label className="field">
        <span>Find someone</span>
        <input type="search" placeholder="Search by name or @username" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {state === 'loading' && <span className="muted small">Searching…</span>}
      {state === 'error' && <span className="error">Couldn't search just now.</span>}
      {state === 'idle' && q.trim().length >= 2 && results.length === 0 && <span className="muted small">Nobody found. Only people who let others find them show up here.</span>}
      {results.length > 0 && (
        <ul className="people-list">
          {results.map((p) => (
            <li key={p.id} className="people-row">
              <button type="button" className="people-open" onClick={() => setOpen(p.id)}>
                <PersonLine person={p} />
              </button>
              {p.connection === 'none' || !p.connection ? (
                <button type="button" className="ghost small-button" disabled={busy === p.id} onClick={() => void connect(p)}>
                  Connect
                </button>
              ) : (
                <span className="muted small">{STATE_WORDS[p.connection]}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {c && c.incoming.length > 0 && (
        <>
          <h3 className="section-title">Requests for you</h3>
          <ul className="people-list">
            {c.incoming.map((r) => (
              <li key={r.id} className="people-row">
                <button type="button" className="people-open" onClick={() => setOpen(r.person.id)}>
                  <PersonLine person={r.person} />
                </button>
                <span className="row-actions">
                  <button type="button" className="primary small-button" disabled={busy === r.id} onClick={() => void act(r.id, () => acceptConnection(r.id), `You and ${r.person.displayName} are mutuals.`)}>
                    Accept
                  </button>
                  <button type="button" className="ghost small-button" disabled={busy === r.id} onClick={() => void act(r.id, () => declineConnection(r.id))}>
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="section-title">Your mutuals{c ? ` (${c.mutuals.length})` : ''}</h3>
      {!c && <p className="muted small">Loading…</p>}
      {c && c.mutuals.length === 0 && <p className="empty muted">No mutuals yet. Search for someone above and send a request.</p>}
      {c && c.mutuals.length > 0 && (
        <ul className="people-list">
          {c.mutuals.map((m) => (
            <li key={m.id} className="people-row">
              <button type="button" className="people-open" onClick={() => setOpen(m.person.id)}>
                <PersonLine person={m.person} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {c && c.outgoing.length > 0 && (
        <>
          <h3 className="section-title">Requests you sent</h3>
          <ul className="people-list">
            {c.outgoing.map((r) => (
              <li key={r.id} className="people-row">
                <button type="button" className="people-open" onClick={() => setOpen(r.person.id)}>
                  <PersonLine person={r.person} extra="waiting" />
                </button>
                <button type="button" className="ghost small-button" disabled={busy === r.id} onClick={() => void act(r.id, () => removeConnection(r.id), 'Request cancelled.')}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {c && c.blocked.length > 0 && (
        <>
          <h3 className="section-title">Blocked</h3>
          <ul className="people-list">
            {c.blocked.map((b) => (
              <li key={b.person.id} className="people-row">
                <PersonLine person={b.person} />
                <button type="button" className="ghost small-button" disabled={busy === b.person.id} onClick={() => void act(b.person.id, () => unblockUser(b.person.id), `${b.person.displayName} is unblocked.`)}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Unblocking doesn't reconnect you or restore anything that was removed.</p>
        </>
      )}

      {open && <ProfileCardSheet id={open} onClose={() => setOpen(null)} onChange={onChange} notify={notify} />}
    </section>
  );
}

/** Someone's profile, with the actions that fit how you're connected. */
export function ProfileCardSheet({ id, onClose, onChange, notify }: { id: string; onClose: () => void; onChange: (c: ConnectionsResponse) => void; notify: (text: string) => void }) {
  const [card, setCard] = useState<ProfileCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);

  function load() {
    getUser(id)
      .then((r) => setCard(r.user))
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This profile isn't available." : sayError(e)));
  }
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(go: () => Promise<ConnectionsResponse | { connection: { id: string; state: ConnectionState } }>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await go();
      if ('mutuals' in r) onChange(r);
      else {
          onChange(await listConnections());
      }
      notify(done);
      load();
    } catch (e) {
      setError(sayError(e));
    } finally {
      setBusy(false);
      setConfirmBlock(false);
    }
  }

  return (
    <Sheet title={card?.displayName ?? 'Profile'} onClose={onClose}>
      <div className="form profile-card">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!card && !error && <p className="muted">Loading…</p>}
        {card && (
          <>
            <div className="avatar-row">
              <Avatar person={card} size={72} />
              <div>
                <strong>{card.displayName}</strong>
                <span className="muted small block">
                  @{card.username}
                  {card.pronouns ? ` · ${card.pronouns}` : ''}
                </span>
                {card.mutualCount !== undefined && (
                  <span className="muted small block">
                    {card.mutualCount} mutual{card.mutualCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
            {card.full && card.bio && <p>{card.bio}</p>}
            {card.full && card.interests.length > 0 && (
              <ul className="chips" aria-label="Interests">
                {card.interests.map((i) => (
                  <li key={i} className="chip static">
                    {i}
                  </li>
                ))}
              </ul>
            )}
            {!card.full && <p className="muted small">{card.connection === 'mutual' ? 'They keep their details to themselves.' : 'They share more with their mutuals.'}</p>}

            {card.connection === 'none' && (
              <button type="button" className="primary wide" disabled={busy} onClick={() => void run(() => requestConnection(card.id), `Request sent to ${card.displayName}.`)}>
                Connect
              </button>
            )}
            {card.connection === 'request_sent' && card.connectionId && (
              <button type="button" className="ghost wide" disabled={busy} onClick={() => void run(() => removeConnection(card.connectionId!), 'Request cancelled.')}>
                Cancel request
              </button>
            )}
            {card.connection === 'request_received' && card.connectionId && (
              <div className="row-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void run(() => acceptConnection(card.connectionId!), `You and ${card.displayName} are mutuals.`)}>
                  Accept
                </button>
                <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => declineConnection(card.connectionId!), 'Request declined.')}>
                  Decline
                </button>
              </div>
            )}
            {card.connection === 'mutual' && card.connectionId && (
              <button type="button" className="ghost wide" disabled={busy} onClick={() => void run(() => removeConnection(card.connectionId!), `${card.displayName} is no longer a mutual.`)}>
                Remove from mutuals
              </button>
            )}

            {card.connection !== 'blocked' &&
              (!confirmBlock ? (
                <button type="button" className="text-button danger-text" onClick={() => setConfirmBlock(true)}>
                  Block {card.displayName.split(' ')[0]}…
                </button>
              ) : (
                <div className="settings-group">
                  <p className="small">
                    They won't be able to find you, see your notes, or send you requests or invitations. This also removes them from your mutuals and cancels invitations
                    that are still waiting. You can unblock them later, but that won't bring any of it back.
                  </p>
                  <div className="row-actions">
                    <button type="button" className="danger" disabled={busy} onClick={() => void run(() => blockUser(card.id), `${card.displayName} is blocked.`)}>
                      Block
                    </button>
                    <button type="button" className="ghost" onClick={() => setConfirmBlock(false)}>
                      Keep as is
                    </button>
                  </div>
                </div>
              ))}
          </>
        )}
      </div>
    </Sheet>
  );
}
