/**
 * Talking to the Segue API as a signed-in person: profile, sync, notes,
 * hearts, invitations, notifications. Every call carries the access token;
 * the server decides what this person may see or change.
 */
import type {
  InterestView,
  InvitationView,
  MeResponse,
  MyProfile,
  NoteScope,
  NoteView,
  NotificationView,
  NotifyPrefs,
  PublicProfile,
  StateItem,
  SyncKey,
  Visibility,
} from '@segue/schemas';
import { accessToken } from './auth';
import { API_URL } from './reroute';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** True when the request never reached the server (offline, or the server is asleep). */
export const isOffline = (e: unknown) => e instanceof ApiError && e.status === 0;

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, 'Sign in to use this.', 'signed_out');
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach Segue. Check your connection and try again.", 'offline');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; details?: unknown };
  if (!res.ok) {
    const message =
      res.status >= 500 && res.status !== 503
        ? 'Something went wrong on our side. Try again in a moment.'
        : (json.error ?? 'That didn’t work. Try again.');
    throw new ApiError(res.status, message, json.code, json.details);
  }
  return json as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---- profile ----

export interface ProfileInput {
  username?: string;
  displayName?: string;
  bio?: string;
  avatar?: string | null;
  discoverable?: boolean;
  notify?: NotifyPrefs;
  timezone?: string;
}

export const getMe = () => api<MeResponse>('GET', '/v1/me');
export const createProfile = (p: ProfileInput & { username: string; displayName: string }) => api<MeResponse>('PUT', '/v1/me', p);
export const updateProfile = (p: ProfileInput) => api<MeResponse>('PATCH', '/v1/me', p);
export const deleteAccount = () => api<{ deleted: boolean; signInRemoved: boolean }>('DELETE', '/v1/me', { confirm: 'DELETE' });
export const searchUsers = (q: string) => api<{ users: PublicProfile[] }>('GET', `/v1/users${qs({ q })}`);

// ---- sync ----

export const getState = () => api<{ items: Partial<Record<SyncKey, StateItem>> }>('GET', '/v1/state');
export const putState = (key: SyncKey, value: unknown, baseVersion: number) => api<{ item: StateItem }>('PUT', `/v1/state/${key}`, { value, baseVersion });

// ---- notes ----

export interface NoteInput {
  title?: string;
  body?: string;
  visibility?: Visibility;
  onDate?: string | null;
  placeName?: string | null;
  blockId?: string | null;
  pinned?: boolean;
  archived?: boolean;
  shareWith?: string[];
  clientId?: string;
}

export const listNotes = (scope: NoteScope, opts: { q?: string; archived?: boolean; onDate?: string; author?: string } = {}) =>
  api<{ notes: NoteView[]; more: boolean }>('GET', `/v1/notes${qs({ scope, q: opts.q, archived: opts.archived ? 1 : undefined, onDate: opts.onDate, author: opts.author })}`);
export const getNote = (id: string) => api<{ note: NoteView }>('GET', `/v1/notes/${id}`);
export const createNote = (n: NoteInput & { title: string }) => api<{ note: NoteView }>('POST', '/v1/notes', n);
export const updateNote = (id: string, n: NoteInput) => api<{ note: NoteView }>('PATCH', `/v1/notes/${id}`, n);
export const deleteNote = (id: string) => api<{ deleted: boolean }>('DELETE', `/v1/notes/${id}`);
export const heartNote = (id: string) => api<{ note: NoteView }>('POST', `/v1/notes/${id}/heart`);
export const unheartNote = (id: string) => api<{ hearted: false; invitationStillOpen: boolean }>('DELETE', `/v1/notes/${id}/heart`);
export const noteInterests = (id: string) => api<{ interests: InterestView[] }>('GET', `/v1/notes/${id}/interests`);

// ---- invitations ----

export interface InvitationInput {
  recipientIds: string[];
  title: string;
  description?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  timezone: string;
  placeName?: string | null;
  meetingNotes?: string;
  sourceNoteId?: string;
  expiresAt?: string;
  clientId?: string;
}

export const listInvitations = () => api<{ invitations: InvitationView[] }>('GET', '/v1/invitations');
export const sendInvitation = (i: InvitationInput) => api<{ invitations: InvitationView[] }>('POST', '/v1/invitations', i);
export const editInvitation = (id: string, patch: Partial<Omit<InvitationInput, 'recipientIds' | 'sourceNoteId' | 'expiresAt' | 'clientId'>>) =>
  api<{ invitations: InvitationView[] }>('PATCH', `/v1/invitations/${id}`, patch);
export const acceptInvitation = (id: string) => api<{ invitation: InvitationView }>('POST', `/v1/invitations/${id}/accept`);
export const declineInvitation = (id: string) => api<{ invitation: InvitationView }>('POST', `/v1/invitations/${id}/decline`);
export const cancelInvitation = (id: string, everyone = false) => api<{ invitation: InvitationView }>('POST', `/v1/invitations/${id}/cancel`, { everyone });
export const suggestTime = (id: string, c: { startsAt: string; endsAt?: string | null; note?: string }) =>
  api<{ invitation: InvitationView }>('POST', `/v1/invitations/${id}/counter`, c);

// ---- notifications ----

export const listNotifications = () => api<{ notifications: NotificationView[]; unread: number }>('GET', '/v1/notifications');
export const markRead = (id: string) => api<{ ok: true }>('POST', `/v1/notifications/${id}/read`);
export const markAllRead = () => api<{ ok: true }>('POST', '/v1/notifications/read-all');

export type { InterestView, InvitationView, MyProfile, NoteView, NotificationView, PublicProfile };

/** A stable id for one create, so a retry after a dropped connection doesn't make two. */
export const clientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
