/**
 * Keeps this device's planner and your account in step.
 *
 * The device stays the first copy: everything works offline, and changes
 * are sent when there's a connection. Each value has a version; a device
 * that's behind gets the newer value (combined with its own unsent changes)
 * instead of overwriting it. The first time an account meets a device that
 * already has plans, Segue asks what to do rather than guessing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StateItem, SyncKey } from '@segue/schemas';
import { getState, isOffline, putState, ApiError } from './social';
import { getItem, setItem } from './store';
import { SYNC_KEYS, fingerprint, fromServer, isEmpty, merge, type Synced } from './syncMerge';

export type SyncStatus = 'off' | 'paused' | 'syncing' | 'synced' | 'offline' | 'error';
/** "import": the account is empty, this device has plans. "combine": both have plans. */
export type SyncPrompt = 'import' | 'combine' | null;
export type SyncChoice = 'import' | 'combine' | 'useAccount' | 'later';

interface Meta {
  userId: string;
  paused?: boolean;
  /** server version this device last saw, per key */
  versions: Partial<Record<SyncKey, number>>;
  /** fingerprint of what was last sent or received, per key */
  sent: Partial<Record<SyncKey, string>>;
}

const META_KEY = 'syncMeta';
type Items = Partial<Record<SyncKey, StateItem>>;

export function useSync(opts: { userId: string | null; ready: boolean; values: Synced; apply: <K extends SyncKey>(key: K, value: Synced[K]) => void }) {
  const { userId, ready } = opts;
  const [status, setStatus] = useState<SyncStatus>('off');
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<SyncPrompt>(null);
  const values = useRef(opts.values);
  values.current = opts.values;
  const apply = useRef(opts.apply);
  apply.current = opts.apply;
  const meta = useRef<Meta | null>(null);
  const pendingItems = useRef<Items>({});
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const saveMeta = (m: Meta | null) => {
    meta.current = m;
    void setItem(META_KEY, m ?? undefined);
  };

  /** Put a value on screen and remember it as already in step with the server. */
  function take<K extends SyncKey>(key: K, value: Synced[K], version: number) {
    const m = meta.current!;
    m.versions[key] = version;
    m.sent[key] = fingerprint(key, value);
    apply.current(key, value);
  }

  async function push<K extends SyncKey>(key: K, value: Synced[K], tries = 2): Promise<void> {
    const m = meta.current!;
    try {
      const { item } = await putState(key, JSON.parse(fingerprint(key, value)), m.versions[key] ?? 0);
      m.versions[key] = item.version;
      m.sent[key] = fingerprint(key, value);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict' && tries > 1) {
        // Another device saved first: combine its copy with ours, show that, and send it.
        const current = (e.details as { current?: StateItem | null } | undefined)?.current;
        const merged = current ? merge(key, values.current[key], fromServer(key, current.value as Synced[K], values.current[key])) : values.current[key];
        m.versions[key] = current?.version ?? 0;
        apply.current(key, merged);
        values.current = { ...values.current, [key]: merged };
        return push(key, merged, tries - 1);
      }
      throw e;
    }
  }

  /** Send every value that changed since it was last in step. */
  async function pushChanged() {
    const m = meta.current;
    if (!m || m.paused) return;
    for (const key of SYNC_KEYS) {
      if (fingerprint(key, values.current[key]) !== m.sent[key]) await push(key, values.current[key]);
    }
    saveMeta(m);
  }

  /** Bring in newer values from the account, then send ours. */
  async function reconcile(items: Items) {
    const m = meta.current!;
    for (const key of SYNC_KEYS) {
      const server = items[key];
      if (!server || server.version <= (m.versions[key] ?? 0)) continue;
      const local = values.current[key];
      const dirty = fingerprint(key, local) !== m.sent[key];
      const incoming = fromServer(key, server.value as Synced[typeof key], local);
      if (dirty) {
        const merged = merge(key, local, incoming);
        m.versions[key] = server.version;
        apply.current(key, merged);
        values.current = { ...values.current, [key]: merged };
      } else {
        take(key, incoming, server.version);
        values.current = { ...values.current, [key]: incoming };
      }
    }
    await pushChanged();
  }

  async function firstMeeting(uid: string, items: Items) {
    const serverEmpty = SYNC_KEYS.every((k) => !items[k] || isEmpty(k, items[k]!.value as never));
    const localEmpty = SYNC_KEYS.every((k) => isEmpty(k, values.current[k]));
    const versions: Meta['versions'] = Object.fromEntries(SYNC_KEYS.filter((k) => items[k]).map((k) => [k, items[k]!.version]));
    if (serverEmpty && localEmpty) {
      saveMeta({ userId: uid, versions, sent: Object.fromEntries(SYNC_KEYS.map((k) => [k, fingerprint(k, values.current[k])])) });
      return;
    }
    if (!serverEmpty && localEmpty) {
      saveMeta({ userId: uid, versions: {}, sent: {} });
      await reconcile(items);
      return;
    }
    // Both sides have something (or only this device does): ask.
    pendingItems.current = items;
    meta.current = null;
    setPrompt(serverEmpty ? 'import' : 'combine');
  }

  const run = useCallback(async () => {
    if (!userId) return;
    if (running.current) {
      again.current = true;
      return running.current;
    }
    running.current = (async () => {
      do {
        again.current = false;
        try {
          meta.current ??= ((await getItem<Meta>(META_KEY)) ?? null) as Meta | null;
          if (meta.current && meta.current.userId !== userId) meta.current = null;
          if (meta.current?.paused) {
            setStatus('paused');
            return;
          }
          setStatus('syncing');
          const { items } = await getState();
          if (!meta.current) {
            await firstMeeting(userId, items);
            if (!meta.current) {
              setStatus('paused');
              return;
            }
          } else {
            await reconcile(items);
          }
          saveMeta(meta.current);
          setStatus('synced');
          setLastSynced(new Date().toISOString());
        } catch (e) {
          setStatus(isOffline(e) ? 'offline' : 'error');
        }
      } while (again.current);
    })().finally(() => {
      running.current = null;
    });
    return running.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Signed in (or another account): start; signed out: stop.
  useEffect(() => {
    if (!ready) return;
    if (!userId) {
      setStatus('off');
      setPrompt(null);
      meta.current = null;
      return;
    }
    void run();
    const onWake = () => document.visibilityState === 'visible' && void run();
    const tick = setInterval(() => void run(), 5 * 60_000);
    window.addEventListener('online', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      clearInterval(tick);
      window.removeEventListener('online', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [ready, userId, run]);

  // Something changed on this device: send it shortly after.
  const prints = SYNC_KEYS.map((k) => fingerprint(k, opts.values[k])).join('\u0000');
  useEffect(() => {
    if (!ready || !userId || !meta.current || meta.current.paused) return;
    const t = setTimeout(() => void run(), 1500);
    return () => clearTimeout(t);
  }, [prints, ready, userId, run]);

  /** The answer to "this device already has plans". */
  async function choose(choice: SyncChoice) {
    if (!userId) return;
    const items = pendingItems.current;
    setPrompt(null);
    if (choice === 'later') {
      saveMeta({ userId, paused: true, versions: {}, sent: {} });
      setStatus('paused');
      return;
    }
    const m: Meta = { userId, versions: {}, sent: {} };
    meta.current = m;
    for (const key of SYNC_KEYS) {
      const server = items[key];
      if (!server) continue;
      m.versions[key] = server.version;
      const incoming = fromServer(key, server.value as Synced[typeof key], values.current[key]);
      if (choice === 'useAccount') take(key, incoming, server.version);
      else if (choice === 'combine') {
        const merged = merge(key, values.current[key], incoming);
        apply.current(key, merged);
        values.current = { ...values.current, [key]: merged };
      }
    }
    saveMeta(m);
    await run();
  }

  /** Stop syncing on this device (signing out). The plans stay here. */
  const forget = useCallback(() => {
    saveMeta(null);
    pendingItems.current = {};
    setPrompt(null);
    setStatus('off');
  }, []);

  /** Turn syncing back on after "Not now". */
  const resume = useCallback(async () => {
    saveMeta(null);
    await run();
  }, [run]);

  return { status, lastSynced, prompt, choose, forget, resume, syncNow: run };
}
