/**
 * The Together tab: notes, invitations and updates. Needs a Segue account;
 * without one it explains what it's for and offers to create one. Your own
 * planner never depends on any of this.
 */
import { useEffect, useState } from 'react';
import type { NoteView, NotificationView, PublicProfile } from '@segue/schemas';
import type { CalendarEvent } from '../../lib/calendar';
import { activityBlockId } from '../../lib/invitePlan';
import { localDate } from '../../lib/model';
import type { StoredBlock } from '../../lib/model';
import { markAllRead, markRead } from '../../lib/social';
import type { AccountState } from '../../lib/useAccount';
import type { Together } from '../../lib/useTogether';
import { Avatar } from '../Account';
import { InvitationsSection, InviteSheet, type InviteDraft } from './Invitations';
import { OverviewSection } from './Overview';
import { PeopleSection } from './People';
import { DiscoverSection, MyPlansSection, RequestsSection } from './Plans';

export type TogetherTab = 'overview' | 'discover' | 'invites' | 'requests' | 'plans' | 'people' | 'updates';

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
  const [highlight, setHighlight] = useState<string | undefined>();
  const [shareNew, setShareNew] = useState(0);
  const [focusNote, setFocusNote] = useState<{ id: string; n: number } | undefined>();
  // Scroll to the plan a notification is about, once its section has loaded it.
  useEffect(() => {
    if (!focusNote) return;
    let tries = 0;
    const t = setInterval(() => {
      const el = document.getElementById(`note-${focusNote.id}`);
      if (el || ++tries > 20) {
        clearInterval(t);
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 150);
    return () => clearInterval(t);
  }, [focusNote]);

  // Opening Requests reads its updates.
  useEffect(() => {
    if (props.tab !== 'requests') return;
    const unread = t.notifications.filter((n) => !n.readAt && ['note_hearted', 'join_accepted', 'join_declined'].includes(n.type));
    if (!unread.length) return;
    t.setNotifications((list) => list.map((x) => (unread.some((u) => u.id === x.id) ? { ...x, readAt: new Date().toISOString() } : x)));
    t.setUnread((u) => Math.max(0, u - unread.length));
    for (const n of unread) void markRead(n.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tab]);

  if (props.accountState !== 'ready') {
    return (
      <div className="page together-page">
        <header className="page-head">
          <div>
            <h2 className="page-title">Together</h2>
            <p className="muted">Share plans, ask to join, and agree on plans together.</p>
          </div>
        </header>
        <section className="panel">
          {props.accountState === 'off' && <p>Accounts aren't switched on in this version of Segue yet.</p>}
          {props.accountState === 'signed-out' && (
            <>
              <ul className="promises">
                <li>Your plans stay private. You choose what to share, note by note.</li>
                <li>“Can I join?” only asks. Nothing is agreed until the other person says yes.</li>
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
    // Shared with you: Discover. Someone asked to join yours, or an answer to your request: Requests.
    props.onTab(n.type === 'note_shared' ? 'discover' : 'requests');
    setFocusNote((f) => ({ id: n.entityId, n: (f?.n ?? 0) + 1 }));
  }

  async function readAll() {
    t.setNotifications((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    t.setUnread(0);
    await markAllRead().catch(() => {});
  }

  // New requests to join your plans, and answers to yours, count on the Requests tab until you open it.
  const REQUEST_TYPES = ['note_hearted', 'join_accepted', 'join_declined'];
  const requests = t.notifications.filter((n) => !n.readAt && REQUEST_TYPES.includes(n.type)).length;
  const tabs: { value: Exclude<TogetherTab, 'updates'>; label: string; count?: number }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'discover', label: 'Discover' },
    { value: 'invites', label: 'Invitations', count: t.waiting.length },
    { value: 'requests', label: 'Requests', count: requests },
    { value: 'plans', label: 'My plans' },
    { value: 'people', label: 'People', count: t.requestCount },
  ];

  return (
    <div className="page together-page">
      <header className="tg-head">
        <div className="tg-title">
          <h2 className="page-title">Together</h2>
          <p className="muted">Make time for the people who matter. You choose what to share.</p>
        </div>
        <button
          type="button"
          className={`tg-updates${props.tab === 'updates' ? ' on' : ''}`}
          aria-label={t.unread ? `Updates, ${t.unread} new` : 'Updates'}
          aria-pressed={props.tab === 'updates'}
          onClick={() => props.onTab(props.tab === 'updates' ? 'overview' : 'updates')}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
            <path d="M10 20.5a2.2 2.2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          {t.unread > 0 && <span className="bn-badge">{t.unread > 9 ? '9+' : t.unread}</span>}
        </button>
        <div className="tg-actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              props.onTab('plans');
              setShareNew((n) => n + 1);
            }}
          >
            Share a plan
          </button>
          <button type="button" className="ghost" onClick={() => props.onTab('people')}>
            Find people
          </button>
        </div>
      </header>

      {/* Together's own sections: a scrolling row of chips, so it never looks like the app's bottom navigation. */}
      <div className="tg-tabs" role="tablist" aria-label="Together sections">
        {tabs.map((x) => (
          <button
            key={x.value}
            type="button"
            role="tab"
            id={`tg-tab-${x.value}`}
            aria-selected={props.tab === x.value}
            aria-controls="tg-panel"
            className={props.tab === x.value ? 'on' : undefined}
            onClick={() => props.onTab(x.value)}
          >
            {x.label}
            {!!x.count && (
              <span className="tg-count" aria-label={`, ${x.count} new`}>
                {x.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div id="tg-panel" role="tabpanel" aria-labelledby={props.tab === 'updates' ? undefined : `tg-tab-${props.tab}`} aria-label={props.tab === 'updates' ? 'Updates' : undefined}>
      {props.tab === 'overview' && (
        <OverviewSection
          today={props.today}
          together={t}
          eventsOn={props.eventsOn}
          notify={props.notify}
          onOpenInvitation={(id) => {
            setHighlight(id);
            props.onTab('invites');
            setTimeout(() => document.getElementById(`inv-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
          }}
          onShare={() => {
            props.onTab('plans');
            setShareNew((n) => n + 1);
          }}
          onFindPeople={() => props.onTab('people')}
          onTab={props.onTab}
        />
      )}
      {props.tab === 'discover' && <DiscoverSection today={props.today} notify={props.notify} onFindPeople={() => props.onTab('people')} />}
      {props.tab === 'requests' && <RequestsSection today={props.today} notify={props.notify} onJoined={t.upsert} onDiscover={() => props.onTab('discover')} />}
      {props.tab === 'plans' && (
        <MyPlansSection
          today={props.today}
          blocks={props.blocks}
          notify={props.notify}
          shareNew={shareNew}
          onJoined={t.upsert}
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
          <h3 className="section-title">Updates</h3>
          {t.loaded && t.notifications.length === 0 && <p className="empty-state">You&apos;re all caught up. Invitations, requests to join your plans and answers to yours show up here.</p>}
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

      </div>

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
