import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { openPage } from './render.js';
import { normalizeText, intersectLines } from './normalize.js';
import { computeTextDiff, isSignificant, heuristicSummary } from './diff.js';
import { aiSummary } from './ai.js';
import { prepareScreenshot, diffImages } from './image.js';
import { dueMonitors, toRuntime } from './monitors.js';
import { flushAlerts, queueStatusAlert } from './alerts.js';
import { hostWait, markHost, backoffHost } from './throttle.js';
import { sha256, sleep, log, assertPublicUrl } from './util.js';

const lastSnapshot = (monitorId) =>
  db.prepare('SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1').get(monitorId);

function nextCheck(m, factor, now) {
  const base = m.interval_min * 60_000;
  const ms = Math.min(base * factor, Math.max(base, 24 * 3600_000));
  const jitter = Math.floor(Math.random() * Math.min(base * 0.1, 300_000));
  return now + ms + jitter;
}

/**
 * Queue handler: ONE job per URL. The page is rendered once and shared by every monitor
 * (every user) watching that URL, no matter how many there are.
 */
export async function handleCheck(job) {
  const url = job.payload.url;
  const due = dueMonitors(url);
  if (!due.length) return;

  const host = new URL(url).hostname;
  const wait = hostWait(host);
  if (wait > 0) return { defer: wait + Math.floor(Math.random() * 1500) }; // politeness: not a retry
  markHost(host);

  await assertPublicUrl(url);
  const session = await openPage(url); // throws on timeouts/network errors -> queue retries with backoff
  try {
    if (session.state !== 'ok') {
      for (const m of due) recordFailure(m, session.state, session.detail);
      if (session.state === 'blocked') backoffHost(host, session.retryAfterMs ?? 15 * 60_000);
      return;
    }
    await processOk(session, due.map(toRuntime));
  } finally {
    await session.close();
  }
}

/** Called when all retries are exhausted. */
export function giveUp(job, err) {
  for (const m of dueMonitors(job.payload.url)) {
    recordFailure(m, 'error', `Check failed after ${job.attempts} attempts: ${err.message}`.slice(0, 300));
  }
}

async function processOk(session, monitors) {
  const first = await session.extract(monitors);
  const ctx = new Map();
  const candidates = [];

  for (const m of monitors) {
    const data = first[m.id];
    const t1 = normalizeText(data.text, { sensitivity: m.sensitivity });
    const prev = lastSnapshot(m.id);
    ctx.set(m.id, { data, t1, prev });
    if (!prev || sha256(prev.text) !== sha256(t1)) candidates.push(m);
  }

  // Something looks different (or it's a new monitor): load the page a second time a few seconds
  // later. Only text present in BOTH loads counts, so content that differs on every load
  // (random tips, rotating items, tokens) never produces alerts.
  let second = null;
  if (candidates.length) {
    await sleep(2500 + Math.floor(Math.random() * 1500));
    try {
      const verdict = await session.reload();
      if (verdict.state === 'ok') second = await session.extract(candidates);
      else log('recheck not ok:', verdict.detail);
    } catch (e) {
      log('recheck failed:', e.message);
    }
  }

  for (const m of monitors) {
    const c = ctx.get(m.id);
    try {
      if (candidates.includes(m)) {
        if (second) c.t2 = normalizeText(second[m.id].text, { sensitivity: m.sensitivity });
        else if (c.prev) c.skip = true; // cannot confirm the change this round; try again next interval
      }
      await recordSuccess(m, c, session);
    } catch (e) {
      log(`monitor ${m.id} failed:`, e);
    }
  }
}

async function recordSuccess(m, c, session) {
  const now = Date.now();
  let significant = false;

  if (!c.skip) {
    const text = c.t2 !== undefined ? intersectLines(c.t1, c.t2) : c.t1;
    const hash = sha256(text);

    if (!c.prev) {
      saveSnapshot(m, text, hash, c.data, session.screenshot, now); // baseline, no alert
    } else if (sha256(c.prev.text) !== hash) {
      // new content hash -> store a new snapshot
      const d = computeTextDiff(c.prev.text, text);
      significant = isSignificant(d, m.sensitivity, m.keywordList);
      const snap = saveSnapshot(m, text, hash, c.data, session.screenshot, now);

      let pixelPct = null;
      try {
        const a = fs.readFileSync(path.join(config.dataDir, c.prev.screenshot_path));
        const b = fs.readFileSync(path.join(config.dataDir, snap.screenshot_path));
        pixelPct = diffImages(a, b).diffPct;
      } catch {
        /* screenshot missing: skip pixel stats */
      }

      let summary = heuristicSummary(d);
      if (significant) summary = (await aiSummary(m, d)) || summary;

      db.prepare(
        `INSERT INTO changes (monitor_id, from_snapshot_id, to_snapshot_id, created_at, summary,
                              added, removed, change_ratio, pixel_diff_pct, significant)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(m.id, c.prev.id, snap.id, now, summary, d.added, d.removed, d.ratio, pixelPct, significant ? 1 : 0);
    }
  }

  const wasDown = m.down_alerted;
  db.prepare(
    `UPDATE monitors SET status = 'ok', status_detail = NULL, consecutive_failures = 0, down_alerted = 0,
       last_checked_at = ?, next_check_at = ?, last_changed_at = COALESCE(?, last_changed_at) WHERE id = ?`
  ).run(now, nextCheck(m, 1, now), significant ? now : null, m.id);

  if (wasDown) queueStatusAlert(m, 'recovered');
  flushAlerts(m.id);
}

/** Outage / CAPTCHA / HTTP error: recorded as a status, never as a content change, never a snapshot. */
function recordFailure(m, state, detail) {
  const now = Date.now();
  const failures = m.consecutive_failures + 1;
  const willAlert = failures >= config.failureAlertThreshold && !m.down_alerted;
  const factor = state === 'blocked' ? Math.min(2 ** failures, 8) : 1; // back off from sites that block us
  db.prepare(
    `UPDATE monitors SET status = ?, status_detail = ?, consecutive_failures = ?, down_alerted = ?,
       last_checked_at = ?, next_check_at = ? WHERE id = ?`
  ).run(state, detail, failures, willAlert ? 1 : m.down_alerted, now, nextCheck(m, factor, now), m.id);
  if (willAlert) queueStatusAlert(m, 'down', detail);
}

function saveSnapshot(m, text, hash, data, shot, now) {
  const info = db
    .prepare('INSERT INTO snapshots (monitor_id, created_at, content_hash, text) VALUES (?, ?, ?, ?)')
    .run(m.id, now, hash, text);
  const id = Number(info.lastInsertRowid);
  let rel = null;
  try {
    const img = prepareScreenshot(shot, { watchBoxes: data.watchBoxes, ignoreBoxes: data.ignoreBoxes });
    rel = path.join('screenshots', String(m.id), `${id}.png`);
    fs.mkdirSync(path.join(config.dataDir, 'screenshots', String(m.id)), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, rel), img.buffer);
    db.prepare('UPDATE snapshots SET screenshot_path = ?, width = ?, height = ? WHERE id = ?').run(
      rel, img.width, img.height, id
    );
  } catch (e) {
    log('screenshot save failed:', e.message);
    rel = null;
  }
  pruneSnapshots(m.id);
  return { id, screenshot_path: rel };
}

function pruneSnapshots(monitorId) {
  const old = db
    .prepare('SELECT id, screenshot_path FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?')
    .all(monitorId, config.snapshotRetention);
  for (const r of old) {
    if (r.screenshot_path) fs.rmSync(path.join(config.dataDir, r.screenshot_path), { force: true });
    db.prepare('DELETE FROM snapshots WHERE id = ?').run(r.id);
  }
}
