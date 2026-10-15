import { db } from './db.js';
import { config } from './config.js';
import { enqueue } from './queue.js';
import { getMonitor } from './monitors.js';

export function channelsFor(m) {
  const c = [];
  if (m.notify_email) c.push({ type: 'email', target: m.notify_email });
  if (m.discord_webhook) c.push({ type: 'discord', target: m.discord_webhook });
  if (m.telegram_chat_id) c.push({ type: 'telegram', target: m.telegram_chat_id });
  return c;
}

export const diffLink = (monitorId, from, to) =>
  `${config.baseUrl}/diff.html?monitor=${monitorId}&from=${from}&to=${to}`;

function fanout(channels, message) {
  for (const channel of channels) {
    enqueue('notify', { payload: { channel, ...message }, maxAttempts: 5 });
  }
}

/** "Page is down/blocked" and "recovered" alerts. These are never reported as content changes. */
export function queueStatusAlert(m, kind, detail = '') {
  const key = `${kind}:${m.id}:${Date.now()}`;
  const ins = db
    .prepare('INSERT OR IGNORE INTO alerts (monitor_id, dedupe_key, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(m.id, key, kind, Date.now());
  if (!ins.changes) return;
  const subject =
    kind === 'down' ? `Can't check "${m.name}"` : `"${m.name}" is reachable again`;
  const text =
    kind === 'down'
      ? `${m.name} (${m.url}) has failed ${config.failureAlertThreshold} checks in a row.\nReason: ${detail}\nThis is reported as a status problem, not a content change.`
      : `${m.name} (${m.url}) is being checked successfully again.`;
  fanout(channelsFor(m), { subject, text });
}

/**
 * Sends ONE alert for all pending significant changes of a monitor, respecting the cooldown.
 * Dedupe: the alerts table has a UNIQUE key per (monitor, latest change), so a change is never alerted twice.
 */
export function flushAlerts(monitorId) {
  const m = getMonitor(monitorId);
  if (!m || m.digest) return;
  const pending = db
    .prepare('SELECT * FROM changes WHERE monitor_id = ? AND significant = 1 AND alerted = 0 ORDER BY id')
    .all(monitorId);
  if (!pending.length) return;
  const cooldownMs = config.alertCooldownMin * 60_000;
  if (m.last_alert_at && Date.now() - m.last_alert_at < cooldownMs) return;

  const first = pending[0];
  const last = pending[pending.length - 1];
  const ids = pending.map((c) => c.id);
  const markAlerted = () =>
    db.prepare(`UPDATE changes SET alerted = 1 WHERE id IN (${ids.join(',')})`).run();

  const ins = db
    .prepare('INSERT OR IGNORE INTO alerts (monitor_id, dedupe_key, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(m.id, `change:${m.id}:${last.id}`, 'change', Date.now());
  markAlerted();
  if (!ins.changes) return;

  const summary =
    pending.length === 1 ? last.summary : `${pending.length} changes since last alert. Latest: ${last.summary}`;
  const link = diffLink(m.id, first.from_snapshot_id, last.to_snapshot_id);
  fanout(channelsFor(m), {
    subject: `Change detected: ${m.name}`,
    text: `${summary}\n\nPage: ${m.url}\nView diff: ${link}`,
  });
  db.prepare('UPDATE monitors SET last_alert_at = ? WHERE id = ?').run(Date.now(), m.id);
}

export function flushAllPending() {
  const rows = db
    .prepare(
      `SELECT DISTINCT c.monitor_id AS id FROM changes c JOIN monitors m ON m.id = c.monitor_id
       WHERE m.digest = 0 AND c.significant = 1 AND c.alerted = 0`
    )
    .all();
  for (const r of rows) flushAlerts(r.id);
}

/** Daily digest: one message per recipient listing every pending change of "digest" monitors. */
export function buildDigest() {
  const rows = db
    .prepare(
      `SELECT c.*, m.name, m.url, m.notify_email, m.discord_webhook, m.telegram_chat_id
       FROM changes c JOIN monitors m ON m.id = c.monitor_id
       WHERE m.digest = 1 AND m.active = 1 AND c.significant = 1 AND c.alerted = 0 ORDER BY c.id`
    )
    .all();
  if (!rows.length) return 0;
  const buckets = new Map();
  for (const r of rows) {
    for (const ch of channelsFor(r)) {
      const k = `${ch.type}:${ch.target}`;
      if (!buckets.has(k)) buckets.set(k, { ch, items: [] });
      buckets.get(k).items.push(r);
    }
  }
  for (const { ch, items } of buckets.values()) {
    const text = items
      .map((r) => `• ${r.name}: ${r.summary}\n  ${diffLink(r.monitor_id, r.from_snapshot_id, r.to_snapshot_id)}`)
      .join('\n\n');
    enqueue('notify', {
      payload: { channel: ch, subject: `Daily digest: ${items.length} change(s)`, text },
      maxAttempts: 5,
    });
  }
  db.prepare(`UPDATE changes SET alerted = 1 WHERE id IN (${rows.map((r) => r.id).join(',')})`).run();
  return rows.length;
}
