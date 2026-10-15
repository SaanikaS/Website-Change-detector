import { db } from './db.js';
import { config } from './config.js';

const insertJob = db.prepare(
  `INSERT INTO jobs (type, key, payload, status, attempts, max_attempts, run_at, created_at)
   VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`
);
const findActiveByKey = db.prepare(
  `SELECT id FROM jobs WHERE key = ? AND status IN ('queued','running')`
);
const pickNext = db.prepare(
  `SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1`
);
const lockJob = db.prepare(
  `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1 WHERE id = ?`
);

/** Add a job. If `key` is set and an identical job is already queued/running, nothing is added. */
export function enqueue(type, { key = null, payload = {}, runAt = Date.now(), maxAttempts = config.maxAttempts } = {}) {
  return db.transaction(() => {
    if (key && findActiveByKey.get(key)) return null;
    return Number(
      insertJob.run(type, key, JSON.stringify(payload), maxAttempts, runAt, Date.now()).lastInsertRowid
    );
  })();
}

/** Atomically take the next ready job (or null). */
export const claim = db.transaction(() => {
  const now = Date.now();
  const job = pickNext.get(now);
  if (!job) return null;
  lockJob.run(now, job.id);
  return { ...job, attempts: job.attempts + 1, payload: JSON.parse(job.payload) };
});

export function complete(id) {
  db.prepare(`UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = ?`).run(id);
}

/** Put the job back without consuming a retry (used for per-host throttling). */
export function defer(id, ms) {
  db.prepare(
    `UPDATE jobs SET status = 'queued', run_at = ?, attempts = MAX(attempts - 1, 0), locked_at = NULL WHERE id = ?`
  ).run(Date.now() + ms, id);
}

/** Record a failure. Returns true when retries are exhausted. */
export function fail(job, err) {
  const final = job.attempts >= job.max_attempts;
  const backoff = Math.min(30_000 * 2 ** (job.attempts - 1), 30 * 60_000);
  db.prepare(
    `UPDATE jobs SET status = ?, run_at = ?, locked_at = NULL, last_error = ? WHERE id = ?`
  ).run(final ? 'failed' : 'queued', Date.now() + backoff, String(err?.message || err).slice(0, 500), job.id);
  return final;
}

/** Jobs stuck in "running" (process crashed) go back to the queue. */
export function recoverStale() {
  db.prepare(
    `UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < ?`
  ).run(Date.now() - config.jobTimeoutMs * 2);
}

export function cleanupJobs() {
  db.prepare(`DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < ?`).run(
    Date.now() - 7 * 24 * 3600_000
  );
}
