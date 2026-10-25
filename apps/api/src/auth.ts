/**
 * Who is calling. The web app signs in with Supabase Auth and sends its
 * access token (a JWT) as "Authorization: Bearer …". We check the signature
 * against Supabase's public keys (or the legacy HS256 secret), then the
 * expiry, issuer and audience. Nothing from the client is trusted for identity.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export interface AuthUser {
  id: string;
  email?: string;
}

export interface Verifier {
  verify(token: string): Promise<AuthUser>;
}

export class AuthError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWKS_TTL_MS = 10 * 60_000;

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface Header {
  alg?: string;
  kid?: string;
}
interface Claims {
  sub?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
  email?: string;
}

export interface VerifierOptions {
  /** https://<project>.supabase.co; its JWKS and issuer are used. */
  supabaseUrl?: string;
  /** Legacy shared secret (HS256). */
  jwtSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createVerifier(opts: VerifierOptions): Verifier {
  const issuer = opts.supabaseUrl ? `${opts.supabaseUrl}/auth/v1` : undefined;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let keys: { at: number; byKid: Map<string, KeyObject> } | null = null;

  async function publicKey(kid: string | undefined): Promise<KeyObject | undefined> {
    if (!opts.supabaseUrl || !kid) return undefined;
    const stale = !keys || now() - keys.at > JWKS_TTL_MS;
    // A key we haven't seen may have just been rotated in: refetch, at most once a minute.
    const unknown = keys && !keys.byKid.has(kid) && now() - keys.at > 60_000;
    if (stale || unknown) {
      const res = await doFetch(`${opts.supabaseUrl}/auth/v1/.well-known/jwks.json`);
      if (!res.ok) throw new AuthError('Could not load sign-in keys');
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
      const byKid = new Map<string, KeyObject>();
      for (const k of body.keys ?? []) {
        if (!k.kid) continue;
        try {
          byKid.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
        } catch {
          // skip keys this runtime can't read
        }
      }
      keys = { at: now(), byKid };
    }
    return keys?.byKid.get(kid);
  }

  return {
    async verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) throw new AuthError('Malformed token');
      const [h, p, s] = parts as [string, string, string];
      let header: Header;
      let claims: Claims;
      try {
        header = JSON.parse(b64url(h).toString('utf8')) as Header;
        claims = JSON.parse(b64url(p).toString('utf8')) as Claims;
      } catch {
        throw new AuthError('Malformed token');
      }
      const signed = Buffer.from(`${h}.${p}`);
      const sig = b64url(s);
      let ok = false;
      if (header.alg === 'HS256') {
        if (!opts.jwtSecret) throw new AuthError('Unsupported token');
        const expected = createHmac('sha256', opts.jwtSecret).update(signed).digest();
        ok = expected.length === sig.length && timingSafeEqual(expected, sig);
      } else if (header.alg === 'ES256' || header.alg === 'RS256') {
        const key = await publicKey(header.kid);
        if (!key) throw new AuthError('Unknown signing key');
        ok =
          header.alg === 'ES256'
            ? verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, sig)
            : verify('sha256', signed, key, sig);
      } else {
        throw new AuthError('Unsupported token');
      }
      if (!ok) throw new AuthError('Bad signature');
      const t = now() / 1000;
      if (typeof claims.exp !== 'number' || claims.exp < t - 30) throw new AuthError('Token expired');
      if (typeof claims.nbf === 'number' && claims.nbf > t + 30) throw new AuthError('Token not valid yet');
      if (issuer && claims.iss !== issuer) throw new AuthError('Wrong issuer');
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes('authenticated') || claims.role !== 'authenticated') throw new AuthError('Not a signed-in user');
      if (!claims.sub || !UUID.test(claims.sub)) throw new AuthError('Bad subject');
      return { id: claims.sub.toLowerCase(), email: claims.email };
    },
  };
}

/** The bearer token from a request, if any. */
export function bearer(header: string | string[] | undefined): string | undefined {
  const v = Array.isArray(header) ? header[0] : header;
  const m = v?.match(/^Bearer\s+([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/);
  return m?.[1];
}

/**
 * Removes the sign-in itself (Supabase Auth admin API). Needs the secret key:
 * either the legacy service_role JWT (also sent as a bearer token) or a newer
 * "sb_secret_…" key (apikey header only; it isn't a JWT).
 */
export async function deleteAuthUser(supabaseUrl: string, serviceRoleKey: string, userId: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  const res = await doFetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: serviceRoleKey.startsWith('eyJ') ? { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` } : { apikey: serviceRoleKey },
  });
  return res.ok || res.status === 404;
}
