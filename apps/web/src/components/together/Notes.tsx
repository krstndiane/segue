/**
 * Notes: yours, shared with you, discoverable, and the ones you asked to join.
 * "Can I join?" (the heart) asks; only the author's "Say yes" makes it a plan
 * you're both in. Neither ever changes anyone's own day.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InterestStatus, InterestView, InvitationView, NoteScope, NoteView, PublicProfile, Visibility } from '@segue/schemas';
import {
  ApiError,
  acceptJoin,
  clientId,
  createNote,
  declineJoin,
  deleteNote,
  heartNote,
  listNotes,
  noteInterests,
  unheartNote,
  updateNote,
} from '../../lib/social';
import type { StoredBlock } from '../../lib/model';
import { dayWords } from '../../lib/when';
import { Segmented, Sheet } from '../Sheet';
import { PeoplePicker, PersonLine } from './People';

const SCOPES: { value: NoteScope; label: string }[] = [
  { value: 'mine', label: 'Mine' },
  { value: 'shared', label: 'Shared with me' },
  { value: 'discover', label: 'Discover' },
  { value: 'hearted', label: 'Asked' },
];

const EMPTY: Record<NoteScope, string> = {
  mine: 'No notes yet. Jot down an idea, a plan, or something you’d like company for.',
  shared: 'Nothing shared with you yet. When someone shares a note with you, it shows up here.',
  discover: 'Nothing to discover right now. People who make notes discoverable show up here.',
  hearted: 'Plans you asked to join show up here, with their answer.',
};

export const INTEREST_WORDS: Record<InterestStatus, string> = {
  interested: 'Asked to join',
  invited: 'Invited',
  accepted: 'Going',
  declined: 'Declined',
  withdrawn: 'No longer asking',
  not_now: 'Not this time',
};

const VISIBILITY_WORDS = (n: NoteView): string =>
  n.visibility === 'private' ? 'Private' : n.visibility === 'discoverable' ? 'Discoverable' : `Shared with ${n.sharedWith?.length ?? 0}`;

function Heart({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"
        fill={on ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NoteCard({
  note,
  today,
  onEdit,
  onInterests,
  onHeart,
}: {
  note: NoteView;
  today: string;
  onEdit: () => void;
  onInterests: () => void;
  onHeart: () => void;
}) {
  return (
    <li className={`note-card${note.pinned ? ' pinned' : ''}`} id={`note-${note.id}`}>
      {!note.mine && <PersonLine person={note.author} />}
      <div className="note-main">
        <h4 className="note-title">
          {note.pinned && <span className="visually-hidden">Pinned: </span>}
          {note.title}
        </h4>
        {note.body && <p className="note-body">{note.body}</p>}
        <p className="note-meta muted small">
          {[note.onDate ? dayWords(note.onDate, today) : null, note.placeName, note.mine ? VISIBILITY_WORDS(note) : null, note.archived ? 'Archived' : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="note-actions">
        {note.mine ? (
          <>
            {(note.heartCount ?? 0) > 0 && (
              <button type="button" className="ghost small-button" onClick={onInterests}>
                <Heart on /> {note.heartCount} asked to join
              </button>
            )}
            <button type="button" className="text-button" onClick={onEdit}>
              Edit
            </button>
          </>
        ) : (
          <>
            {note.interest && note.interest !== 'interested' && note.interest !== 'withdrawn' ? (
              <span className="chip static">{INTEREST_WORDS[note.interest]}</span>
            ) : !note.openToJoin && !note.hearted ? (
              <span className="muted small">Not open to join</span>
            ) : (
              <button
                type="button"
                className={`heart${note.hearted ? ' on' : ''}`}
                aria-pressed={!!note.hearted}
                aria-label={note.hearted ? `You asked to join ${note.title}. Tap to take it back` : `Ask ${note.author.displayName} if you can join ${note.title}`}
                onClick={onHeart}
              >
                <Heart on={!!note.hearted} />
                <span>{note.hearted ? `Asked · waiting for ${note.author.displayName}` : 'Can I join?'}</span>
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export function NotesSection({
  today,
  blocks,
  notify,
  onInvite,
  onJoined,
  focus,
}: {
  today: string;
  blocks: StoredBlock[];
  notify: (text: string) => void;
  /** someone's request was accepted: the new shared plan */
  onJoined?: (invitations: InvitationView[]) => void;
  /** start an invitation from a note, to these people */
  onInvite: (note: NoteView, people: PublicProfile[]) => void;
  /** open a scope (and maybe one note's interests) from a notification */
  focus?: { scope: NoteScope; noteId?: string; interests?: boolean; n: number };
}) {
  const [scope, setScope] = useState<NoteScope>(focus?.scope ?? 'mine');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [editing, setEditing] = useState<NoteView | 'new' | null>(null);
  const [interestsOf, setInterestsOf] = useState<NoteView | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const r = await listNotes(scope, { q: q.trim() || undefined, archived: scope === 'mine' && archived });
      setNotes(r.notes);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [scope, q, archived]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Opened from a notification.
  useEffect(() => {
    if (!focus) return;
    setScope(focus.scope);
    setArchived(false);
    setQ('');
  }, [focus]);
  useEffect(() => {
    if (!focus?.noteId || state !== 'ready') return;
    const n = notes.find((x) => x.id === focus.noteId);
    if (n && focus.interests) setInterestsOf(n);
    document.getElementById(`note-${focus.noteId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n, state]);

  const replace = (n: NoteView) => setNotes((list) => list.map((x) => (x.id === n.id ? n : x)));

  /** Shown at once; put back if the server says no. */
  async function toggleHeart(n: NoteView) {
    const before = n;
    const on = !n.hearted;
    replace({ ...n, hearted: on, interest: on ? (n.interest && n.interest !== 'withdrawn' ? n.interest : 'interested') : 'withdrawn' });
    try {
      if (on) {
        replace((await heartNote(n.id)).note);
        notify(`${n.author.displayName} will know you'd like to join.`);
      } else {
        const r = await unheartNote(n.id);
        if (r.invitationStillOpen) notify('Heart taken back. Your invitation is still there in Invitations.');
        if (scope === 'hearted') setNotes((list) => list.filter((x) => x.id !== n.id));
      }
    } catch (e) {
      replace(before);
      notify(e instanceof ApiError ? e.message : "Couldn't save that. Try again.");
    }
  }

  return (
    <section className="together-section" aria-label="Notes">
      <div className="chips" role="tablist" aria-label="Which notes">
        {SCOPES.map((s) => (
          <button key={s.value} type="button" role="tab" aria-selected={scope === s.value} className={`chip${scope === s.value ? ' on' : ''}`} onClick={() => setScope(s.value)}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="note-tools">
        <input type="search" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
        <button type="button" className="primary" onClick={() => setEditing('new')}>
          New note
        </button>
      </div>
      {scope === 'mine' && (
        <label className="check small">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
      )}

      {state === 'loading' && notes.length === 0 && <p className="muted">Loading notes…</p>}
      {state === 'error' && (
        <div className="notice">
          <p>Couldn't load notes just now.</p>
          <button type="button" className="ghost" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
      {state === 'ready' && notes.length === 0 && <p className="empty muted">{q ? 'No notes match that.' : EMPTY[scope]}</p>}
      {notes.length > 0 && (
        <ul className="note-list">
          {notes.map((n) => (
            <NoteCard key={n.id} note={n} today={today} onEdit={() => setEditing(n)} onInterests={() => setInterestsOf(n)} onHeart={() => void toggleHeart(n)} />
          ))}
        </ul>
      )}

      {editing && (
        <NoteSheet
          note={editing === 'new' ? null : editing}
          today={today}
          blocks={blocks}
          onClose={() => setEditing(null)}
          onSaved={(n, created) => {
            setEditing(null);
            if (created && scope !== 'mine') setScope('mine');
            else setNotes((list) => (created ? [n, ...list] : list.map((x) => (x.id === n.id ? n : x))));
            notify(created ? (n.visibility === 'private' ? 'Note saved. Only you can see it.' : 'Note saved and shared.') : 'Note updated.');
          }}
          onDeleted={(id) => {
            setEditing(null);
            setNotes((list) => list.filter((x) => x.id !== id));
            notify('Note deleted.');
          }}
        />
      )}
      {interestsOf && (
        <InterestsSheet
          note={interestsOf}
          onClose={() => setInterestsOf(null)}
          onInvite={(people) => {
            setInterestsOf(null);
            onInvite(interestsOf, people);
          }}
          onJoined={onJoined}
          notify={notify}
        />
      )}
    </section>
  );
}

export function NoteSheet({
  note,
  today,
  blocks,
  onClose,
  onSaved,
  onDeleted,
}: {
  note: NoteView | null;
  today: string;
  blocks: StoredBlock[];
  onClose: () => void;
  onSaved: (n: NoteView, created: boolean) => void;
  onDeleted: (id: string) => void;
}) {
  const [title, setTitle] = useState(note?.title ?? '');
  const [body, setBody] = useState(note?.body ?? '');
  const [onDate, setOnDate] = useState(note?.onDate ?? '');
  const [placeName, setPlaceName] = useState(note?.placeName ?? '');
  const [blockId, setBlockId] = useState(note?.blockId ?? '');
  const [visibility, setVisibility] = useState<Visibility>(note?.visibility ?? 'private');
  const [people, setPeople] = useState<PublicProfile[]>(note?.sharedWith ?? []);
  const [pinned, setPinned] = useState(!!note?.pinned);
  const [openToJoin, setOpenToJoin] = useState(note?.openToJoin ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cid] = useState(clientId);
  const linkable = blocks.filter((b) => b.active && (!b.date || b.date >= today));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (visibility === 'selected' && people.length === 0) {
      setError('Choose at least one person, or keep it private.');
      return;
    }
    setBusy(true);
    setError(null);
    const input = {
      title: title.trim(),
      body: body.trim(),
      onDate: onDate || null,
      placeName: placeName.trim() || null,
      blockId: blockId || null,
      visibility,
      pinned,
      openToJoin,
      shareWith: people.map((p) => p.id),
    };
    try {
      const res = note ? await updateNote(note.id, input) : await createNote({ ...input, clientId: cid });
      onSaved(res.note, !note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save just now. Try again.");
      setBusy(false);
    }
  }

  async function archive(on: boolean) {
    if (!note) return;
    setBusy(true);
    try {
      onSaved((await updateNote(note.id, { archived: on })).note, false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save just now.");
      setBusy(false);
    }
  }

  async function remove() {
    if (!note) return;
    setBusy(true);
    try {
      await deleteNote(note.id);
      onDeleted(note.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete just now.");
      setBusy(false);
    }
  }

  return (
    <Sheet title={note ? 'Edit note' : 'New note'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span>Title</span>
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Study at a café Saturday afternoon" />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <textarea rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="pair">
          <label className="field">
            <span>Day (optional)</span>
            <input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Place (optional)</span>
            <input maxLength={120} value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Café, park, library…" />
          </label>
        </div>
        {linkable.length > 0 && (
          <label className="field">
            <span>About one of your plans (optional)</span>
            <select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
              <option value="">None</option>
              {linkable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                  {b.date ? ` (${dayWords(b.date, today)})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <Segmented<Visibility>
          label="Who can see it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: 'private', label: 'Only me' },
            { value: 'selected', label: 'People I choose' },
            { value: 'discoverable', label: 'Anyone who finds me' },
          ]}
        />
        <p className="muted small">
          {visibility === 'private'
            ? 'Nobody else can see it.'
            : visibility === 'selected'
              ? 'Only the people you choose can see it. Your other plans, notes and location stay private.'
              : 'People who can find you can see it. Your other plans, notes and location stay private.'}
        </p>
        {visibility === 'selected' && <PeoplePicker label="Share with" selected={people} onChange={setPeople} />}
        {visibility !== 'private' && (
          <label className="check">
            <input type="checkbox" checked={openToJoin} onChange={(e) => setOpenToJoin(e.target.checked)} />
            <span>
              Open to join requests
              <span className="muted small block">
                {openToJoin ? 'They can ask “Can I join?”. Nothing is agreed until you say yes.' : 'They can see it, but not ask to join.'}
              </span>
            </span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>Pin to the top</span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Saving…' : 'Save note'}
        </button>
        {note && (
          <div className="row-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => void archive(!note.archived)}>
              {note.archived ? 'Unarchive' : 'Archive'}
            </button>
            {!confirmDelete ? (
              <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            ) : (
              <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
                Delete for good
              </button>
            )}
          </div>
        )}
        {note && confirmDelete && <p className="muted small">Requests to join go too. Plans you already agreed stay.</p>}
      </form>
    </Sheet>
  );
}

/** Someone asked "Can I join?": say yes (with a time if you like) or not this time. Nothing changes anyone's day. */
export function InterestsSheet({
  note,
  onClose,
  onInvite,
  onJoined,
  notify,
}: {
  note: NoteView;
  onClose: () => void;
  onInvite: (people: PublicProfile[]) => void;
  onJoined?: (invitations: InvitationView[]) => void;
  notify?: (text: string) => void;
}) {
  const [list, setList] = useState<InterestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [yesFor, setYesFor] = useState<InterestView | null>(null);
  const [noFor, setNoFor] = useState<InterestView | null>(null);
  const [date, setDate] = useState(note.onDate ?? '');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    noteInterests(note.id)
      .then((r) => setList(r.interests))
      .catch(() => setError("Couldn't load this just now."));
  }, [note.id]);
  useEffect(load, [load]);
  const invitable = (list ?? []).filter((i) => i.status === 'declined');
  const at = (hhmm: string) => (date && hhmm ? new Date(`${date}T${hhmm}`).toISOString() : null);

  async function sayYes(i: InterestView, e: FormEvent) {
    e.preventDefault();
    if (end && !start) return setError('Add a start time before an end time.');
    setBusy(true);
    setError(null);
    try {
      const r = await acceptJoin(note.id, i.id, { startsAt: at(start), endsAt: at(end), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', placeName: note.placeName });
      onJoined?.(r.invitations);
      notify?.(`You and ${i.user.displayName} are both in for “${note.title}”.`);
      setYesFor(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function notThisTime(i: InterestView) {
    setBusy(true);
    setError(null);
    try {
      await declineJoin(note.id, i.id);
      notify?.(`${i.user.displayName} will see “not this time”.`);
      setNoFor(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Asked to join" onClose={onClose}>
      <div className="form">
        <p className="muted small">
          They asked to join “{note.title}”. Asking isn’t agreeing: say yes to make it a plan you’re both in, or not this time. Neither changes anyone’s own
          day.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!list && !error && <p className="muted">Loading…</p>}
        {list && list.length === 0 && <p className="muted">Nobody yet.</p>}
        {list && list.length > 0 && (
          <ul className="people-list">
            {list.map((i) => (
              <li key={i.id} className="join-request">
                <PersonLine person={i.user} extra={INTEREST_WORDS[i.status]} />
                {i.status === 'interested' && yesFor?.id !== i.id && noFor?.id !== i.id && (
                  <div className="row-actions">
                    <button type="button" className="primary small-button" disabled={busy} onClick={() => setYesFor(i)}>
                      Say yes
                    </button>
                    <button type="button" className="ghost small-button" disabled={busy} onClick={() => setNoFor(i)}>
                      Not this time
                    </button>
                  </div>
                )}
                {yesFor?.id === i.id && (
                  <form className="join-yes" onSubmit={(e) => void sayYes(i, e)}>
                    <p className="small">When? (optional: you can agree first and settle the time later)</p>
                    <div className="pair">
                      <label className="field">
                        <span>Day</span>
                        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                      </label>
                      <label className="field">
                        <span>From</span>
                        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!date} />
                      </label>
                      <label className="field">
                        <span>Until</span>
                        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!date || !start} />
                      </label>
                    </div>
                    <div className="row-actions">
                      <button type="submit" className="primary small-button" disabled={busy}>
                        {busy ? 'Saving…' : `Yes, ${i.user.displayName} can join`}
                      </button>
                      <button type="button" className="ghost small-button" disabled={busy} onClick={() => setYesFor(null)}>
                        Back
                      </button>
                    </div>
                  </form>
                )}
                {noFor?.id === i.id && (
                  <div className="row-actions">
                    <span className="small">Tell {i.user.displayName} not this time?</span>
                    <button type="button" className="danger small-button" disabled={busy} onClick={() => void notThisTime(i)}>
                      Yes, not this time
                    </button>
                    <button type="button" className="ghost small-button" disabled={busy} onClick={() => setNoFor(null)}>
                      Back
                    </button>
                  </div>
                )}
                {i.status === 'declined' && (
                  <button type="button" className="ghost small-button" onClick={() => onInvite([i.user])}>
                    Invite again
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {invitable.length > 1 && (
          <button type="button" className="ghost wide" onClick={() => onInvite(invitable.map((i) => i.user))}>
            Invite all {invitable.length} again
          </button>
        )}
      </div>
    </Sheet>
  );
}
