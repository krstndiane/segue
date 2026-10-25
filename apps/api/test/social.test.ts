/**
 * Accounts, notes, hearts, invitations and notifications against a real
 * Postgres. Set TEST_DATABASE_URL (CI starts one); without it these skip.
 * The test database's `segue` schema is dropped and rebuilt on every run.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { createApp } from '../src/app';
import { createVerifier } from '../src/auth';
import { connect, migrate, rollback, type Db } from '../src/db';
import { createSocial } from '../src/social';

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-for-hs256-tokens';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub: string, claims: Record<string, unknown> = {}, secret = SECRET) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, email: `${sub.slice(0, 4)}@example.com`, ...claims });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const weather: WeatherProvider = { name: 'fake', forecast: async () => [], current: async () => ({ condition: 'clear', isDay: true, observedAt: new Date().toISOString() }) };

let server: Server;
let base = '';
let db: Db;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function call(auth: string | null, method: string, path: string, body?: unknown, raw?: string): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json() };
}

/** A signed-in person with a profile. */
async function person(name: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const t = token(id);
  const as = (method: string, path: string, body?: unknown) => call(t, method, path, body);
  const created = await as('PUT', '/v1/me', { username: `${name}_${id.slice(0, 6)}`, displayName: name, ...extra });
  expect(created.status).toBe(200);
  return { id, t, as, username: created.body.profile.username as string };
}

const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe.skipIf(!DB_URL)('accounts and social (Postgres)', () => {
  beforeAll(async () => {
    db = connect({ url: DB_URL!, ssl: 'off', max: 4 });
    await db.query('drop schema if exists segue cascade');
    expect(await migrate(db)).toEqual(['001_accounts_notes_invitations', '002_profile_settings_connections', '003_username_rules']);
    expect(await migrate(db)).toEqual([]);
    server = createServer(
      createApp({
        config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 50 },
        places: new MockPlacesProvider(),
        weather,
        social: createSocial({ db, verifier: createVerifier({ jwtSecret: SECRET }), limits: { writesPerHour: 400 } }),
        log: () => {},
      }),
    );
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await db.close();
  });

  describe('signing in', () => {
    it('needs a valid, unexpired token from the right audience', async () => {
      const id = randomUUID();
      expect((await call(null, 'GET', '/v1/me')).status).toBe(401);
      expect((await call(token(id, {}, 'wrong-secret'), 'GET', '/v1/me')).status).toBe(401);
      expect((await call(token(id, { exp: Math.floor(Date.now() / 1000) - 120 }), 'GET', '/v1/me')).status).toBe(401);
      expect((await call(token(id, { aud: 'anon', role: 'anon' }), 'GET', '/v1/me')).status).toBe(401);
      expect((await call(token('not-a-uuid'), 'GET', '/v1/me')).status).toBe(401);
      const ok = await call(token(id), 'GET', '/v1/me');
      expect(ok.status).toBe(200);
      expect(ok.body.profile).toBeNull();
    });

    it('asks for a profile before anything social', async () => {
      const t = token(randomUUID());
      const res = await call(t, 'GET', '/v1/notes');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('profile_required');
    });

    it('creates and edits a profile, with unique usernames', async () => {
      const a = await person('ana', { bio: 'Hi' });
      const me = await a.as('GET', '/v1/me');
      expect(me.body.profile).toMatchObject({ displayName: 'ana', bio: 'Hi', discoverable: false, notify: { hearts: true } });
      const b = await person('ben');
      expect((await b.as('PATCH', '/v1/me', { username: a.username })).status).toBe(409);
      expect((await b.as('PATCH', '/v1/me', { username: 'No Spaces!' })).status).toBe(400);
      const patched = await b.as('PATCH', '/v1/me', { displayName: 'Ben C', discoverable: true });
      expect(patched.body.profile).toMatchObject({ displayName: 'Ben C', discoverable: true, avatar: null });
      // Photos only arrive through the upload route: no links, no inline data.
      expect((await b.as('PATCH', '/v1/me', { avatar: 'https://tracker.example/pixel.png' })).status).toBe(400);
      expect((await b.as('PATCH', '/v1/me', { avatar: 'data:image/png;base64,AAAA' })).status).toBe(400);
    });
  });

  describe('sync across devices', () => {
    it('saves with versions and refuses stale writes', async () => {
      const a = await person('sync');
      const first = await a.as('PUT', '/v1/state/blocks', { value: [{ id: 'b1', title: 'Gym' }], baseVersion: 0 });
      expect(first.status).toBe(200);
      expect(first.body.item.version).toBe(1);
      // A second device that hadn't seen version 1 can't overwrite it.
      const stale = await a.as('PUT', '/v1/state/blocks', { value: [], baseVersion: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.details.current.value).toEqual([{ id: 'b1', title: 'Gym' }]);
      const next = await a.as('PUT', '/v1/state/blocks', { value: [{ id: 'b1', title: 'Gym' }, { id: 'b2', title: 'Run' }], baseVersion: 1 });
      expect(next.body.item.version).toBe(2);
      expect((await a.as('PUT', '/v1/state/passwords', { value: {}, baseVersion: 0 })).status).toBe(400);
    });

    it('never stores a precise position or calendar events', async () => {
      const a = await person('private');
      await a.as('PUT', '/v1/state/settings', { value: { endOfDay: '21:00', lastLocation: { lat: 14.55, lng: 121.02 }, lastLocatedAt: 'x' }, baseVersion: 0 });
      await a.as('PUT', '/v1/state/dayArchive', {
        value: { '2026-10-20': { date: '2026-10-20', items: [{ blockId: 'gcal_x', title: 'Doctor' }, { blockId: 'gym', title: 'Gym' }] } },
        baseVersion: 0,
      });
      const got = await a.as('GET', '/v1/state');
      expect(got.body.items.settings.value).toEqual({ endOfDay: '21:00' });
      expect(got.body.items.dayArchive.value['2026-10-20'].items.map((i: { blockId: string }) => i.blockId)).toEqual(['gym']);
      const other = await person('other');
      expect((await other.as('GET', '/v1/state')).body.items).toEqual({});
    });
  });

  describe('notes', () => {
    it('keeps private notes private, even by id', async () => {
      const a = await person('author');
      const b = await person('reader', { discoverable: true });
      const note = (await a.as('POST', '/v1/notes', { title: 'Secret plan', body: 'Just me' })).body.note;
      expect(note).toMatchObject({ visibility: 'private', mine: true, heartCount: 0 });
      expect((await b.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
      expect((await b.as('POST', `/v1/notes/${note.id}/heart`)).status).toBe(404);
      expect((await b.as('PATCH', `/v1/notes/${note.id}`, { title: 'Hacked' })).status).toBe(404);
      expect((await b.as('DELETE', `/v1/notes/${note.id}`)).status).toBe(404);
      expect((await b.as('GET', '/v1/notes?scope=discover')).body.notes.some((n: { id: string }) => n.id === note.id)).toBe(false);
    });

    it('shares with selected people only, and takes access back', async () => {
      const a = await person('alice');
      const b = await person('bob');
      const c = await person('carl');
      const note = (await a.as('POST', '/v1/notes', { title: 'Study at a café Saturday', visibility: 'selected', shareWith: [b.id] })).body.note;
      expect(note.sharedWith.map((p: { id: string }) => p.id)).toEqual([b.id]);
      expect((await b.as('GET', `/v1/notes/${note.id}`)).body.note).toMatchObject({ mine: false, hearted: false });
      expect((await b.as('GET', '/v1/notes?scope=shared')).body.notes.map((n: { id: string }) => n.id)).toContain(note.id);
      expect((await c.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
      // Bob hears about it.
      const bn = (await b.as('GET', '/v1/notifications')).body;
      expect(bn.notifications[0]).toMatchObject({ type: 'note_shared', available: true });
      // Bob can see it but not change it.
      expect((await b.as('PATCH', `/v1/notes/${note.id}`, { title: 'Mine now' })).status).toBe(403);
      // Hearted, then the note goes private: Bob loses access and drops off the interest list.
      expect((await b.as('POST', `/v1/notes/${note.id}/heart`)).status).toBe(200);
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests).toHaveLength(1);
      await a.as('PATCH', `/v1/notes/${note.id}`, { visibility: 'private' });
      expect((await b.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests).toHaveLength(0);
      expect((await a.as('GET', `/v1/notes/${note.id}`)).body.note.heartCount).toBe(0);
      // Bob's old notification no longer shows the title.
      const later = (await b.as('GET', '/v1/notifications')).body.notifications.find((n: { type: string }) => n.type === 'note_shared');
      expect(later.available).toBe(false);
      expect(later.text).not.toContain('Study');
    });

    it('shows discoverable notes in Discover only from findable people', async () => {
      const a = await person('quiet');
      const b = await person('browser');
      const note = (await a.as('POST', '/v1/notes', { title: 'Open hike', visibility: 'discoverable' })).body.note;
      const ids = async () => (await b.as('GET', '/v1/notes?scope=discover')).body.notes.map((n: { id: string }) => n.id);
      expect(await ids()).not.toContain(note.id);
      await a.as('PATCH', '/v1/me', { discoverable: true });
      expect(await ids()).toContain(note.id);
      await a.as('PATCH', `/v1/notes/${note.id}`, { archived: true });
      expect(await ids()).not.toContain(note.id);
      expect((await b.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
    });

    it('edits, pins, searches and deletes your own notes; a retried create makes one note', async () => {
      const a = await person('writer');
      const first = await a.as('POST', '/v1/notes', { title: 'Buy flowers', clientId: 'c1', onDate: '2026-11-02', placeName: 'Dangwa' });
      const again = await a.as('POST', '/v1/notes', { title: 'Buy flowers', clientId: 'c1' });
      expect(again.body.note.id).toBe(first.body.note.id);
      await a.as('POST', '/v1/notes', { title: 'Call mom' });
      await a.as('PATCH', `/v1/notes/${first.body.note.id}`, { pinned: true, body: 'Roses' });
      const list = (await a.as('GET', '/v1/notes?scope=mine')).body.notes;
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ title: 'Buy flowers', pinned: true, body: 'Roses', onDate: '2026-11-02', placeName: 'Dangwa' });
      expect((await a.as('GET', '/v1/notes?scope=mine&q=mom')).body.notes.map((n: { title: string }) => n.title)).toEqual(['Call mom']);
      expect((await a.as('GET', '/v1/notes?scope=mine&q=%25')).body.notes).toHaveLength(0);
      expect((await a.as('DELETE', `/v1/notes/${first.body.note.id}`)).status).toBe(200);
      expect((await a.as('GET', `/v1/notes/${first.body.note.id}`)).status).toBe(404);
      expect((await a.as('POST', '/v1/notes', { title: '' })).status).toBe(400);
    });
  });

  describe('hearts', () => {
    it('means interest: one per person, never your own, the author told once', async () => {
      const a = await person('host', { discoverable: true });
      const b = await person('fan');
      const note = (await a.as('POST', '/v1/notes', { title: 'Board games Friday', visibility: 'discoverable' })).body.note;
      expect((await a.as('POST', `/v1/notes/${note.id}/heart`)).status).toBe(400);
      const hearted = await b.as('POST', `/v1/notes/${note.id}/heart`);
      expect(hearted.body.note).toMatchObject({ hearted: true, interest: 'interested' });
      expect(hearted.body.note.heartCount).toBeUndefined();
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      expect((await a.as('GET', `/v1/notes/${note.id}`)).body.note.heartCount).toBe(1);
      // Un-heart and heart again: still one heart, still one notification.
      expect((await b.as('DELETE', `/v1/notes/${note.id}/heart`)).body).toMatchObject({ hearted: false, invitationStillOpen: false });
      expect((await a.as('GET', `/v1/notes/${note.id}`)).body.note.heartCount).toBe(0);
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      const notes = (await a.as('GET', '/v1/notifications')).body.notifications.filter((n: { type: string }) => n.type === 'note_hearted');
      expect(notes).toHaveLength(1);
      expect(notes[0].text).toContain('Board games Friday');
      expect((await b.as('GET', '/v1/notes?scope=hearted')).body.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);
      // Only the author sees who's interested.
      expect((await b.as('GET', `/v1/notes/${note.id}/interests`)).status).toBe(403);
    });

    it("respects a person's notification settings", async () => {
      const a = await person('muted', { discoverable: true, notify: { hearts: false, invitations: true, shares: true } });
      const b = await person('liker');
      const note = (await a.as('POST', '/v1/notes', { title: 'Run', visibility: 'discoverable' })).body.note;
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      expect((await a.as('GET', '/v1/notifications')).body.notifications).toHaveLength(0);
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests).toHaveLength(1);
    });
  });

  describe('invitations', () => {
    it('goes heart → invite → accept, with statuses that follow along', async () => {
      const a = await person('alicia', { discoverable: true });
      const b = await person('benny');
      const note = (await a.as('POST', '/v1/notes', { title: 'Project at a café', visibility: 'discoverable' })).body.note;
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      const interest = (await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests[0];
      expect(interest).toMatchObject({ status: 'interested', user: { id: b.id } });
      expect(interest.user.email).toBeUndefined();

      const sent = await a.as('POST', '/v1/invitations', {
        recipientIds: [b.id],
        title: 'Project session',
        startsAt: soon(48),
        endsAt: soon(50),
        timezone: 'Asia/Manila',
        placeName: 'Café Ten',
        sourceNoteId: note.id,
      });
      expect(sent.status).toBe(201);
      const inv = sent.body.invitations[0];
      expect(inv).toMatchObject({ status: 'pending', direction: 'sent', recipient: { id: b.id }, activity: { placeName: 'Café Ten', sourceNoteId: note.id } });
      expect((await b.as('GET', `/v1/notes/${note.id}`)).body.note.interest).toBe('invited');
      expect((await b.as('GET', '/v1/notifications')).body.notifications[0]).toMatchObject({ type: 'invitation_received', available: true });

      // A second invitation for the same note to the same person is refused.
      const dupe = await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Again', timezone: 'Asia/Manila', sourceNoteId: note.id });
      expect(dupe.status).toBe(409);

      // Only the person invited can accept.
      expect((await a.as('POST', `/v1/invitations/${inv.id}/accept`)).status).toBe(403);
      const accepted = await b.as('POST', `/v1/invitations/${inv.id}/accept`);
      expect(accepted.body.invitation).toMatchObject({ status: 'accepted', direction: 'received' });
      expect((await b.as('POST', `/v1/invitations/${inv.id}/accept`)).status).toBe(200);
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests[0].status).toBe('accepted');
      const told = (await a.as('GET', '/v1/notifications')).body.notifications.filter((n: { type: string }) => n.type === 'invitation_accepted');
      expect(told).toHaveLength(1);

      // Taking the heart back doesn't cancel the invitation.
      expect((await b.as('DELETE', `/v1/notes/${note.id}/heart`)).body.invitationStillOpen).toBe(true);
      expect((await b.as('GET', `/v1/invitations/${inv.id}`)).body.invitation.status).toBe('accepted');

      // A stranger can't see or touch it.
      const c = await person('stranger');
      expect((await c.as('GET', `/v1/invitations/${inv.id}`)).status).toBe(404);
      expect((await c.as('POST', `/v1/invitations/${inv.id}/decline`)).status).toBe(404);
      expect((await c.as('POST', `/v1/invitations/${inv.id}/cancel`)).status).toBe(404);
    });

    it('asks people to confirm again when the time or place changes', async () => {
      const a = await person('planner');
      const b = await person('friend');
      const inv = (await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Lunch', startsAt: soon(24), endsAt: soon(25), timezone: 'Asia/Manila' })).body.invitations[0];
      await b.as('POST', `/v1/invitations/${inv.id}/accept`);
      expect((await b.as('PATCH', `/v1/invitations/${inv.id}`, { title: 'Mine' })).status).toBe(403);
      const changed = await a.as('PATCH', `/v1/invitations/${inv.id}`, { startsAt: soon(26), endsAt: soon(27) });
      expect(changed.body.invitations[0]).toMatchObject({ status: 'pending', changedFields: ['time'] });
      expect((await b.as('GET', '/v1/notifications')).body.notifications[0].type).toBe('invitation_changed');
      // Same change again: nothing new to tell.
      await a.as('PATCH', `/v1/invitations/${inv.id}`, { startsAt: changed.body.invitations[0].activity.startsAt });
      expect((await b.as('GET', '/v1/notifications')).body.notifications.filter((n: { type: string }) => n.type === 'invitation_changed')).toHaveLength(1);
      // A title-only change doesn't need a new yes.
      await b.as('POST', `/v1/invitations/${inv.id}/accept`);
      const renamed = await a.as('PATCH', `/v1/invitations/${inv.id}`, { title: 'Lunch at noon' });
      expect(renamed.body.invitations[0]).toMatchObject({ status: 'accepted', changedFields: ['details'] });
      expect((await a.as('PATCH', `/v1/invitations/${inv.id}`, { startsAt: soon(30), endsAt: soon(29) })).status).toBe(400);
    });

    it('lets each person in a group answer for themselves', async () => {
      const a = await person('organizer');
      const [b, c, d] = [await person('one'), await person('two'), await person('three')];
      const invs = (await a.as('POST', '/v1/invitations', { recipientIds: [b.id, c.id, d.id], title: 'Study group', timezone: 'Asia/Manila', clientId: 'group-1' })).body.invitations;
      expect(invs).toHaveLength(3);
      // A retried send doesn't invite anyone twice.
      const retry = await a.as('POST', '/v1/invitations', { recipientIds: [b.id, c.id, d.id], title: 'Study group', timezone: 'Asia/Manila', clientId: 'group-1' });
      expect(retry.body.invitations).toHaveLength(3);
      const mine = (who: { id: string }) => invs.find((i: { recipient: { id: string } }) => i.recipient.id === who.id).id;
      await b.as('POST', `/v1/invitations/${mine(b)}/accept`);
      await c.as('POST', `/v1/invitations/${mine(c)}/decline`);
      const statuses = (await a.as('GET', '/v1/invitations?box=sent')).body.invitations
        .filter((i: { activity: { title: string } }) => i.activity.title === 'Study group')
        .map((i: { recipient: { id: string }; status: string }) => [i.recipient.id, i.status]);
      expect(Object.fromEntries(statuses)).toEqual({ [b.id]: 'accepted', [c.id]: 'declined', [d.id]: 'pending' });
      // Recipients only see their own invitation.
      expect((await b.as('GET', '/v1/invitations')).body.invitations).toHaveLength(1);
      // Cancel for everyone: the open ones close; the decline stays a decline.
      expect((await b.as('POST', `/v1/invitations/${mine(b)}/cancel`, { everyone: true })).status).toBe(403);
      await a.as('POST', `/v1/invitations/${mine(d)}/cancel`, { everyone: true });
      const after = await d.as('GET', `/v1/invitations/${mine(d)}`);
      expect(after.body.invitation).toMatchObject({ status: 'cancelled', activity: { status: 'cancelled' } });
      expect((await c.as('GET', `/v1/invitations/${mine(c)}`)).body.invitation.status).toBe('declined');
      // Bob had accepted; the cancellation closes his too, and it can't be re-accepted.
      expect((await b.as('GET', `/v1/invitations/${mine(b)}`)).body.invitation.status).toBe('cancelled');
      expect((await b.as('POST', `/v1/invitations/${mine(b)}/accept`)).status).toBe(409);
    });

    it('expires, takes counter-proposals, and refuses bad input', async () => {
      const a = await person('sender');
      const b = await person('receiver');
      expect((await a.as('POST', '/v1/invitations', { recipientIds: [a.id], title: 'Me', timezone: 'UTC' })).status).toBe(400);
      expect((await a.as('POST', '/v1/invitations', { recipientIds: [randomUUID()], title: 'Ghost', timezone: 'UTC' })).status).toBe(400);
      expect((await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Past', startsAt: soon(-5), timezone: 'UTC' })).status).toBe(400);
      expect((await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'End only', endsAt: soon(5), timezone: 'UTC' })).status).toBe(400);

      const inv = (await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Coffee', startsAt: soon(10), timezone: 'UTC', expiresAt: soon(5) })).body.invitations[0];
      const counter = await b.as('POST', `/v1/invitations/${inv.id}/counter`, { startsAt: soon(12), note: 'Later?' });
      expect(counter.body.invitation.counter).toMatchObject({ note: 'Later?' });
      expect((await a.as('GET', '/v1/notifications')).body.notifications[0].type).toBe('invitation_counter');

      await db.query("update segue.invitations set expires_at = now() - interval '1 minute' where id = $1", [inv.id]);
      expect((await b.as('GET', `/v1/invitations/${inv.id}`)).body.invitation.status).toBe('expired');
      expect((await b.as('POST', `/v1/invitations/${inv.id}/accept`)).status).toBe(409);
    });
  });

  describe('notifications and people', () => {
    it('only the recipient can read or mark them', async () => {
      const a = await person('n1', { discoverable: true });
      const b = await person('n2');
      const note = (await a.as('POST', '/v1/notes', { title: 'Picnic', visibility: 'discoverable' })).body.note;
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      const list = (await a.as('GET', '/v1/notifications')).body;
      expect(list.unread).toBe(1);
      const id = list.notifications[0].id;
      expect((await b.as('POST', `/v1/notifications/${id}/read`)).status).toBe(404);
      expect((await a.as('POST', `/v1/notifications/${id}/read`)).status).toBe(200);
      expect((await a.as('GET', '/v1/notifications')).body.unread).toBe(0);
      await a.as('DELETE', `/v1/notes/${note.id}`);
      const gone = (await a.as('GET', '/v1/notifications')).body.notifications[0];
      expect(gone).toMatchObject({ available: false });
      expect(gone.text).not.toContain('Picnic');
      await a.as('POST', '/v1/notifications/read-all');
    });

    it('finds only people who chose to be found, never by email', async () => {
      const a = await person('seeker');
      const shy = await person('shyperson');
      const open = await person('openperson', { discoverable: true, displayName: 'Open Person' });
      const found = (await a.as('GET', '/v1/users?q=person')).body.users.map((u: { id: string }) => u.id);
      expect(found).toContain(open.id);
      expect(found).not.toContain(shy.id);
      expect((await a.as('GET', '/v1/users?q=example.com')).body.users).toHaveLength(0);
      expect((await a.as('GET', '/v1/users?q=x')).status).toBe(400);
      expect((await a.as('GET', `/v1/users/${shy.id}`)).status).toBe(404);
      // Once they share something, their profile can be opened.
      await shy.as('POST', '/v1/notes', { title: 'For you', visibility: 'selected', shareWith: [a.id] });
      expect((await a.as('GET', `/v1/users/${shy.id}`)).body.user).toMatchObject({ id: shy.id });
      expect((await a.as('GET', `/v1/users/${shy.id}`)).body.user.email).toBeUndefined();
    });

    it('deletes an account and everything in it', async () => {
      const a = await person('leaver', { discoverable: true });
      const b = await person('stayer');
      const note = (await a.as('POST', '/v1/notes', { title: 'Bye', visibility: 'discoverable' })).body.note;
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      await a.as('PUT', '/v1/state/blocks', { value: [], baseVersion: 0 });
      expect((await a.as('DELETE', '/v1/me', {})).status).toBe(400);
      expect((await a.as('DELETE', '/v1/me', { confirm: 'DELETE' })).body).toMatchObject({ deleted: true });
      expect((await a.as('GET', '/v1/me')).body.profile).toBeNull();
      expect((await b.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
      expect((await db.query('select count(*)::int as n from segue.user_state where user_id = $1', [a.id]))[0]).toEqual({ n: 0 });
    });
  });

  it('rolls back and re-applies the migration', async () => {
    expect(await rollback(db)).toBe('003_username_rules');
    expect(await migrate(db)).toEqual(['003_username_rules']);
  });
});

describe('accounts switched off', () => {
  it('answers 503 instead of guessing', async () => {
    const s = createServer(createApp({ config: { corsOrigins: [], rerouteRateLimit: 5 }, places: new MockPlacesProvider(), weather, log: () => {} }));
    await new Promise<void>((r) => s.listen(0, r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/notes`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('accounts_off');
    await new Promise<void>((r) => s.close(() => r()));
  });
});
