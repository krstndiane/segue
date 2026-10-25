/** Small HTTP helpers shared by every route. */
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
    /** A stable word the app can branch on, e.g. "profile_required" */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const MAX_BODY_BYTES = 256 * 1024;

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), ...headers });
  res.end(json);
}

/** The JSON body. `optional` allows an empty body (read as {}). */
export async function readJson(req: IncomingMessage, { limit = MAX_BODY_BYTES, optional = false } = {}): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) {
    if (optional) return {};
    throw new HttpError(400, 'Expected a JSON body');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}
