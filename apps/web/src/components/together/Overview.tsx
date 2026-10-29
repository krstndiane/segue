/**
 * Together at a glance: what needs your answer, plans you've agreed with
 * people, and plans your people shared that you can ask to join. Only what
 * the server let you see; nothing is filled in to look busy.
 */
import { useCallback, useEffect, useState } from 'react';
import type { NoteView, PublicProfile } from '@segue/schemas';
import type { CalendarEvent } from '../../lib/calendar';
import { localDate } from '../../lib/model';
import { ApiError, heartNote, isOffline, listNotes, unheartNote } from '../../lib/social';
import { overview } from '../../lib/togetherOverview';
import type { Together } from '../../lib/useTogether';
import { dayWords, whenWords } from '../../lib/when';
import { Avatar } from '../Account';
import { InterestsSheet } from './Notes';

interface Props {
  today: string;
  together: Together;
  eventsOn: (date: string) => CalendarEvent[];
  notify: (text: string) => void;
  onOpenInvitation: (id: string) => void;
  onInvite: (note: NoteView, people: PublicProfile[]) => void;
  onNewNote: () => void;
  onFindPeople: () => void;
}

const names = (people: PublicProfile[]) => (people.length <= 2 ? people.map((p) => p.displayName).join(' and ') : `${people[0]!.displayName} and ${people.length - 1} others`);

export function OverviewSection(props: Props) {
  const { together: t } = props;
  const [mine, setMine] = useState<NoteView[]>([]);
  const [others, setOthers] = useState<NoteView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'offline'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [requestsOf, setRequestsOf] = useState<NoteView | null>(null);

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

  async function ask(n: NoteView, on: boolean) {
    setBusy(n.id);
    try {
      if (on) {
        replace((await heartNote(n.id)).note);
        props.notify(`Asked ${n.author.displayName}. Nothing is agreed until they say yes.`);
      } else {
        await unheartNote(n.id);
        replace({ ...n, hearted: false, interest: 'withdrawn' });
      }
    } catch (e) {
      props.notify(e instanceof ApiError ? e.message : "Couldn't send that just now. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (state === 'loading' && !t.loaded) return <p className="muted">Loading…</p>;
  if (state === 'offline' || state === 'error') {
    return (
      <section className="together-section" aria-label="Overview">
        <p className="error">{state === 'offline' ? "You're offline, so Together can't load. Your own plan still works." : "Couldn't load Together just now."}</p>
        <button type="button" className="ghost" onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }

  const empty = !o.toAnswer.length && !o.requests.length && !o.together.length && !o.joinable.length && !o.asked.length;

  return (
    <section className="together-section overview" aria-label="Overview">
      {empty && (
        <div className="panel">
          <p className="lede">Nothing here yet.</p>
          <p className="muted">When your mutuals share plans with you, they show up here, and you can ask to join. Share one of yours to get started.</p>
          <div className="row-actions">
            <button type="button" className="primary" onClick={props.onNewNote}>
              Share a plan
            </button>
            <button type="button" className="ghost" onClick={props.onFindPeople}>
              Find people
            </button>
          </div>
        </div>
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
                <button type="button" className="ghost small-button" onClick={() => props.onOpenInvitation(i.id)}>
                  Answer
                </button>
              </li>
            ))}
            {o.requests.map((n) => (
              <li key={n.id} className="ov-row">
                <span className="ov-count" aria-hidden="true">
                  {n.heartCount}
                </span>
                <div className="ov-text">
                  <strong>
                    {n.heartCount === 1 ? '1 person' : `${n.heartCount} people`} asked to join {n.title}
                  </strong>
                  <span className="muted small block">Nothing is agreed until you say yes.</span>
                </div>
                <button type="button" className="ghost small-button" onClick={() => setRequestsOf(n)}>
                  See who
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
            {[...o.asked, ...o.joinable].map((n) => (
              <li key={n.id} className="ov-row">
                <Avatar person={n.author} size={36} />
                <div className="ov-text">
                  <strong>
                    {n.author.displayName}: {n.title}
                  </strong>
                  <span className="muted small block">{[n.onDate ? dayWords(n.onDate, props.today) : 'Any day', n.placeName].filter(Boolean).join(' · ')}</span>
                </div>
                {n.interest === 'interested' ? (
                  <button type="button" className="heart on" aria-pressed="true" disabled={busy === n.id} onClick={() => void ask(n, false)} aria-label={`You asked to join ${n.title}. Tap to take it back`}>
                    Asked · waiting for {n.author.displayName}
                  </button>
                ) : (
                  <button type="button" className="heart" aria-pressed="false" disabled={busy === n.id} onClick={() => void ask(n, true)}>
                    Can I join?
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {requestsOf && (
        <InterestsSheet
          note={requestsOf}
          onClose={() => {
            setRequestsOf(null);
            void load();
          }}
          onInvite={(people) => {
            setRequestsOf(null);
            props.onInvite(requestsOf, people);
          }}
          onJoined={t.upsert}
          notify={props.notify}
        />
      )}
    </section>
  );
}
