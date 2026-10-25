/**
 * Invitations and notifications for the signed-in person, refreshed every
 * minute while Segue is open (and when it comes back to the foreground).
 * Feeds the Together tab's badge and the "Waiting for you" card on Today.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listInvitations, listNotifications, type InvitationView, type NotificationView } from './social';

export function useTogether(userId: string | null) {
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!userId || busy.current) return;
    busy.current = true;
    try {
      const [inv, notes] = await Promise.all([listInvitations(), listNotifications()]);
      setInvitations(inv.invitations);
      setNotifications(notes.notifications);
      setUnread(notes.unread);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setInvitations([]);
      setNotifications([]);
      setUnread(0);
      setLoaded(false);
      return;
    }
    void refresh();
    const t = setInterval(() => document.visibilityState === 'visible' && void refresh(), 60_000);
    const onWake = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [userId, refresh]);

  /** Put a changed invitation in place without waiting for the next refresh. */
  const upsert = useCallback((list: InvitationView[]) => {
    setInvitations((cur) => {
      const byId = new Map(cur.map((i) => [i.id, i]));
      for (const i of list) byId.set(i.id, i);
      return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }, []);

  const waiting = invitations.filter((i) => i.direction === 'received' && i.status === 'pending' && i.activity.status === 'active');

  return { invitations, notifications, unread, setUnread, setNotifications, loaded, error, refresh, upsert, waiting };
}

export type Together = ReturnType<typeof useTogether>;
