/**
 * Profile pictures, profile privacy, mutual connections and blocking against a
 * real Postgres (TEST_DATABASE_URL; skipped without it).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { createApp } from '../src/app';
import { createVerifier } from '../src/auth';
import { connect, migrate, type Db } from '../src/db';
import { createSocial } from '../src/social';
import { imageInfo, type AvatarStorage } from '../src/social/avatars';

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-for-hs256-tokens';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub: string) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const weather: WeatherProvider = { name: 'fake', forecast: async () => [], current: async () => ({ condition: 'clear', isDay: true, observedAt: new Date().toISOString() }) };

/** The first bytes of a PNG: enough for the server to identify it and read its size. */
function png(w: number, h: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const stored = new Map<string, Buffer>();
const storage: AvatarStorage = {
  async put(key, bytes) {
    stored.set(key, bytes);
    return `https://files.example/avatars/${key}`;
  },
  async remove(key) {
    stored.delete(key);
  },
};

let server: Server;
let offServer: Server;
let base = '';
let offBase = '';
let db: Db;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function call(b: string, t: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${b}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function upload(t: string, bytes: Buffer, type = 'image/png', b = base): Promise<Res> {
  const res = await fetch(`${b}/v1/me/avatar`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': type }, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json() };
}

async function person(name: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const t = token(id);
  const as = (method: string, path: string, body?: unknown) => call(base, t, method, path, body);
  const created = await as('PUT', '/v1/me', { username: `${name}_${id.slice(0, 6)}`, displayName: name, discoverable: true, ...extra });
  expect(created.status).toBe(200);
  return { id, t, as };
}
type Person = Awaited<ReturnType<typeof person>>;

/** a and b become mutuals. */
async function connect2(a: Person, b: Person) {
  const sent = await a.as('POST', '/v1/connections/requests', { userId: b.id });
  expect(sent.status).toBe(201);
  expect((await b.as('POST', `/v1/connections/${sent.body.connection.id}/accept`)).status).toBe(200);
  return sent.body.connection.id as string;
}

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

describe('image headers', () => {
  it('identifies the format and size, and rejects everything else', () => {
    expect(imageInfo(png(300, 200))).toMatchObject({ type: 'image/png', width: 300, height: 200 });
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(imageInfo(Buffer.from('GIF89a'.padEnd(40, '\0')))).toBeNull();
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
    // JPEG: SOI, an APP0 segment, then a baseline frame header (height 120, width 90)
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]), Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x78, 0x00, 0x5a, 0x01, 0x01, 0x11, 0x00]), Buffer.alloc(8)]);
    expect(imageInfo(jpg)).toMatchObject({ type: 'image/jpeg', width: 90, height: 120 });
  });
});

describe.skipIf(!DB_URL)('profiles, connections and blocks (Postgres)', () => {
  beforeAll(async () => {
    db = connect({ url: DB_URL!, ssl: 'off', max: 4 });
    await db.query('drop schema if exists segue cascade');
    await migrate(db);
    const make = (avatars?: AvatarStorage) =>
      createServer(
        createApp({
          config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 50 },
          places: new MockPlacesProvider(),
          weather,
          social: createSocial({ db, verifier: createVerifier({ jwtSecret: SECRET }), avatars, limits: { writesPerHour: 1000 } }),
          log: () => {},
        }),
      );
    server = make(storage);
    offServer = make(undefined);
    base = await listen(server);
    offBase = await listen(offServer);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => offServer.close(() => r()));
    await db.close();
  });

  describe('profile pictures', () => {
    it('uploads, replaces and removes a photo, cleaning up the old file', async () => {
      const a = await person('pic');
      const first = await upload(a.t, png(512, 512));
      expect(first.status).toBe(200);
      expect(first.body.profile.avatar).toMatch(new RegExp(`^https://files.example/avatars/${a.id}/.+\\.png$`));
      expect(stored.size).toBeGreaterThan(0);
      const oldUrl = first.body.profile.avatar as string;
      const second = await upload(a.t, png(256, 256));
      expect(second.body.profile.avatar).not.toBe(oldUrl);
      expect([...stored.keys()].filter((k) => k.startsWith(a.id))).toHaveLength(1);
      expect((await a.as('GET', '/v1/me')).body.profile.avatar).toBe(second.body.profile.avatar);
      const gone = await a.as('DELETE', '/v1/me/avatar');
      expect(gone.body.profile.avatar).toBeNull();
      expect([...stored.keys()].filter((k) => k.startsWith(a.id))).toHaveLength(0);
    });

    it('refuses what is not a small JPEG, PNG or WebP', async () => {
      const a = await person('bad');
      expect((await upload(a.t, Buffer.from('<svg/>'), 'image/svg+xml')).body.code).toBe('avatar_type');
      expect((await upload(a.t, Buffer.from('not an image at all, just text'), 'image/png')).body.code).toBe('avatar_type');
      expect((await upload(a.t, Buffer.alloc(0))).status).toBe(400);
      expect((await upload(a.t, png(16, 16))).body.code).toBe('avatar_small');
      expect((await upload(a.t, png(4000, 4000))).body.code).toBe('avatar_dimensions');
      expect((await upload(a.t, png(512, 512, 3 * 1024 * 1024))).status).toBe(413);
      // The declared type must match what the bytes are.
      expect((await upload(a.t, png(512, 512), 'image/jpeg')).body.code).toBe('avatar_type');
      expect((await a.as('GET', '/v1/me')).body.profile.avatar).toBeNull();
    });

    it('says so plainly when photo storage is not set up', async () => {
      const a = await person('off');
      const res = await upload(a.t, png(512, 512), 'image/png', offBase);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('avatars_off');
    });

    it("keeps one person's photo link out of another's profile", async () => {
      const a = await person('own');
      const b = await person('other');
      await upload(a.t, png(300, 300));
      expect((await b.as('GET', '/v1/me')).body.profile.avatar).toBeNull();
    });
  });

  describe('profile settings and privacy', () => {
    it('saves the new fields, merges notification choices, and limits what others see', async () => {
      const a = await person('priv', { bio: 'Climber', pronouns: 'she/her', interests: ['climbing', 'coffee'], profileVisibility: 'only_me', showMutualCount: true });
      const me = (await a.as('GET', '/v1/me')).body.profile;
      expect(me).toMatchObject({ pronouns: 'she/her', interests: ['climbing', 'coffee'], profileVisibility: 'only_me', showMutualCount: true, whoCanInvite: 'everyone' });
      await a.as('PATCH', '/v1/me', { notify: { hearts: false } });
      expect((await a.as('GET', '/v1/me')).body.profile.notify).toEqual({ hearts: false, invitations: true, shares: true, connections: true });
      expect((await a.as('PATCH', '/v1/me', { profileVisibility: 'public' })).status).toBe(400);
      expect((await a.as('PATCH', '/v1/me', { interests: Array(11).fill('x') })).status).toBe(400);

      const b = await person('viewer');
      const card = (await b.as('GET', `/v1/users/${a.id}`)).body.user;
      expect(card).toMatchObject({ displayName: 'priv', full: false, bio: '', pronouns: '', interests: [], connection: 'none' });
      expect(card.mutualCount).toBeUndefined();
      // The owner always sees everything.
      expect((await a.as('GET', `/v1/users/${a.id}`)).body.user).toMatchObject({ full: true, bio: 'Climber' });
      // Search results never carry the bio.
      const found = (await b.as('GET', `/v1/users?q=${encodeURIComponent('priv')}`)).body.users;
      expect(found[0]).toMatchObject({ displayName: 'priv', bio: '' });
    });

    it('shows a mutuals-only profile to mutuals, and the count only when allowed', async () => {
      const a = await person('mut', { bio: 'Hello', profileVisibility: 'mutuals', showMutualCount: true });
      const b = await person('friend');
      const c = await person('stranger');
      expect((await c.as('GET', `/v1/users/${a.id}`)).body.user).toMatchObject({ full: false, bio: '' });
      await connect2(a, b);
      const seen = (await b.as('GET', `/v1/users/${a.id}`)).body.user;
      expect(seen).toMatchObject({ full: true, bio: 'Hello', connection: 'mutual', mutualCount: 1 });
      await a.as('PATCH', '/v1/me', { showMutualCount: false });
      expect((await b.as('GET', `/v1/users/${a.id}`)).body.user.mutualCount).toBeUndefined();
    });

    it('does not reveal people who are not findable', async () => {
      const hidden = await person('hidden', { discoverable: false });
      const b = await person('seeker');
      expect((await b.as('GET', `/v1/users/${hidden.id}`)).status).toBe(404);
      expect((await b.as('POST', '/v1/connections/requests', { userId: hidden.id })).status).toBe(404);
    });
  });

  describe('mutual connections', () => {
    it('needs a request and a yes, and shows each side the right lists', async () => {
      const a = await person('ask');
      const b = await person('answer');
      const sent = await a.as('POST', '/v1/connections/requests', { userId: b.id });
      expect(sent.body.connection.state).toBe('request_sent');
      expect((await a.as('GET', '/v1/connections')).body.outgoing).toHaveLength(1);
      expect((await b.as('GET', '/v1/connections')).body.incoming[0].person.id).toBe(a.id);
      expect((await b.as('GET', `/v1/users/${a.id}`)).body.user.connection).toBe('request_received');
      // Only the person asked can answer.
      expect((await a.as('POST', `/v1/connections/${sent.body.connection.id}/accept`)).status).toBe(404);
      const note = (await b.as('GET', '/v1/notifications')).body.notifications[0];
      expect(note).toMatchObject({ type: 'connection_request', entityType: 'connection', available: true });
      expect(note.text).toContain('wants to connect');

      const done = await b.as('POST', `/v1/connections/${sent.body.connection.id}/accept`);
      expect(done.body.mutuals.map((m: any) => m.person.id)).toEqual([a.id]);
      expect((await a.as('GET', '/v1/connections')).body.mutuals.map((m: any) => m.person.id)).toEqual([b.id]);
      expect((await a.as('GET', '/v1/notifications')).body.notifications[0].type).toBe('connection_accepted');
      // Accepting again changes nothing.
      expect((await b.as('POST', `/v1/connections/${sent.body.connection.id}/accept`)).status).toBe(200);
      expect((await a.as('POST', '/v1/connections/requests', { userId: b.id })).status).toBe(409);
    });

    it('stops duplicates, self-requests, and treats crossing requests as a yes', async () => {
      const a = await person('dup');
      const b = await person('dup2');
      expect((await a.as('POST', '/v1/connections/requests', { userId: a.id })).status).toBe(400);
      const one = await a.as('POST', '/v1/connections/requests', { userId: b.id });
      const again = await a.as('POST', '/v1/connections/requests', { userId: b.id });
      expect(again.body.connection.id).toBe(one.body.connection.id);
      expect((await db.query('select count(*)::int as n from segue.connections where requester_id = $1 or recipient_id = $1', [a.id]))[0]).toEqual({ n: 1 });
      // b asks a back: both wanted it, so they are mutuals.
      const crossed = await b.as('POST', '/v1/connections/requests', { userId: a.id });
      expect(crossed.body.connection.state).toBe('mutual');
    });

    it('lets people decline, cancel and remove; a declined asker waits before asking again', async () => {
      const a = await person('d1');
      const b = await person('d2');
      const first = await a.as('POST', '/v1/connections/requests', { userId: b.id });
      await b.as('POST', `/v1/connections/${first.body.connection.id}/decline`);
      expect((await b.as('GET', '/v1/connections')).body.incoming).toHaveLength(0);
      const retry = await a.as('POST', '/v1/connections/requests', { userId: b.id });
      expect(retry.status).toBe(429);
      expect(retry.body.code).toBe('request_cooldown');
      // The person who said no can ask instead.
      const turned = await b.as('POST', '/v1/connections/requests', { userId: a.id });
      expect(turned.body.connection.state).toBe('request_sent');
      // ...and cancel it.
      const cancelled = await b.as('DELETE', `/v1/connections/${turned.body.connection.id}`);
      expect(cancelled.body.outgoing).toHaveLength(0);
      expect((await a.as('GET', '/v1/notifications')).body.notifications.filter((n: any) => n.type === 'connection_request')).toHaveLength(0);

      const m = await connect2(a, b);
      expect((await a.as('DELETE', `/v1/connections/${m}`)).body.mutuals).toHaveLength(0);
      expect((await b.as('GET', '/v1/connections')).body.mutuals).toHaveLength(0);
      // A stranger cannot remove someone else's connection.
      const c = await person('d3');
      const m2 = await connect2(a, c);
      expect((await b.as('DELETE', `/v1/connections/${m2}`)).status).toBe(404);
    });

    it('respects the notification choice for connections', async () => {
      const a = await person('n1');
      const b = await person('n2', { notify: { connections: false } });
      await a.as('POST', '/v1/connections/requests', { userId: b.id });
      expect((await b.as('GET', '/v1/notifications')).body.notifications).toHaveLength(0);
      expect((await b.as('GET', '/v1/connections')).body.incoming).toHaveLength(1);
    });
  });

  describe('who can invite you', () => {
    const invite = (from: Person, to: Person) => from.as('POST', '/v1/invitations', { recipientIds: [to.id], title: 'Coffee', timezone: 'UTC' });

    it('follows the recipient’s choice', async () => {
      const a = await person('inv');
      const closed = await person('closed', { whoCanInvite: 'nobody' });
      const mutualsOnly = await person('only', { whoCanInvite: 'mutuals' });
      expect((await invite(a, closed)).body.code).toBe('invites_closed');
      expect((await invite(a, mutualsOnly)).status).toBe(403);
      await connect2(a, mutualsOnly);
      expect((await invite(a, mutualsOnly)).status).toBe(201);
      expect((await invite(a, await person('open'))).status).toBe(201);
    });
  });

  describe('shared plans with a time, and join requests with a message', () => {
    it('keeps a plan’s time, checks its order, and clears the end with the start', async () => {
      const a = await person('tim');
      const bad = await a.as('POST', '/v1/notes', { title: 'Study', onDate: '2026-11-07', startTime: '16:00', endTime: '14:00' });
      expect(bad.status).toBe(400);
      expect((await a.as('POST', '/v1/notes', { title: 'Study', endTime: '14:00' })).status).toBe(400);
      const note = (await a.as('POST', '/v1/notes', { title: 'Study', onDate: '2026-11-07', startTime: '14:00', endTime: '16:00', visibility: 'discoverable' })).body.note;
      expect([note.startTime, note.endTime]).toEqual(['14:00', '16:00']);
      const moved = (await a.as('PATCH', `/v1/notes/${note.id}`, { startTime: '15:00', endTime: '17:30' })).body.note;
      expect([moved.startTime, moved.endTime]).toEqual(['15:00', '17:30']);
      const cleared = (await a.as('PATCH', `/v1/notes/${note.id}`, { startTime: null })).body.note;
      expect([cleared.startTime, cleared.endTime]).toEqual([null, null]);
    });

    it('carries a message to the author only, prevents duplicates, can be taken back, and counts who is going', async () => {
      const a = await person('own');
      const b = await person('ask');
      const c = await person('see');
      await connect2(a, b);
      await connect2(a, c);
      const note = (await a.as('POST', '/v1/notes', { title: 'Run', visibility: 'selected', shareWith: [b.id, c.id], onDate: '2026-11-07', startTime: '07:00' })).body.note;

      expect((await b.as('POST', `/v1/notes/${note.id}/heart`, { message: 'I can bring water' })).status).toBe(200);
      // Asking twice is one request, not two; the author is told once.
      expect((await b.as('POST', `/v1/notes/${note.id}/heart`)).status).toBe(200);
      const asked = (await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests;
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toBe('I can bring water');
      expect((await a.as('GET', '/v1/notifications')).body.notifications.filter((n: any) => n.type === 'note_hearted')).toHaveLength(1);
      // Nobody else sees the request or its message.
      expect((await c.as('GET', `/v1/notes/${note.id}/interests`)).status).toBe(403);
      const seenByC = (await c.as('GET', `/v1/notes/${note.id}`)).body.note;
      expect(seenByC.heartCount).toBeUndefined();
      expect(seenByC.goingCount).toBeUndefined();
      expect(JSON.stringify(seenByC)).not.toContain('bring water');
      // Too long a message is refused.
      expect((await c.as('POST', `/v1/notes/${note.id}/heart`, { message: 'x'.repeat(281) })).status).toBe(400);

      // Yes: b is going, and the author sees the count.
      const yes = await a.as('POST', `/v1/notes/${note.id}/interests/${asked[0].id}/accept`, { timezone: 'UTC' });
      expect(yes.status).toBe(201);
      const mine = (await a.as('GET', `/v1/notes/${note.id}`)).body.note;
      expect([mine.heartCount, mine.goingCount, mine.pendingCount]).toEqual([1, 1, 0]);
      expect((await b.as('GET', `/v1/notes/${note.id}`)).body.note.interest).toBe('accepted');

      // c asks and takes it back: no longer listed for the author.
      await c.as('POST', `/v1/notes/${note.id}/heart`, { message: 'Maybe?' });
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests).toHaveLength(2);
      expect((await a.as('GET', `/v1/notes/${note.id}`)).body.note.pendingCount).toBe(1);
      await c.as('DELETE', `/v1/notes/${note.id}/heart`);
      expect((await a.as('GET', `/v1/notes/${note.id}/interests`)).body.interests.map((i: any) => i.user.id)).toEqual([b.id]);
    });
  });

  describe('blocking', () => {
    it('removes everything between two people and hides each from the other', async () => {
      const a = await person('blk');
      const b = await person('bkd');
      await connect2(a, b);
      const note = (await a.as('POST', '/v1/notes', { title: 'Hike', visibility: 'selected', shareWith: [b.id] })).body.note;
      const theirs = (await b.as('POST', '/v1/notes', { title: 'Brunch', visibility: 'discoverable' })).body.note;
      await b.as('POST', `/v1/notes/${note.id}/heart`);
      await a.as('POST', `/v1/notes/${theirs.id}/heart`);
      const inv = (await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Hike', timezone: 'UTC' })).body.invitations[0];

      const res = await a.as('POST', '/v1/blocks', { userId: b.id });
      expect(res.status).toBe(200);
      expect(res.body.blocked.map((x: any) => x.person.id)).toEqual([b.id]);
      expect(res.body.mutuals).toHaveLength(0);

      // Neither can find or see the other.
      expect((await b.as('GET', `/v1/users/${a.id}`)).status).toBe(404);
      expect((await a.as('GET', `/v1/users/${b.id}`)).status).toBe(404);
      expect((await b.as('GET', `/v1/notes/${note.id}`)).status).toBe(404);
      expect((await a.as('GET', `/v1/notes/${theirs.id}`)).status).toBe(404);
      expect((await b.as('GET', `/v1/users?q=${encodeURIComponent('blk')}`)).body.users).toHaveLength(0);
      expect((await a.as('GET', `/v1/users?q=${encodeURIComponent('bkd')}`)).body.users).toHaveLength(0);
      expect((await b.as('GET', '/v1/notes?scope=discover')).body.notes.find((n: any) => n.id === note.id)).toBeUndefined();
      expect((await a.as('GET', '/v1/notes?scope=discover')).body.notes.find((n: any) => n.id === theirs.id)).toBeUndefined();

      // Nothing new can pass between them.
      expect((await b.as('POST', '/v1/connections/requests', { userId: a.id })).status).toBe(404);
      expect((await a.as('POST', '/v1/connections/requests', { userId: b.id })).status).toBe(404);
      expect((await a.as('POST', '/v1/invitations', { recipientIds: [b.id], title: 'Again', timezone: 'UTC' })).status).toBe(400);
      expect((await b.as('POST', '/v1/invitations', { recipientIds: [a.id], title: 'Again', timezone: 'UTC' })).status).toBe(400);
      expect((await a.as('PATCH', `/v1/notes/${note.id}`, { shareWith: [b.id] })).status).toBe(400);
      expect((await b.as('POST', `/v1/notes/${note.id}/heart`)).status).toBe(404);

      // The open invitation is cancelled, hearts are withdrawn, and the author no longer sees the heart.
      expect((await db.query('select status from segue.invitations where id = $1', [inv.id]))[0]).toEqual({ status: 'cancelled' });
      expect((await db.query('select count(*)::int as n from segue.note_interests where withdrawn_at is null and (user_id = $1 or user_id = $2)', [a.id, b.id]))[0]).toEqual({ n: 0 });
      expect((await db.query('select count(*)::int as n from segue.note_shares'))[0]!.n).toBeGreaterThanOrEqual(0);
      expect((await db.query('select count(*)::int as n from segue.note_shares where note_id = $1', [note.id]))[0]).toEqual({ n: 0 });
      expect((await a.as('GET', '/v1/notifications')).body.notifications.filter((n: any) => n.actor?.id === b.id)).toHaveLength(0);
    });

    it('does not notify across a block, and unblocking does not bring anything back', async () => {
      const a = await person('ub1');
      const b = await person('ub2');
      await a.as('POST', '/v1/blocks', { userId: b.id });
      const before = (await b.as('GET', '/v1/notifications')).body.notifications.length;
      expect(before).toBe(0);
      const after = await a.as('DELETE', `/v1/blocks/${b.id}`);
      expect(after.body.blocked).toHaveLength(0);
      expect((await a.as('GET', '/v1/connections')).body.mutuals).toHaveLength(0);
      expect((await b.as('GET', `/v1/users/${a.id}`)).status).toBe(200);
      // Blocking someone twice is fine; blocking yourself or a stranger is not.
      expect((await a.as('POST', '/v1/blocks', { userId: b.id })).status).toBe(200);
      expect((await a.as('POST', '/v1/blocks', { userId: b.id })).status).toBe(200);
      expect((await a.as('POST', '/v1/blocks', { userId: a.id })).status).toBe(400);
      expect((await a.as('POST', '/v1/blocks', { userId: randomUUID() })).status).toBe(404);
    });
  });
});
