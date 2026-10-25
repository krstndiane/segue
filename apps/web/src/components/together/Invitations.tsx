/**
 * Invitations you've received and sent. Each person answers for themselves;
 * accepting never changes your plan. "Add to my day" is a separate choice,
 * and Segue shows what it overlaps first.
 */
import { useMemo, useState, type FormEvent } from 'react';
import type { InvitationStatus, InvitationView, PublicProfile } from '@segue/schemas';
import type { CalendarEvent } from '../../lib/calendar';
import { activityBlock, activityBlockId, conflictsFor, outOfDate } from '../../lib/invitePlan';
import type { StoredBlock } from '../../lib/model';
import {
  ApiError,
  acceptInvitation,
  cancelInvitation,
  clientId,
  declineInvitation,
  editInvitation,
  sendInvitation,
  suggestTime,
} from '../../lib/social';
import { deviceTimeZone, fromIso, toIso, whenWords } from '../../lib/when';
import { Sheet } from '../Sheet';
import { PeoplePicker, PersonLine } from './People';

const STATUS_WORDS: Record<InvitationStatus, string> = {
  pending: 'Waiting for an answer',
  accepted: 'Going',
  declined: "Can't make it",
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const CHANGE_WORDS: Record<string, string> = { time: 'the time', place: 'the place', details: 'the details' };

const HOUR = 3_600_000;
const isPast = (i: InvitationView, now: number) => {
  const end = i.activity.endsAt ?? i.activity.startsAt;
  return !!end && Date.parse(end) < now - HOUR;
};

export interface InviteDraft {
  title: string;
  description?: string;
  people: PublicProfile[];
  sourceNoteId?: string;
  placeName?: string | null;
  date?: string | null;
}

interface SectionProps {
  invitations: InvitationView[];
  blocks: StoredBlock[];
  eventsOn: (date: string) => CalendarEvent[];
  onChanged: (list: InvitationView[]) => void;
  /** add (or update) the activity in your own plan */
  onAddToDay: (block: StoredBlock) => void;
  /** no fixed time yet: plan it yourself with the usual form */
  onPlanLater: (title: string) => void;
  onNew: () => void;
  notify: (text: string) => void;
  highlight?: string;
}

export function InvitationsSection(props: SectionProps) {
  const { invitations } = props;
  const [editing, setEditing] = useState<InvitationView | null>(null);
  const [countering, setCountering] = useState<InvitationView | null>(null);
  const now = Date.now();

  const received = invitations.filter((i) => i.direction === 'received');
  const waiting = received.filter((i) => i.status === 'pending' && i.activity.status === 'active' && !isPast(i, now));
  const going = received.filter((i) => i.status === 'accepted' && i.activity.status === 'active' && !isPast(i, now));
  const closed = received.filter((i) => !waiting.includes(i) && !going.includes(i));

  // Sent: one card per activity, with everyone's answer.
  const sent = useMemo(() => {
    const groups = new Map<string, InvitationView[]>();
    for (const i of invitations.filter((x) => x.direction === 'sent')) groups.set(i.activity.id, [...(groups.get(i.activity.id) ?? []), i]);
    return [...groups.values()];
  }, [invitations]);
  const sentOpen = sent.filter((g) => g[0]!.activity.status === 'active' && !isPast(g[0]!, now));
  const sentPast = sent.filter((g) => !sentOpen.includes(g));

  async function act(fn: () => Promise<{ invitation?: InvitationView; invitations?: InvitationView[] }>, done: string) {
    try {
      const r = await fn();
      props.onChanged(r.invitations ?? (r.invitation ? [r.invitation] : []));
      props.notify(done);
    } catch (e) {
      props.notify(e instanceof ApiError ? e.message : "Couldn't do that just now. Try again.");
    }
  }

  const empty = invitations.length === 0;
  return (
    <section className="together-section" aria-label="Invitations">
      <div className="panel-row">
        <p className="muted small">Invite people to something, or answer what you've been invited to.</p>
        <button type="button" className="primary" onClick={props.onNew}>
          Invite people
        </button>
      </div>
      {empty && <p className="empty muted">No invitations yet. Heart a note to say you'd like to join, or invite someone yourself.</p>}

      {waiting.length > 0 && (
        <InviteGroup title="Waiting for you">
          {waiting.map((i) => (
            <ReceivedCard key={i.id} inv={i} {...props} act={act} onCounter={() => setCountering(i)} />
          ))}
        </InviteGroup>
      )}
      {going.length > 0 && (
        <InviteGroup title="You're going">
          {going.map((i) => (
            <ReceivedCard key={i.id} inv={i} {...props} act={act} onCounter={() => setCountering(i)} />
          ))}
        </InviteGroup>
      )}
      {sentOpen.length > 0 && (
        <InviteGroup title="You invited">
          {sentOpen.map((g) => (
            <SentCard key={g[0]!.activity.id} group={g} act={act} onEdit={() => setEditing(g[0]!)} highlight={props.highlight} />
          ))}
        </InviteGroup>
      )}
      {(closed.length > 0 || sentPast.length > 0) && (
        <details className="past-invites">
          <summary>Past and closed ({closed.length + sentPast.length})</summary>
          <ul className="invite-list">
            {closed.map((i) => (
              <ReceivedCard key={i.id} inv={i} {...props} act={act} onCounter={() => setCountering(i)} />
            ))}
            {sentPast.map((g) => (
              <SentCard key={g[0]!.activity.id} group={g} act={act} onEdit={() => setEditing(g[0]!)} />
            ))}
          </ul>
        </details>
      )}

      {editing && (
        <InviteSheet
          editing={editing}
          draft={{ title: editing.activity.title, people: [] }}
          onClose={() => setEditing(null)}
          onSent={(list) => {
            setEditing(null);
            props.onChanged(list);
            props.notify('Invitation updated. Everyone invited will see what changed.');
          }}
        />
      )}
      {countering && (
        <CounterSheet
          inv={countering}
          onClose={() => setCountering(null)}
          onDone={(inv) => {
            setCountering(null);
            props.onChanged([inv]);
            props.notify(`${inv.sender.displayName} will see your suggestion.`);
          }}
        />
      )}
    </section>
  );
}

function InviteGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="invite-group">
      <h3 className="section-title">{title}</h3>
      <ul className="invite-list">{children}</ul>
    </section>
  );
}

function Where({ inv }: { inv: InvitationView }) {
  const a = inv.activity;
  return (
    <>
      <p className="invite-when">{whenWords(a.startsAt, a.endsAt)}</p>
      {a.placeName && <p className="muted small">{a.placeName}</p>}
      {a.description && <p className="small">{a.description}</p>}
      {a.meetingNotes && <p className="muted small">Meeting: {a.meetingNotes}</p>}
    </>
  );
}

function ReceivedCard({
  inv,
  blocks,
  eventsOn,
  onAddToDay,
  onPlanLater,
  act,
  onCounter,
  highlight,
}: SectionProps & {
  inv: InvitationView;
  act: (fn: () => Promise<{ invitation?: InvitationView }>, done: string) => Promise<void>;
  onCounter: () => void;
}) {
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const status = inv.activity.status === 'cancelled' ? 'cancelled' : inv.status;
  const block = activityBlock(inv.activity);
  const existing = blocks.find((b) => b.id === activityBlockId(inv.activity.id));
  const stale = existing ? outOfDate(existing, inv.activity) : false;

  function addToDay() {
    if (!block) return;
    const clash = conflictsFor(block, blocks, eventsOn(block.date!));
    if (clash.length && conflicts === null) {
      setConflicts(clash);
      return;
    }
    setConflicts(null);
    onAddToDay(block);
  }

  return (
    <li className={`invite-card${highlight === inv.id ? ' highlight' : ''}`} id={`inv-${inv.id}`}>
      <PersonLine person={inv.sender} extra="invited you" />
      <h4 className="note-title">{inv.activity.title}</h4>
      <Where inv={inv} />
      {inv.changedFields.length > 0 && status === 'pending' && (
        <p className="notice small">
          {inv.sender.displayName} changed {inv.changedFields.map((f) => CHANGE_WORDS[f] ?? f).join(' and ')}. Take a look and answer again.
        </p>
      )}
      {inv.counter && <p className="muted small">You suggested {whenWords(inv.counter.startsAt, inv.counter.endsAt)}.</p>}
      <p className={`invite-status s-${status}`}>{status === 'cancelled' ? `Cancelled by ${inv.sender.displayName}` : STATUS_WORDS[status]}</p>

      {conflicts && (
        <div className="notice" role="alert">
          <p>
            This overlaps with {conflicts.join(', ')}. Add it anyway? Your other plans won't move until you re-route.
          </p>
          <div className="row-actions">
            <button type="button" className="primary" onClick={addToDay}>
              Add anyway
            </button>
            <button type="button" className="ghost" onClick={() => setConflicts(null)}>
              Not now
            </button>
          </div>
        </div>
      )}

      <div className="row-actions">
        {status === 'pending' && (
          <>
            <button type="button" className="primary" onClick={() => void act(() => acceptInvitation(inv.id), `You're going. ${inv.sender.displayName} will know.`)}>
              Accept
            </button>
            <button type="button" className="ghost" onClick={() => void act(() => declineInvitation(inv.id), 'Declined.')}>
              Decline
            </button>
            <button type="button" className="text-button" onClick={onCounter}>
              Suggest another time
            </button>
          </>
        )}
        {status === 'accepted' && !conflicts && (
          <>
            {block && !existing && (
              <button type="button" className="primary" onClick={addToDay}>
                Add to my day
              </button>
            )}
            {block && existing && stale && (
              <button type="button" className="primary" onClick={addToDay}>
                Update in my day
              </button>
            )}
            {block && existing && !stale && <span className="chip static">In your plan</span>}
            {!block && (
              <button type="button" className="ghost" onClick={() => onPlanLater(inv.activity.title)}>
                Plan it in my day
              </button>
            )}
            <button type="button" className="text-button" onClick={onCounter}>
              Suggest another time
            </button>
            <button type="button" className="text-button" onClick={() => void act(() => declineInvitation(inv.id), `${inv.sender.displayName} will know you can't make it.`)}>
              Can't make it
            </button>
          </>
        )}
        {status === 'declined' && inv.activity.status === 'active' && inv.status !== 'expired' && (
          <button type="button" className="text-button" onClick={() => void act(() => acceptInvitation(inv.id), "You're going after all.")}>
            Changed my mind: accept
          </button>
        )}
      </div>
    </li>
  );
}

function SentCard({
  group,
  act,
  onEdit,
  highlight,
}: {
  group: InvitationView[];
  act: (fn: () => Promise<{ invitation?: InvitationView; invitations?: InvitationView[] }>, done: string) => Promise<void>;
  onEdit: () => void;
  highlight?: string;
}) {
  const first = group[0]!;
  const active = first.activity.status === 'active';
  const counts = group.reduce<Record<string, number>>((c, i) => ((c[i.status] = (c[i.status] ?? 0) + 1), c), {});
  const summary = [counts.accepted && `${counts.accepted} going`, counts.pending && `${counts.pending} waiting`, counts.declined && `${counts.declined} can't`]
    .filter(Boolean)
    .join(' · ');
  const [confirm, setConfirm] = useState(false);

  return (
    <li className={`invite-card${group.some((g) => g.id === highlight) ? ' highlight' : ''}`} id={`inv-${first.id}`}>
      <h4 className="note-title">{first.activity.title}</h4>
      <Where inv={first} />
      <p className="invite-status">{active ? summary || 'Sent' : 'Cancelled'}</p>
      <ul className="people-list">
        {group.map((i) => (
          <li key={i.id} id={`inv-${i.id}`}>
            <PersonLine person={i.recipient} extra={STATUS_WORDS[i.status]} />
            {active && (i.status === 'pending' || i.status === 'accepted') && (
              <button type="button" className="text-button" onClick={() => void act(() => cancelInvitation(i.id), `Cancelled for ${i.recipient.displayName}.`)}>
                Cancel
              </button>
            )}
            {i.counter && active && (
              <p className="counter small">
                Suggested {whenWords(i.counter.startsAt, i.counter.endsAt)}
                {i.counter.note ? `: “${i.counter.note}”` : ''}{' '}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const keep = first.activity.startsAt && first.activity.endsAt ? Date.parse(first.activity.endsAt) - Date.parse(first.activity.startsAt) : null;
                    const endsAt = i.counter!.endsAt ?? (keep ? new Date(Date.parse(i.counter!.startsAt) + keep).toISOString() : null);
                    void act(() => editInvitation(i.id, { startsAt: i.counter!.startsAt, endsAt }), 'Time changed. Everyone invited will be asked to confirm.');
                  }}
                >
                  Use this time
                </button>
              </p>
            )}
          </li>
        ))}
      </ul>
      {active && (
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onEdit}>
            Change details
          </button>
          {!confirm ? (
            <button type="button" className="text-button" onClick={() => setConfirm(true)}>
              Cancel for everyone…
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => void act(() => cancelInvitation(first.id, true), 'Cancelled. Everyone invited will know.')}>
              Yes, cancel it
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Invite people (new), or change what you sent (editing). */
export function InviteSheet({
  draft,
  editing,
  onClose,
  onSent,
}: {
  draft: InviteDraft;
  editing?: InvitationView;
  onClose: () => void;
  onSent: (list: InvitationView[]) => void;
}) {
  const start = fromIso(editing?.activity.startsAt);
  const end = fromIso(editing?.activity.endsAt);
  const [people, setPeople] = useState<PublicProfile[]>(draft.people);
  const [title, setTitle] = useState(editing?.activity.title ?? draft.title);
  const [description, setDescription] = useState(editing?.activity.description ?? draft.description ?? '');
  const [date, setDate] = useState(start.date || draft.date || '');
  const [from, setFrom] = useState(start.time);
  const [to, setTo] = useState(end.time);
  const [placeName, setPlaceName] = useState(editing?.activity.placeName ?? draft.placeName ?? '');
  const [meetingNotes, setMeetingNotes] = useState(editing?.activity.meetingNotes ?? '');
  const [answerBy, setAnswerBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cid] = useState(clientId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!editing && people.length === 0) return setError('Choose who to invite.');
    if (date && !from) return setError('Add a start time, or clear the day to leave the time open.');
    if (!date && (from || to)) return setError('Pick a day for that time.');
    const startsAt = date ? toIso(date, from) : null;
    const endsAt = date && to ? toIso(date, to) : null;
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return setError('The end has to be after the start.');
    setBusy(true);
    try {
      const details = { title: title.trim(), description: description.trim(), startsAt, endsAt, timezone: deviceTimeZone(), placeName: placeName.trim() || null, meetingNotes: meetingNotes.trim() };
      const res = editing
        ? await editInvitation(editing.id, details)
        : await sendInvitation({
            ...details,
            recipientIds: people.map((p) => p.id),
            sourceNoteId: draft.sourceNoteId,
            expiresAt: answerBy ? new Date(Date.now() + Number(answerBy) * 86_400_000).toISOString() : undefined,
            clientId: cid,
          });
      onSent(res.invitations);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send just now. Try again.");
      setBusy(false);
    }
  }

  return (
    <Sheet title={editing ? 'Change invitation' : 'Invite people'} onClose={onClose}>
      <form className="form" onSubmit={(e) => void submit(e)}>
        {!editing && <PeoplePicker label="Who" selected={people} onChange={setPeople} />}
        {editing && <p className="muted small">Everyone you invited sees what changed. A new time or place asks people who said yes to confirm again.</p>}
        <label className="field">
          <span>What</span>
          <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>Day (leave empty to decide together)</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {date && (
          <div className="pair">
            <label className="field">
              <span>From</span>
              <input type="time" required value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>Until (optional)</span>
              <input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}
        <label className="field">
          <span>Where (optional)</span>
          <input maxLength={120} value={placeName} onChange={(e) => setPlaceName(e.target.value)} />
        </label>
        <label className="field">
          <span>How to meet (optional)</span>
          <input maxLength={500} value={meetingNotes} onChange={(e) => setMeetingNotes(e.target.value)} placeholder="Meet at the main entrance" />
        </label>
        {!editing && (
          <label className="field">
            <span>Answer by</span>
            <select value={answerBy} onChange={(e) => setAnswerBy(e.target.value)}>
              <option value="">No deadline</option>
              <option value="1">Tomorrow</option>
              <option value="3">In 3 days</option>
              <option value="7">In a week</option>
            </select>
          </label>
        )}
        <p className="muted small">They see this invitation only: never your plan, your notes or where you are.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Sending…' : editing ? 'Save changes' : people.length > 1 ? `Invite ${people.length} people` : 'Send invitation'}
        </button>
      </form>
    </Sheet>
  );
}

function CounterSheet({ inv, onClose, onDone }: { inv: InvitationView; onClose: () => void; onDone: (inv: InvitationView) => void }) {
  const s = fromIso(inv.activity.startsAt);
  const e = fromIso(inv.activity.endsAt);
  const [date, setDate] = useState(s.date);
  const [from, setFrom] = useState(s.time);
  const [to, setTo] = useState(e.time);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const startsAt = toIso(date, from);
    if (!startsAt) return setError('Pick a day and a start time.');
    const endsAt = to ? toIso(date, to) : null;
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return setError('The end has to be after the start.');
    setBusy(true);
    try {
      onDone((await suggestTime(inv.id, { startsAt, endsAt, note: note.trim() || undefined })).invitation);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send just now. Try again.");
      setBusy(false);
    }
  }

  return (
    <Sheet title="Suggest another time" onClose={onClose}>
      <form className="form" onSubmit={(ev) => void submit(ev)}>
        <p className="muted small">{inv.sender.displayName} decides whether to change it. Your answer stays as it is until then.</p>
        <label className="field">
          <span>Day</span>
          <input type="date" required value={date} onChange={(ev) => setDate(ev.target.value)} />
        </label>
        <div className="pair">
          <label className="field">
            <span>From</span>
            <input type="time" required value={from} onChange={(ev) => setFrom(ev.target.value)} />
          </label>
          <label className="field">
            <span>Until (optional)</span>
            <input type="time" value={to} onChange={(ev) => setTo(ev.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Note (optional)</span>
          <input maxLength={300} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Could we start a bit later?" />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? 'Sending…' : 'Send suggestion'}
        </button>
      </form>
    </Sheet>
  );
}
