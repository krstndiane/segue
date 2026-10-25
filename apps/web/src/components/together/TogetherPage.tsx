/**
 * The Together tab: notes, invitations and updates. Needs a Segue account;
 * without one it explains what it's for and offers to create one. Your own
 * planner never depends on any of this.
 */
import { useState } from 'react';
import type { NoteScope, NoteView, NotificationView, PublicProfile } from '@segue/schemas';
import type { CalendarEvent } from '../../lib/calendar';
import { activityBlockId } from '../../lib/invitePlan';
import { localDate } from '../../lib/model';
import type { StoredBlock } from '../../lib/model';
import { markAllRead, markRead } from '../../lib/social';
import type { AccountState } from '../../lib/useAccount';
import type { Together } from '../../lib/useTogether';
import { Avatar } from '../Account';
import { Segmented } from '../Sheet';
import { InvitationsSection, InviteSheet, type InviteDraft } from './Invitations';
import { NotesSection } from './Notes';
import { PeopleSection } from './People';

export type TogetherTab = 'notes' | 'invites' | 'people' | 'updates';

interface Props {
  accountState: AccountState;
  today: string;
  blocks: StoredBlock[];
  together: Together;
  tab: TogetherTab;
  onTab: (t: TogetherTab) => void;
  eventsOn: (date: string) => CalendarEvent[];
  onAddToDay: (block: StoredBlock) => void;
  onPlanLater: (title: string) => void;
  onSignIn: () => void;
  onCreate: () => void;
  onSetupProfile: () => void;
  onRetry: () => void;
  notify: (text: string) => void;
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

export function TogetherPage(props: Props) {
  const { together: t } = props;
  const [invite, setInvite] = useState<InviteDraft | null>(null);
  const [noteFocus, setNoteFocus] = useState<{ scope: NoteScope; noteId?: string; interests?: boolean; n: number } | undefined>();
  const [highlight, setHighlight] = useState<string | undefined>();

  if (props.accountState !== 'ready') {
    return (
      <div className="page together-page">
        <header className="page-head">
          <div>
            <h2 className="page-title">Together</h2>
            <p className="muted">Share notes, say you'd like to join, and invite people.</p>
          </div>
        </header>
        <section className="panel">
          {props.accountState === 'off' && <p>Accounts aren't switched on in this version of Segue yet.</p>}
          {props.accountState === 'signed-out' && (
            <>
              <ul className="promises">
                <li>Your plans stay private. You choose what to share, note by note.</li>
                <li>A heart on a friend's note means “I'd like to come”. They decide whether to invite you.</li>
                <li>Invitations never change your day unless you add them yourself.</li>
              </ul>
              <div className="row-actions">
                <button type="button" className="primary" onClick={props.onCreate}>
                  Create a free account
                </button>
                <button type="button" className="ghost" onClick={props.onSignIn}>
                  Sign in
                </button>
              </div>
            </>
          )}
          {props.accountState === 'needs-profile' && (
            <>
              <p>One more step: set up your profile so people know who's inviting them.</p>
              <button type="button" className="primary" onClick={props.onSetupProfile}>
                Set up profile
              </button>
            </>
          )}
          {props.accountState === 'loading' && <p className="muted">Loading your account…</p>}
          {props.accountState === 'offline' && (
            <>
              <p>Couldn't reach your account. Check your connection; the server may also be waking up.</p>
              <button type="button" className="ghost" onClick={props.onRetry}>
                Try again
              </button>
            </>
          )}
        </section>
      </div>
    );
  }

  /** Opening a notification marks it read and takes you to what it's about. */
  function open(n: NotificationView) {
    if (!n.readAt) {
      t.setNotifications((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      t.setUnread((u) => Math.max(0, u - 1));
      void markRead(n.id).catch(() => {});
    }
    if (n.entityType === 'connection') {
      props.onTab('people');
      return;
    }
    if (!n.available) return;
    if (n.entityType === 'invitation') {
      setHighlight(n.entityId);
      props.onTab('invites');
      setTimeout(() => document.getElementById(`inv-${n.entityId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
      return;
    }
    setNoteFocus((f) => ({ scope: n.type === 'note_shared' ? 'shared' : 'mine', noteId: n.entityId, interests: n.type === 'note_hearted', n: (f?.n ?? 0) + 1 }));
    props.onTab('notes');
  }

  async function readAll() {
    t.setNotifications((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    t.setUnread(0);
    await markAllRead().catch(() => {});
  }

  return (
    <div className="page together-page">
      <header className="page-head">
        <div>
          <h2 className="page-title">Together</h2>
          <p className="muted">Plan on your own. Share what you choose. Invite when you're ready.</p>
        </div>
      </header>
      <Segmented<TogetherTab>
        label="Show"
        value={props.tab}
        onChange={props.onTab}
        options={[
          { value: 'notes', label: 'Notes' },
          { value: 'invites', label: t.waiting.length ? `Invitations (${t.waiting.length})` : 'Invitations' },
          { value: 'people', label: t.requestCount ? `People (${t.requestCount})` : 'People' },
          { value: 'updates', label: t.unread ? `Updates (${t.unread})` : 'Updates' },
        ]}
      />

      {props.tab === 'notes' && (
        <NotesSection
          today={props.today}
          blocks={props.blocks}
          notify={props.notify}
          focus={noteFocus}
          onInvite={(note: NoteView, people: PublicProfile[]) =>
            setInvite({ title: note.title, description: note.body, people, sourceNoteId: note.id, placeName: note.placeName, date: note.onDate })
          }
        />
      )}
      {props.tab === 'invites' && (
        <InvitationsSection
          invitations={t.invitations}
          blocks={props.blocks}
          eventsOn={props.eventsOn}
          onChanged={t.upsert}
          onAddToDay={props.onAddToDay}
          onPlanLater={props.onPlanLater}
          onNew={() => setInvite({ title: '', people: [] })}
          notify={props.notify}
          highlight={highlight}
        />
      )}
      {props.tab === 'people' && <PeopleSection connections={t.connections} onChange={t.setConnections} notify={props.notify} />}
      {props.tab === 'updates' && (
        <section className="together-section" aria-label="Updates">
          {t.error && !t.loaded && <p className="error">Couldn't load updates just now.</p>}
          {t.loaded && t.notifications.length === 0 && <p className="empty muted">Nothing yet. Hearts on your notes, connection requests and answers to your invitations show up here.</p>}
          {t.unread > 0 && (
            <button type="button" className="text-button" onClick={() => void readAll()}>
              Mark all as read
            </button>
          )}
          <ul className="updates">
            {t.notifications.map((n) => (
              <li key={n.id}>
                <button type="button" className={`update${n.readAt ? '' : ' unread'}`} onClick={() => open(n)}>
                  <Avatar person={n.actor} size={36} />
                  <span>
                    <span className="update-text">{n.text}</span>
                    <span className="muted small block">{ago(n.createdAt)}</span>
                  </span>
                  {!n.readAt && <span className="visually-hidden">Unread</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {invite && (
        <InviteSheet
          draft={invite}
          onClose={() => setInvite(null)}
          onSent={(list) => {
            setInvite(null);
            t.upsert(list);
            props.onTab('invites');
            props.notify(list.length > 1 ? `Invited ${list.length} people.` : `Invitation sent to ${list[0]?.recipient.displayName ?? 'them'}.`);
          }}
        />
      )}
    </div>
  );
}

/** On Today: invitations waiting for an answer, and accepted ones today that aren't in the plan yet. */
export function TogetherCard({ together, today, blocks, onOpen }: { together: Together; today: string; blocks: StoredBlock[]; onOpen: () => void }) {
  const waiting = together.waiting.length;
  const todayNotIn = together.invitations.filter(
    (i) =>
      i.direction === 'received' &&
      i.status === 'accepted' &&
      i.activity.status === 'active' &&
      !!i.activity.startsAt &&
      localDate(new Date(i.activity.startsAt)) === today &&
      !blocks.some((b) => b.id === activityBlockId(i.activity.id)),
  );
  if (!waiting && !todayNotIn.length) return null;
  return (
    <button type="button" className="together-card" onClick={onOpen}>
      <strong>{waiting ? `${waiting} invitation${waiting === 1 ? '' : 's'} waiting for you` : 'Plans with people today'}</strong>
      <span className="muted small block">
        {todayNotIn.length ? `${todayNotIn.map((i) => i.activity.title).join(', ')} isn't in your plan yet.` : 'Tap to answer.'}
      </span>
    </button>
  );
}
