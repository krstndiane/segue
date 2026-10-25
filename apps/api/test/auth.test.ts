import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, createVerifier } from '../src/auth';

const URL_ = 'https://abc.supabase.co';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig' };

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function es256(claims: Record<string, unknown>, kid = 'key-1') {
  const head = b64({ alg: 'ES256', kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = createSign('sha256').update(`${head}.${body}`).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const good = (over: Record<string, unknown> = {}) => ({
  sub: randomUUID(),
  aud: 'authenticated',
  role: 'authenticated',
  iss: `${URL_}/auth/v1`,
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

function jwksFetch() {
  let calls = 0;
  const f = (async () => {
    calls++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
}

describe('Supabase sign-in tokens', () => {
  it('accepts a token signed with the project key, and caches the keys', async () => {
    const { f, calls } = jwksFetch();
    const v = createVerifier({ supabaseUrl: URL_, fetch: f });
    const claims = good();
    expect(await v.verify(es256(claims))).toMatchObject({ id: claims.sub });
    await v.verify(es256(good()));
    expect(calls()).toBe(1);
  });

  it('rejects the wrong issuer, audience, a tampered body, an unknown key or a missing expiry', async () => {
    const { f } = jwksFetch();
    const v = createVerifier({ supabaseUrl: URL_, fetch: f });
    await expect(v.verify(es256(good({ iss: 'https://evil.supabase.co/auth/v1' })))).rejects.toThrow('Wrong issuer');
    await expect(v.verify(es256(good({ aud: 'anon', role: 'anon' })))).rejects.toThrow();
    await expect(v.verify(es256(good({ exp: undefined })))).rejects.toThrow('expired');
    await expect(v.verify(es256(good(), 'other-key'))).rejects.toThrow();
    const t = es256(good());
    const [h, , s] = t.split('.');
    await expect(v.verify(`${h}.${b64(good({ sub: randomUUID() }))}.${s}`)).rejects.toThrow('Bad signature');
    // "none" and HS256 without a configured secret are refused outright.
    await expect(v.verify(`${b64({ alg: 'none' })}.${b64(good())}.`)).rejects.toThrow();
    await expect(v.verify(`${b64({ alg: 'HS256' })}.${b64(good())}.abc`)).rejects.toThrow('Unsupported');
  });

  it('reads only well-formed bearer headers', () => {
    expect(bearer('Bearer a.b.c')).toBe('a.b.c');
    expect(bearer('Basic abc')).toBeUndefined();
    expect(bearer('Bearer a.b')).toBeUndefined();
    expect(bearer(undefined)).toBeUndefined();
  });
});
