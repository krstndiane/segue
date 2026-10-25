/**
 * Profile pictures. The browser crops and shrinks the photo, then sends the
 * image bytes here; we check they really are a small JPEG, PNG or WebP and
 * store them in Supabase Storage (public "avatars" bucket) under the person's
 * own folder. The profile keeps only the public link and the storage key.
 *
 * The server does not re-encode images (there is no image library in this
 * service), so it refuses anything it can't positively identify and measure.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http';
import { path, type Ctx, type Route } from './core';
import { myProfile } from './views';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MAX_SIDE = 1024;
export const AVATAR_MIN_SIDE = 32;

export interface AvatarStorage {
  /** Stores the bytes at `key` and returns the public https link. */
  put(key: string, bytes: Buffer, contentType: string): Promise<string>;
  remove(key: string): Promise<void>;
}

export function supabaseAvatarStorage(supabaseUrl: string, secretKey: string, doFetch: typeof fetch = fetch): AvatarStorage {
  const headers: Record<string, string> = secretKey.startsWith('eyJ') ? { apikey: secretKey, authorization: `Bearer ${secretKey}` } : { apikey: secretKey };
  const object = (key: string) => `${supabaseUrl}/storage/v1/object/avatars/${key.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async put(key, bytes, contentType) {
      const res = await doFetch(object(key), { method: 'POST', headers: { ...headers, 'content-type': contentType, 'cache-control': 'max-age=31536000' }, body: new Uint8Array(bytes) });
      if (!res.ok) throw new Error(`storage upload failed (${res.status})`);
      return `${supabaseUrl}/storage/v1/object/public/avatars/${key.split('/').map(encodeURIComponent).join('/')}`;
    },
    async remove(key) {
      const res = await doFetch(object(key), { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404 && res.status !== 400) throw new Error(`storage delete failed (${res.status})`);
    },
  };
}

export interface ImageInfo {
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

/** Identifies the format from its first bytes and reads the size from its header. Null if it isn't a plain JPEG, PNG or WebP. */
export function imageInfo(b: Buffer): ImageInfo | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { type: 'image/webp', ext: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: 'image/webp', ext: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size (not DHT 0xC4, JPG 0xC8, DAC 0xCC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function readBytes(ctx: Ctx, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of ctx.req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'That photo is too large. Pick a smaller one.', undefined, {}, 'avatar_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function storageOrOff(ctx: Ctx): AvatarStorage {
  if (!ctx.deps.avatars) throw new HttpError(503, 'Profile photos are not switched on yet.', undefined, {}, 'avatars_off');
  return ctx.deps.avatars;
}

async function removeObject(ctx: Ctx, key: unknown) {
  if (typeof key !== 'string' || !key) return;
  try {
    await ctx.deps.avatars?.remove(key);
  } catch (e) {
    ctx.deps.log?.(`avatar cleanup failed: ${(e as Error).message}`);
  }
}

export const avatarRoutes: Route[] = [
  {
    method: 'POST',
    path: path('/v1/me/avatar'),
    async handler(ctx) {
      const me = await ctx.profile();
      const storage = storageOrOff(ctx);
      ctx.limit('write');
      if (Number(ctx.req.headers['content-length'] ?? 0) > AVATAR_MAX_BYTES) throw new HttpError(413, 'That photo is too large. Pick a smaller one.', undefined, {}, 'avatar_too_large');
      const bytes = await readBytes(ctx, AVATAR_MAX_BYTES);
      const info = bytes.length ? imageInfo(bytes) : null;
      if (!info) throw new HttpError(400, 'Use a JPEG, PNG or WebP photo.', undefined, {}, 'avatar_type');
      if (info.width < AVATAR_MIN_SIDE || info.height < AVATAR_MIN_SIDE) throw new HttpError(400, 'That photo is too small.', undefined, {}, 'avatar_small');
      if (info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) throw new HttpError(400, 'That photo is too large. Pick a smaller one.', undefined, {}, 'avatar_dimensions');
      const declared = String(ctx.req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (declared && declared !== info.type && declared !== 'application/octet-stream') throw new HttpError(400, 'Use a JPEG, PNG or WebP photo.', undefined, {}, 'avatar_type');

      const key = `${ctx.user.id}/${randomUUID()}.${info.ext}`;
      let url: string;
      try {
        url = await storage.put(key, bytes, info.type);
      } catch (e) {
        ctx.deps.log?.(`avatar upload failed: ${(e as Error).message}`);
        throw new HttpError(503, "Couldn't save your photo just now. Try again in a moment.", undefined, {}, 'avatar_failed');
      }
      let row;
      try {
        row = (await ctx.db.query('update segue.profiles set avatar = $2, avatar_key = $3, updated_at = now() where id = $1 returning *', [ctx.user.id, url, key]))[0]!;
      } catch (e) {
        await removeObject(ctx, key);
        throw e;
      }
      await removeObject(ctx, me.avatar_key);
      return { status: 200, body: { profile: myProfile(row), email: ctx.user.email } };
    },
  },
  {
    method: 'DELETE',
    path: path('/v1/me/avatar'),
    async handler(ctx) {
      const me = await ctx.profile();
      ctx.limit('write');
      const row = (await ctx.db.query('update segue.profiles set avatar = null, avatar_key = null, updated_at = now() where id = $1 returning *', [ctx.user.id]))[0]!;
      await removeObject(ctx, me.avatar_key);
      return { status: 200, body: { profile: myProfile(row), email: ctx.user.email } };
    },
  },
];

export { removeObject as removeAvatarObject };
