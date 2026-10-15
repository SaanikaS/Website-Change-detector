import { db } from './db.js';
import { config } from './config.js';
import { enqueue, recoverStale, cleanupJobs } from './queue.js';
import { flushAllPending, buildDigest } from './alerts.js';
import { log } from './util.js';

function enqueueDueChecks() {
  // One job per distinct URL, however many monitors/users watch it.
  const urls = db
    .prepare('SELECT DISTINCT normalized_url FROM monitors WHERE active = 1 AND next_check_at <= ?')
    .all(Date.now());
  for (const { normalized_url } of urls) {
    enqueue('check', { key: `check:${normalized_url}`, payload: { url: normalized_url } });
  }
}

function maybeDigest() {
  const now = new Date();
  if (now.getHours() !== config.digestHour) return;
  const today = now.toISOString().slice(0, 10);
  const row = db.prepare("SELECT v FROM kv WHERE k = 'last_digest_date'").get();
  if (row?.v === today) return;
  db.prepare("INSERT INTO kv (k, v) VALUES ('last_digest_date', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(today);
  const n = buildDigest();
  if (n) log(`digest queued (${n} changes)`);
}

export function startScheduler() {
  const tick = () => {
    try {
      recoverStale();
      enqueueDueChecks();
      flushAllPending(); // alerts that were held back by the cooldown
      maybeDigest();
      cleanupJobs();
    } catch (e) {
      log('scheduler error:', e);
    }
  };
  tick();
  return setInterval(tick, 30_000);
}
