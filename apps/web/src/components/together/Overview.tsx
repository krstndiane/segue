/**
 * Together at a glance: what needs your answer, plans you've agreed with
 * people, and plans your people shared that you can ask to join. Only what
 * the server let you see; nothing is filled in to look busy.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NoteView, PublicProfile } from '@segue/schemas';
import type { CalendarEvent } from '../../lib/calendar';
import { localDate } from '../../lib/model';
import { ApiError, isOffline, listNotes, unheartNote } from '../../lib/social';
import { overview } from '../../lib/togetherOverview';
import type { Together } from '../../lib/useTogether';
import { whenWords } from '../../lib/when';
import { Avatar } from '../Account';
import type { TogetherTab } from './TogetherPage';
import { EmptyState, InterestsSheet, JoinSheet, LoadState, planWhen } from './Plans';

interface Props {
  today: string;
  together: Together;
  eventsOn: (date: string) => CalendarEvent[];
  notify: (text: string) => void;
  onOpenInvitation: (id: string) => void;
  onShare: () => void;
  onFindPeople: () => void;
  onTab: (t: TogetherTab) => void;
}

const names = (people: PublicProfile[]) => (people.length <= 2 ? people.map((p) => p.displayName).join(' and ') : `${people[0]!.displayName} and ${people.length - 1} others`);

export function OverviewSection(props: Props) {
  const { together: t } = props;
  const [mine, setMine] = useState<NoteView[]>([]);
  const [others, setOthers] = useState<NoteView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'offline'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [requestsOf, setRequestsOf] = useState<NoteView | null>(null);
  const [asking, setAsking] = useState<NoteView | null>(null);

  const load = useCallback(async () => {
    try {
      const [m, shared, discover] = await Promise.all([listNotes('mine'), listNotes('shared'), listNotes('discover')]);
      setMine(m.notes);
      setOthers([...shared.notes, ...discover.notes]);
      setState('ready');
    } catch (e) {
      setState(isOffline(e) ? 'offline' : 'error');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const o = overview({ invitations: t.invitations, mine, others, today: props.today, now: Date.now(), eventsOn: props.eventsOn, localDate });
  const replace = (n: NoteView) => setOthers((list) => list.map((x) => (x.id === n.id ? n : x)));

  async function cancel(n: NoteView) {
    setBusy(n.id);
    try {
      await unheartNote(n.id);
      replace({ ...n, hearted: false, interest: 'withdrawn' });
      props.notify('Request taken back.');
    } catch (e) {
      props.notify(e instanceof ApiError ? e.message : "Couldn't send that just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading' && !t.loaded) return <LoadState state="loading" what="Together" onRetry={() => void load()} />;
  if (state === 'offline' || state === 'error') return <LoadState state={state} what="Together" onRetry={() => void load()} />;

  const empty = !o.toAnswer.length && !o.requests.length && !o.together.length && !o.joinable.length && !o.asked.length;

  return (
    <section className="together-section overview" aria-label="Overview">
      {/* At a glance: each count opens its section. */}
      <ul className="tg-summary">
        <li>
          <button type="button" onClick={() => props.onTab('invites')}>
            <strong>{o.toAnswer.length}</strong>
            <span>{o.toAnswer.length === 1 ? 'invitation to answer' : 'invitations to answer'}</span>
          </button>
        </li>
        <li>
          <button type="button" onClick={() => props.onTab('requests')}>
            <strong>{o.requests.reduce((s, n) => s + (n.pendingCount ?? 0), 0)}</strong>
            <span>asking to join your plans</span>
          </button>
        </li>
        <li>
          <button type="button" onClick={() => props.onTab('people')}>
            <strong>{t.connections?.mutuals.length ?? 0}</strong>
            <span>{(t.connections?.mutuals.length ?? 0) === 1 ? 'connection' : 'connections'}</span>
          </button>
        </li>
      </ul>

      {empty && (
        <EmptyState
          text="Nothing planned with anyone yet. Share a plan with people you trust, or find the people you plan with."
          action={
            <div className="row-actions">
              <button type="button" className="primary" onClick={props.onShare}>
                Share a plan
              </button>
              <button type="button" className="ghost" onClick={props.onFindPeople}>
                Find people
              </button>
            </div>
          }
        />
      )}

      {(o.toAnswer.length > 0 || o.requests.length > 0) && (
        <div className="ov-group">
          <h3 className="ov-head">Needs your answer</h3>
          <ul className="ov-list">
            {o.toAnswer.map((i) => (
              <li key={i.id} className="ov-row">
                <Avatar person={i.sender} size={36} />
                <div className="ov-text">
                  <strong>
                    {i.sender.displayName} invited you to {i.activity.title}
                  </strong>
                  <span className="muted small block">{whenWords(i.activity.startsAt, i.activity.endsAt, props.today)}</span>
                </div>
                <button type="button" className="primary small-button" onClick={() => props.onOpenInvitation(i.id)}>
                  Answer
                </button>
              </li>
            ))}
            {o.requests.map((n) => (
              <li key={n.id} className="ov-row">
                <span className="ov-count" aria-hidden="true">
                  {n.pendingCount}
                </span>
                <div className="ov-text">
                  <strong>
                    {n.pendingCount === 1 ? '1 person' : `${n.pendingCount} people`} asked to join {n.title}
                  </strong>
                  <span className="muted small block">Nothing is agreed until you say yes.</span>
                </div>
                <button type="button" className="primary small-button" onClick={() => setRequestsOf(n)}>
                  Review
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {o.together.length > 0 && (
        <div className="ov-group">
          <h3 className="ov-head">Plans together</h3>
          <ul className="ov-list">
            {o.together.map(({ invitation: i, with: people, clashes }) => (
              <li key={i.activity.id} className="ov-row">
                <Avatar person={people[0]!} size={36} />
                <div className="ov-text">
                  <strong>{i.activity.title}</strong>
                  <span className="small block">
                    With {names(people)} · {i.activity.startsAt ? whenWords(i.activity.startsAt, i.activity.endsAt, props.today) : 'time not set yet'}
                    {i.activity.placeName ? ` · ${i.activity.placeName}` : ''}
                  </span>
                  {clashes.length > 0 && <span className="small block warn-text">Clashes with {clashes.join(', ')} in your calendar</span>}
                </div>
                <button type="button" className="ghost small-button" onClick={() => props.onOpenInvitation(i.id)}>
                  Details
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(o.joinable.length > 0 || o.asked.length > 0) && (
        <div className="ov-group">
          <h3 className="ov-head">Your people’s plans</h3>
          <ul className="ov-list">
            {[...o.asked, ...o.joinable].slice(0, 3).map((n) => (
              <li key={n.id} className="ov-row">
                <Avatar person={n.author} size={36} />
                <div className="ov-text">
                  <strong>
                    {n.author.displayName}: {n.title}
                  </strong>
                  <span className="muted small block">{[planWhen(n, props.today), n.placeName].filter(Boolean).join(' · ')}</span>
                </div>
                {n.interest === 'interested' ? (
                  <button type="button" className="text-button" disabled={busy === n.id} onClick={() => void cancel(n)} aria-label={`Cancel your request to join ${n.title}`}>
                    Cancel request
                  </button>
                ) : (
                  <button type="button" className="ghost small-button" disabled={busy === n.id} onClick={() => setAsking(n)}>
                    Can I join?
                  </button>
                )}
              </li>
            ))}
          </ul>
          {o.asked.length + o.joinable.length > 3 && (
            <button type="button" className="text-button" onClick={() => props.onTab('discover')}>
              See all {o.asked.length + o.joinable.length} in Discover
            </button>
          )}
        </div>
      )}

      {asking && (
        <JoinSheet
          note={asking}
          today={props.today}
          onClose={() => setAsking(null)}
          onSent={(n) => {
            setAsking(null);
            replace(n);
            props.notify(`Asked ${n.author.displayName}. Nothing is agreed until they say yes.`);
          }}
        />
      )}
      {requestsOf && (
        <InterestsSheet
          note={requestsOf}
          today={props.today}
          onClose={() => {
            setRequestsOf(null);
            void load();
          }}
          onJoined={t.upsert}
          notify={props.notify}
        />
      )}
    </section>
  );
}
