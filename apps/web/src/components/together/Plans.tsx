/**
 * Shared plans in Together: Discover (plans people shared with you), Requests
 * (people asking to join yours, and what you asked), My plans, and the sheets to
 * share a plan or ask to join one.
 *
 * On the server these are "notes"; here they're plans, because that's what
 * people share. "Can I join?" only asks: nothing is agreed until the owner says
 * yes, and none of it ever changes anyone's own day.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { InterestStatus, InterestView, InvitationView, NoteView, PublicProfile, Visibility } from '@segue/schemas';
import {
  ApiError,
  acceptJoin,
  clientId,
  createNote,
  declineJoin,
  deleteNote,
  heartNote,
  isOffline,
  listNotes,
  noteInterests,
  unheartNote,
  updateNote,
} from '../../lib/social';
import type { StoredBlock } from '../../lib/model';
import { dayWords } from '../../lib/when';
import { Avatar } from '../Account';
import { Segmented, Sheet } from '../Sheet';
import { PeoplePicker, PersonLine } from './People';

export const INTEREST_WORDS: Record<InterestStatus, string> = {
  interested: 'Request sent',
  invited: 'Invited',
  accepted: 'Going',
  declined: 'Declined',
  withdrawn: 'Request taken back',
  not_now: 'Not this time',
};

/** "2:00 PM" from "14:00". */
export function hhmmWords(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Sat, Nov 7 · 2:00–4:00 PM", "Today", "Any day". */
export function planWhen(n: Pick<NoteView, 'onDate' | 'startTime' | 'endTime'>, today: string): string {
  const day = n.onDate ? dayWords(n.onDate, today) : 'Any day';
  if (!n.startTime) return day;
  const start = hhmmWords(n.startTime);
  if (!n.endTime) return `${day} · ${start}`;
  const end = hhmmWords(n.endTime);
  // "2:00–4:00 PM" when both are in the afternoon
  const same = start.slice(-2) === end.slice(-2);
  return `${day} · ${same ? start.slice(0, -3) : start}–${end}`;
}

/** Who can see a plan, in words, for the small label on its card. */
function seenBy(n: NoteView): string {
  if (n.mine) return n.visibility === 'private' ? 'Only you' : n.visibility === 'discoverable' ? 'Anyone who finds you' : `${n.sharedWith?.length ?? 0} ${(n.sharedWith?.length ?? 0) === 1 ? 'person' : 'people'} you chose`;
  return n.visibility === 'discoverable' ? 'Shared publicly' : 'Shared with you';
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.3" fill="currentColor" />
    </svg>
  );
}

/** A small "More options" menu for actions people rarely need. Closes on Escape or a tap elsewhere. */
export function MoreMenu({ label, items }: { label: string; items: { label: string; danger?: boolean; run: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={ref}>
      <button type="button" className="icon-button" aria-label={label} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="18.5" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <ul className="more-list">
          {items.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                className={it.danger ? 'danger-text' : undefined}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One plan. Top: who and who can see it. Middle: what, when, where. Bottom:
 * where it stands, and the one thing to do next.
 */
export function PlanCard({ note, today, status, primary, secondary, menu }: { note: NoteView; today: string; status?: ReactNode; primary?: ReactNode; secondary?: ReactNode; menu?: ReactNode }) {
  return (
    <li className="plan-card" id={`note-${note.id}`}>
      <div className="pc-top">
        {!note.mine && (
          <span className="pc-owner">
            <Avatar person={note.author} size={32} />
            <strong>{note.author.displayName}</strong>
          </span>
        )}
        <span className={note.mine ? 'pc-seen mine' : 'pc-seen'}>
          {note.mine && note.visibility === 'private' && <LockIcon />}
          {seenBy(note)}
        </span>
        {menu}
      </div>
      <h4 className="pc-title">{note.title}</h4>
      {note.body && <p className="pc-body">{note.body}</p>}
      <p className="pc-when">{planWhen(note, today)}</p>
      {note.placeName && (
        <p className="pc-where">
          <PinIcon /> {note.placeName}
        </p>
      )}
      {(status || primary || secondary) && (
        <div className="pc-foot">
          <span className="pc-status">{status}</span>
          <span className="pc-actions">
            {secondary}
            {primary}
          </span>
        </div>
      )}
    </li>
  );
}

/** The same loading and error look everywhere in Together. */
export function LoadState({ state, what, onRetry }: { state: 'loading' | 'error' | 'offline'; what: string; onRetry: () => void }) {
  if (state === 'loading') {
    return (
      <p className="tg-loading" role="status">
        Loading {what}…
      </p>
    );
  }
  return (
    <div className="tg-error" role="alert">
      <p>{state === 'offline' ? `You're offline, so ${what} can't load. Your own plan still works.` : `Couldn't load ${what} just now.`}</p>
      <button type="button" className="ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p>{text}</p>
      {action}
    </div>
  );
}

type Load = 'loading' | 'ready' | 'error' | 'offline';

/** What the viewer can do about someone else's plan, and where it stands. */
function joinParts(n: NoteView, onAsk: () => void, onCancel: () => void, busy: boolean) {
  // The answer wins over the request: once they say yes (or not this time), that's what shows.
  const st = n.interest && n.interest !== 'withdrawn' ? n.interest : n.hearted ? 'interested' : undefined;
  if (st === 'accepted') return { status: <span className="status-chip ok">You&apos;re going</span> };
  if (st === 'invited') return { status: <span className="status-chip">You&apos;re invited · see Invitations</span> };
  if (st === 'not_now') return { status: <span className="status-chip muted-chip">Not this time</span> };
  if (st === 'interested') {
    return {
      status: <span className="status-chip wait">Request sent · waiting for {n.author.displayName}</span>,
      secondary: (
        <button type="button" className="text-button" disabled={busy} onClick={onCancel}>
          Cancel request
        </button>
      ),
    };
  }
  if (!n.openToJoin) return { status: <span className="status-chip muted-chip">Not taking join requests</span> };
  return {
    status: <span className="muted small">Open to join</span>,
    primary: (
      <button type="button" className="primary small-button" disabled={busy} onClick={onAsk}>
        Can I join?
      </button>
    ),
  };
}

/** Discover: plans people chose to share with you, or with anyone who finds them. */
export function DiscoverSection({ today, notify, onFindPeople }: { today: string; notify: (t: string) => void; onFindPeople: () => void }) {
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [state, setState] = useState<Load>('loading');
  const [asking, setAsking] = useState<NoteView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [shared, discover] = await Promise.all([listNotes('shared'), listNotes('discover')]);
      const seen = new Set<string>();
      setNotes([...shared.notes, ...discover.notes].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))));
      setState('ready');
    } catch (e) {
      setState(isOffline(e) ? 'offline' : 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const replace = (n: NoteView) => setNotes((list) => list.map((x) => (x.id === n.id ? n : x)));

  async function cancel(n: NoteView) {
    setBusy(n.id);
    const before = n;
    replace({ ...n, hearted: false, interest: 'withdrawn' });
    try {
      const r = await unheartNote(n.id);
      notify(r.invitationStillOpen ? 'Request taken back. Your invitation is still in Invitations.' : 'Request taken back.');
    } catch (e) {
      replace(before);
      notify(e instanceof ApiError ? e.message : "Couldn't take that back just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (state !== 'ready') return <LoadState state={state} what="plans" onRetry={() => void load()} />;
  return (
    <section className="together-section" aria-label="Discover">
      <p className="tg-intro muted">Plans your people chose to share. Ask to join; nothing is agreed until they say yes.</p>
      {notes.length === 0 ? (
        <EmptyState
          text="Nothing to explore yet. Connect with people to see the plans they choose to share."
          action={
            <button type="button" className="ghost" onClick={onFindPeople}>
              Find people
            </button>
          }
        />
      ) : (
        <ul className="plan-list">
          {notes.map((n) => (
            <PlanCard key={n.id} note={n} today={today} {...joinParts(n, () => setAsking(n), () => void cancel(n), busy === n.id)} />
          ))}
        </ul>
      )}
      {asking && (
        <JoinSheet
          note={asking}
          today={today}
          onClose={() => setAsking(null)}
          onSent={(n) => {
            setAsking(null);
            replace(n);
            notify(`Asked ${n.author.displayName}. Nothing is agreed until they say yes.`);
          }}
        />
      )}
    </section>
  );
}

/** "Can I join?", with an optional message. Sending it only asks. */
export function JoinSheet({ note, today, onClose, onSent }: { note: NoteView; today: string; onClose: () => void; onSent: (n: NoteView) => void }) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSent((await heartNote(note.id, message.trim() || undefined)).note);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that just now. Try again.");
      setBusy(false);
    }
  }
  return (
    <Sheet title="Ask to join" onClose={onClose}>
      <form className="form" onSubmit={(e) => void send(e)}>
        <p>
          <strong>{note.title}</strong>
          <span className="muted small block">
            {note.author.displayName}&apos;s plan · {planWhen(note, today)}
            {note.placeName ? ` · ${note.placeName}` : ''}
          </span>
        </p>
        <label className="field">
          <span>Add a message (optional)</span>
          <textarea rows={3} maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="I can bring the notes from class" />
        </label>
        <p className="muted small">
          {note.author.displayName} decides. Asking doesn&apos;t add anything to either of your days, and you can cancel the request any time.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </form>
    </Sheet>
  );
}

/** People asking to join one of your plans: say yes (time optional) or not this time, right here. */
export function RequestsFor({ note, today, onJoined, notify, onDone }: { note: NoteView; today: string; onJoined?: (inv: InvitationView[]) => void; notify?: (t: string) => void; onDone?: () => void }) {
  const [list, setList] = useState<InterestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [yesFor, setYesFor] = useState<InterestView | null>(null);
  const [noFor, setNoFor] = useState<InterestView | null>(null);
  const [date, setDate] = useState(note.onDate ?? '');
  const [start, setStart] = useState(note.startTime ?? '');
  const [end, setEnd] = useState(note.endTime ?? '');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    noteInterests(note.id)
      .then((r) => setList(r.interests))
      .catch(() => setError("Couldn't load requests just now."));
  }, [note.id]);
  useEffect(load, [load]);
  const at = (hhmm: string) => (date && hhmm ? new Date(`${date}T${hhmm}`).toISOString() : null);

  async function sayYes(i: InterestView, e: FormEvent) {
    e.preventDefault();
    if (end && !start) return setError('Add a start time before an end time.');
    setBusy(true);
    setError(null);
    try {
      const r = await acceptJoin(note.id, i.id, { startsAt: at(start), endsAt: at(end), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', placeName: note.placeName });
      onJoined?.(r.invitations);
      notify?.(`${i.user.displayName} is in for “${note.title}”. They'll be told.`);
      setYesFor(null);
      load();
      onDone?.();
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
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !list) return <p className="error">{error}</p>;
  if (!list) return <p className="tg-loading">Loading requests…</p>;
  const shown = list.filter((i) => i.status !== 'withdrawn');
  if (shown.length === 0) return <p className="muted small">No requests for this plan.</p>;
  return (
    <ul className="request-list">
      {error && (
        <li className="error" role="alert">
          {error}
        </li>
      )}
      {shown.map((i) => (
        <li key={i.id} className="request-row">
          <PersonLine person={i.user} extra={i.status === 'interested' ? undefined : INTEREST_WORDS[i.status]} />
          {i.message && <p className="request-message">“{i.message}”</p>}
          {i.status === 'interested' && yesFor?.id !== i.id && noFor?.id !== i.id && (
            <div className="request-actions">
              <button type="button" className="ghost small-button" disabled={busy} onClick={() => setNoFor(i)}>
                Not this time
              </button>
              <button type="button" className="primary small-button" disabled={busy} onClick={() => setYesFor(i)}>
                Say yes
              </button>
            </div>
          )}
          {yesFor?.id === i.id && (
            <form className="join-yes" onSubmit={(e) => void sayYes(i, e)}>
              <p className="small">When? You can say yes now and settle the time later.</p>
              <div className="pair">
                <label className="field">
                  <span>Day</span>
                  <input type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
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
              <div className="request-actions">
                <button type="button" className="ghost small-button" disabled={busy} onClick={() => setYesFor(null)}>
                  Back
                </button>
                <button type="submit" className="primary small-button" disabled={busy}>
                  {busy ? 'Saving…' : `Yes, ${i.user.displayName} can join`}
                </button>
              </div>
            </form>
          )}
          {noFor?.id === i.id && (
            <div className="request-actions">
              <span className="small grow">Tell {i.user.displayName} not this time? They&apos;ll only see that, nothing else.</span>
              <button type="button" className="ghost small-button" disabled={busy} onClick={() => setNoFor(null)}>
                Back
              </button>
              <button type="button" className="danger small-button" disabled={busy} onClick={() => void notThisTime(i)}>
                Not this time
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The same, in a sheet (from Overview or a notification). */
export function InterestsSheet({ note, today, onClose, onJoined, notify }: { note: NoteView; today: string; onClose: () => void; onJoined?: (inv: InvitationView[]) => void; notify?: (t: string) => void }) {
  return (
    <Sheet title="Requests to join" onClose={onClose}>
      <div className="form">
        <p className="muted small">
          For “{note.title}”. Say yes to make it a plan you&apos;re both in. Neither answer changes anyone&apos;s own day.
        </p>
        <RequestsFor note={note} today={today} onJoined={onJoined} notify={notify} />
      </div>
    </Sheet>
  );
}

/** Requests: people asking to join your plans, and the plans you asked to join. */
export function RequestsSection({ today, notify, onJoined, onDiscover, onChanged }: { today: string; notify: (t: string) => void; onJoined?: (inv: InvitationView[]) => void; onDiscover: () => void; onChanged?: () => void }) {
  const [mine, setMine] = useState<NoteView[]>([]);
  const [asked, setAsked] = useState<NoteView[]>([]);
  const [state, setState] = useState<Load>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([listNotes('mine'), listNotes('hearted')]);
      // Plans with anyone who asked: waiting ones first, and the ones you answered stay visible with their answer.
      setMine(m.notes.filter((n) => (n.heartCount ?? 0) > 0).sort((a, b) => (b.pendingCount ?? 0) - (a.pendingCount ?? 0)));
      setAsked(h.notes);
      setState('ready');
    } catch (e) {
      setState(isOffline(e) ? 'offline' : 'error');
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function cancel(n: NoteView) {
    setBusy(n.id);
    try {
      await unheartNote(n.id);
      setAsked((list) => list.filter((x) => x.id !== n.id));
      notify('Request taken back.');
      onChanged?.();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Couldn't take that back just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (state !== 'ready') return <LoadState state={state} what="requests" onRetry={() => void load()} />;
  return (
    <section className="together-section" aria-label="Requests">
      <h3 className="section-title">Asking to join your plans</h3>
      {mine.length === 0 ? (
        <EmptyState text="No pending requests. We'll let you know when someone wants to join your plan." />
      ) : (
        <ul className="plan-list">
          {mine.map((n) => (
            <li key={n.id} className="plan-card">
              <div className="pc-top">
                <span className="pc-owner">
                  <strong>{n.title}</strong>
                </span>
                <span className="pc-seen">{planWhen(n, today)}</span>
              </div>
              <RequestsFor
                note={n}
                today={today}
                onJoined={onJoined}
                notify={notify}
                onDone={() => {
                  onChanged?.();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <h3 className="section-title">Plans you asked to join</h3>
      {asked.length === 0 ? (
        <EmptyState
          text="You haven't asked to join anything. Plans your people share are in Discover."
          action={
            <button type="button" className="ghost" onClick={onDiscover}>
              Open Discover
            </button>
          }
        />
      ) : (
        <ul className="plan-list">
          {asked.map((n) => (
            <PlanCard key={n.id} note={n} today={today} {...joinParts(n, () => undefined, () => void cancel(n), busy === n.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** My plans: what you shared (or kept private), who's going, who's asking, and who can see it. */
export function MyPlansSection({
  today,
  blocks,
  notify,
  onInvite,
  onJoined,
  shareNew,
}: {
  today: string;
  blocks: StoredBlock[];
  notify: (t: string) => void;
  onInvite: (note: NoteView, people: PublicProfile[]) => void;
  onJoined?: (inv: InvitationView[]) => void;
  /** bumped by the page's "Share a plan" button */
  shareNew: number;
}) {
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [state, setState] = useState<Load>('loading');
  const [editing, setEditing] = useState<NoteView | 'new' | null>(null);
  const [requestsOf, setRequestsOf] = useState<NoteView | null>(null);
  const [archived, setArchived] = useState(false);
  const load = useCallback(async () => {
    try {
      setNotes((await listNotes('mine', { archived })).notes);
      setState('ready');
    } catch (e) {
      setState(isOffline(e) ? 'offline' : 'error');
    }
  }, [archived]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (shareNew) setEditing('new');
  }, [shareNew]);

  async function stopSharing(n: NoteView) {
    try {
      const r = await updateNote(n.id, { visibility: 'private' });
      setNotes((list) => list.map((x) => (x.id === n.id ? r.note : x)));
      notify(`“${n.title}” is private again. People who could see it no longer can.`);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Couldn't change that just now. Try again.");
    }
  }

  if (state !== 'ready' && !editing) return <LoadState state={state as 'loading' | 'error' | 'offline'} what="your plans" onRetry={() => void load()} />;
  return (
    <section className="together-section" aria-label="My plans">
      <label className="check small">
        <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        <span>Show archived</span>
      </label>
      {notes.length === 0 ? (
        <EmptyState
          text="You haven't shared a plan yet. Share one and the people you choose can ask to join."
          action={
            <button type="button" className="primary" onClick={() => setEditing('new')}>
              Share a plan
            </button>
          }
        />
      ) : (
        <ul className="plan-list">
          {notes.map((n) => {
            const waiting = n.pendingCount ?? 0;
            const going = n.goingCount ?? 0;
            const parts = [going ? `${going} going` : null, waiting ? `${waiting} asking` : null].filter(Boolean);
            return (
              <PlanCard
                key={n.id}
                note={n}
                today={today}
                status={<span className="muted small">{parts.length ? parts.join(' · ') : n.visibility === 'private' ? 'Not shared' : n.openToJoin ? 'No requests yet' : 'Not taking join requests'}</span>}
                primary={
                  waiting > 0 ? (
                    <button type="button" className="primary small-button" onClick={() => setRequestsOf(n)}>
                      Review requests
                    </button>
                  ) : (
                    <button type="button" className="ghost small-button" onClick={() => setEditing(n)}>
                      Edit
                    </button>
                  )
                }
                menu={
                  <MoreMenu
                    label={`More options for ${n.title}`}
                    items={[
                      ...(waiting > 0 ? [{ label: 'Edit', run: () => setEditing(n) }] : []),
                      { label: 'Invite people', run: () => onInvite(n, []) },
                      ...(n.visibility !== 'private' ? [{ label: 'Stop sharing', run: () => void stopSharing(n) }] : []),
                    ]}
                  />
                }
              />
            );
          })}
        </ul>
      )}
      {editing && (
        <ShareSheet
          note={editing === 'new' ? null : editing}
          today={today}
          blocks={blocks}
          onClose={() => setEditing(null)}
          onSaved={(n, created) => {
            setEditing(null);
            setNotes((list) => (created ? [n, ...list] : list.map((x) => (x.id === n.id ? n : x))));
            notify(created ? (n.visibility === 'private' ? 'Saved. Only you can see it.' : 'Plan shared.') : 'Plan updated.');
          }}
          onDeleted={(id) => {
            setEditing(null);
            setNotes((list) => list.filter((x) => x.id !== id));
            notify('Plan deleted.');
          }}
        />
      )}
      {requestsOf && (
        <InterestsSheet
          note={requestsOf}
          today={today}
          onClose={() => {
            setRequestsOf(null);
            void load();
          }}
          onJoined={onJoined}
          notify={notify}
        />
      )}
    </section>
  );
}

/**
 * Share a plan (or edit one): what, when, where, then who can see it and
 * whether they may ask to join. Inviting specific people is separate (Invitations).
 */
export function ShareSheet({
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
  const [startTime, setStartTime] = useState(note?.startTime ?? '');
  const [endTime, setEndTime] = useState(note?.endTime ?? '');
  const [placeName, setPlaceName] = useState(note?.placeName ?? '');
  const [blockId, setBlockId] = useState(note?.blockId ?? '');
  const [visibility, setVisibility] = useState<Visibility>(note?.visibility ?? 'selected');
  const [people, setPeople] = useState<PublicProfile[]>(note?.sharedWith ?? []);
  const [pinned, setPinned] = useState(!!note?.pinned);
  const [openToJoin, setOpenToJoin] = useState(note?.openToJoin ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cid] = useState(clientId);
  const linkable = blocks.filter((b) => b.active && (!b.date || b.date >= today));

  /** Start from one of your own plans: its name, day and set time fill in (nothing about it is shared until you save). */
  function pick(id: string) {
    setBlockId(id);
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    if (!title.trim()) setTitle(b.title);
    if (!onDate && b.date) setOnDate(b.date);
    if (!startTime && b.fixedStart) {
      setStartTime(b.fixedStart);
      setEndTime(b.fixedEnd ?? '');
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (visibility === 'selected' && people.length === 0) return setError('Choose at least one person, or keep it private.');
    if (endTime && !startTime) return setError('Add a start time before an end time.');
    if (endTime && startTime && endTime <= startTime) return setError('The end time needs to be after the start time.');
    setBusy(true);
    setError(null);
    const input = {
      title: title.trim(),
      body: body.trim(),
      onDate: onDate || null,
      startTime: onDate && startTime ? startTime : null,
      endTime: onDate && startTime && endTime ? endTime : null,
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
    <Sheet title={note ? 'Edit plan' : 'Share a plan'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void save(e)}>
        {!note && linkable.length > 0 && (
          <label className="field">
            <span>Start from one of your plans (optional)</span>
            <select value={blockId} onChange={(e) => pick(e.target.value)}>
              <option value="">Something new</option>
              {linkable.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                  {b.date ? ` (${dayWords(b.date, today)})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>What</span>
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Study session at a café" />
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Working on our programming project" />
        </label>
        <div className="pair">
          <label className="field">
            <span>Day (optional)</span>
            <input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Place (optional)</span>
            <input maxLength={120} value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Café near campus" />
          </label>
        </div>
        {onDate && (
          <div className="pair">
            <label className="field">
              <span>From (optional)</span>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label className="field">
              <span>Until (optional)</span>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={!startTime} />
            </label>
          </div>
        )}

        <fieldset className="field share-who">
          <legend>Who can see it</legend>
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
              ? 'Nobody else can see it. You can share it later.'
              : visibility === 'selected'
                ? 'Only the people you choose. Your other plans, calendar and location stay private.'
                : 'Anyone who can find your profile. Your other plans, calendar and location stay private.'}
          </p>
          {visibility === 'selected' && <PeoplePicker label="Share with" selected={people} onChange={setPeople} />}
        </fieldset>
        {visibility !== 'private' && (
          <label className="check">
            <input type="checkbox" checked={openToJoin} onChange={(e) => setOpenToJoin(e.target.checked)} />
            <span>
              Let them ask to join
              <span className="muted small block">{openToJoin ? 'They can ask “Can I join?”. Nothing is agreed until you say yes.' : 'They can see it, but not ask to join.'}</span>
            </span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>Keep it at the top of My plans</span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Saving…' : note ? 'Save changes' : visibility === 'private' ? 'Save privately' : 'Share plan'}
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
        {note && confirmDelete && <p className="muted small">Requests to join go too. Plans you already agreed with people stay.</p>}
      </form>
    </Sheet>
  );
}
