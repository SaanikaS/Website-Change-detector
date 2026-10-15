import { db } from './db.js';
import { config } from './config.js';

/** Milliseconds to wait before this host may be requested again (0 = go ahead). */
export function hostWait(host) {
  const row = db.prepare('SELECT next_allowed_at FROM host_state WHERE host = ?').get(host);
  const wait = row ? row.next_allowed_at - Date.now() : 0;
  return wait > 0 ? wait : 0;
}

/** Reserve the host: nobody may hit it again for `gapMs` (+ jitter). Never shortens an existing backoff. */
export function markHost(host, gapMs = config.hostMinGapMs) {
  const next = Date.now() + gapMs + Math.floor(Math.random() * gapMs * 0.3);
  db.prepare(
    `INSERT INTO host_state (host, next_allowed_at) VALUES (?, ?)
     ON CONFLICT(host) DO UPDATE SET next_allowed_at = MAX(next_allowed_at, excluded.next_allowed_at)`
  ).run(host, next);
}

export const backoffHost = (host, ms) => markHost(host, ms);
