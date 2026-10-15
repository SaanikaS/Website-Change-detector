import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { config } from './config.js';
import { enqueue } from './queue.js';
import { getMonitor, publicView } from './monitors.js';
import { computeTextDiff } from './diff.js';
import { diffImages } from './image.js';
import { snapshotForPicker } from './render.js';
import { hostWait, markHost } from './throttle.js';
import { normalizeUrl, assertPublicUrl, randomToken, log } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DISCORD_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_RE = /^(-?\d{3,20}|@[A-Za-z0-9_]{4,64})$/;

function auth(req, res, next) {
  if (!config.adminToken) return next();
  const given = String(req.get('x-admin-token') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.adminToken);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v, max = 50) => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : [];
  return arr.map((s) => String(s).trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, 300));
};

async function parseInput(b, existing) {
  const out = {};
  const has = (k) => !existing || k in b;

  if (has('name')) {
    const name = str(b.name);
    if (!name || name.length > 100) throw bad('Name is required (max 100 characters)');
    out.name = name;
  }
  if (!existing) {
    let normalized;
    try {
      normalized = normalizeUrl(str(b.url));
    } catch (e) {
      throw bad(e.message === 'Invalid URL' ? 'Enter a valid URL, including https://' : e.message);
    }
    try {
      await assertPublicUrl(normalized);
    } catch (e) {
      throw bad(e.message);
    }
    out.url = str(b.url);
    out.normalized_url = normalized;
    out.host = new URL(normalized).hostname;
  }
  if (has('interval_min')) {
    const i = Number(b.interval_min ?? 60);
    if (!Number.isInteger(i) || i < config.minIntervalMin || i > config.maxIntervalMin) {
      throw bad(`Check interval must be between ${config.minIntervalMin} and ${config.maxIntervalMin} minutes`);
    }
    out.interval_min = i;
  }
  if (has('watch_selectors')) out.watch_selectors = JSON.stringify(list(b.watch_selectors));
  if (has('ignore_selectors')) out.ignore_selectors = JSON.stringify(list(b.ignore_selectors));
  if (has('keywords')) {
    const kw = Array.isArray(b.keywords) ? b.keywords : String(b.keywords ?? '').split(',');
    out.keywords = JSON.stringify(kw.map((k) => String(k).trim()).filter(Boolean).slice(0, 20));
  }
  if (has('sensitivity')) {
    const s = str(b.sensitivity) || 'medium';
    if (!['low', 'medium', 'high'].includes(s)) throw bad('Sensitivity must be low, medium or high');
    out.sensitivity = s;
  }
  if (has('notify_email')) {
    const v = str(b.notify_email);
    if (v && !EMAIL_RE.test(v)) throw bad('Invalid email address');
    out.notify_email = v || null;
  }
  if (has('discord_webhook')) {
    const v = str(b.discord_webhook);
    if (v && !DISCORD_RE.test(v)) throw bad('Invalid Discord webhook URL');
    out.discord_webhook = v || null;
  }
  if (has('telegram_chat_id')) {
    const v = str(b.telegram_chat_id);
    if (v && !TELEGRAM_RE.test(v)) throw bad('Invalid Telegram chat id (use the numeric id or @channelname)');
    out.telegram_chat_id = v || null;
  }
  if (has('digest')) out.digest = b.digest ? 1 : 0;
  return out;
}

const snapshotOf = (monitorId, id) =>
  db.prepare('SELECT * FROM snapshots WHERE id = ? AND monitor_id = ?').get(Number(id), monitorId);

const xmlEsc = (s) =>
  String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Per-page RSS feed (unguessable token instead of the admin token, so feed readers work)
  app.get('/rss/:file', (req, res) => {
    const token = req.params.file.replace(/\.xml$/, '');
    const m = db.prepare('SELECT * FROM monitors WHERE rss_token = ?').get(token);
    if (!m) return res.status(404).send('Not found');
    const items = db
      .prepare('SELECT * FROM changes WHERE monitor_id = ? AND significant = 1 ORDER BY id DESC LIMIT 50')
      .all(m.id);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
      `<title>${xmlEsc(m.name)} – changes</title><link>${xmlEsc(m.url)}</link>` +
      `<description>Meaningful changes detected on ${xmlEsc(m.url)}</description>` +
      items
        .map((c) => {
          const link = `${config.baseUrl}/diff.html?monitor=${m.id}&from=${c.from_snapshot_id}&to=${c.to_snapshot_id}`;
          return `<item><title>${xmlEsc(c.summary || 'Page changed')}</title><link>${xmlEsc(link)}</link>` +
            `<guid isPermaLink="false">change-${c.id}</guid><pubDate>${new Date(c.created_at).toUTCString()}</pubDate>` +
            `<description>${xmlEsc(`+${c.added} / -${c.removed} lines`)}</description></item>`;
        })
        .join('') +
      `</channel></rss>`;
    res.type('application/rss+xml').send(xml);
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  api.use(auth);

  api.get('/config', (req, res) =>
    res.json({
      minIntervalMin: config.minIntervalMin,
      maxIntervalMin: config.maxIntervalMin,
      emailConfigured: !!config.smtp.host,
      telegramConfigured: !!config.telegramBotToken,
      aiSummaries: !!config.anthropicKey,
    })
  );

  api.get('/monitors', (req, res) => {
    const rows = db
      .prepare(
        `SELECT m.*, (SELECT COUNT(*) FROM snapshots s WHERE s.monitor_id = m.id) AS snapshot_count
         FROM monitors m ORDER BY m.id DESC`
      )
      .all();
    res.json(rows.map((r) => ({ ...publicView(r), snapshot_count: r.snapshot_count })));
  });

  api.post(
    '/monitors',
    wrap(async (req, res) => {
      const f = await parseInput(req.body || {}, null);
      const now = Date.now();
      const info = db
        .prepare(
          `INSERT INTO monitors (name, url, normalized_url, host, interval_min, watch_selectors, ignore_selectors,
             sensitivity, keywords, notify_email, discord_webhook, telegram_chat_id, digest, next_check_at, rss_token, created_at)
           VALUES (@name, @url, @normalized_url, @host, @interval_min, @watch_selectors, @ignore_selectors,
             @sensitivity, @keywords, @notify_email, @discord_webhook, @telegram_chat_id, @digest, @next_check_at, @rss_token, @created_at)`
        )
        .run({ ...f, next_check_at: now, rss_token: randomToken(), created_at: now });
      enqueue('check', { key: `check:${f.normalized_url}`, payload: { url: f.normalized_url } });
      res.status(201).json(publicView(getMonitor(Number(info.lastInsertRowid))));
    })
  );

  api.get('/monitors/:id', (req, res) => {
    const m = getMonitor(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json(publicView(m));
  });

  api.patch(
    '/monitors/:id',
    wrap(async (req, res) => {
      const m = getMonitor(Number(req.params.id));
      if (!m) throw bad('Not found', 404);
      const f = await parseInput(req.body || {}, m); // URL cannot be changed: create a new monitor instead
      if ('active' in (req.body || {})) f.active = req.body.active ? 1 : 0;
      const keys = Object.keys(f);
      if (keys.length) {
        db.prepare(`UPDATE monitors SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: m.id });
      }
      res.json(publicView(getMonitor(m.id)));
    })
  );

  api.delete('/monitors/:id', (req, res) => {
    const m = getMonitor(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM monitors WHERE id = ?').run(m.id);
    fs.rmSync(path.join(config.dataDir, 'screenshots', String(m.id)), { recursive: true, force: true });
    res.json({ ok: true });
  });

  api.post('/monitors/:id/check', (req, res) => {
    const m = getMonitor(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE monitors SET next_check_at = ?, active = 1 WHERE id = ?').run(Date.now(), m.id);
    enqueue('check', { key: `check:${m.normalized_url}`, payload: { url: m.normalized_url } });
    res.json({ ok: true });
  });

  api.get('/monitors/:id/timeline', (req, res) => {
    const m = getMonitor(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Not found' });
    const rows = db
      .prepare(
        `SELECT s.id, s.created_at, s.content_hash, s.width, s.height, (s.screenshot_path IS NOT NULL) AS has_screenshot,
                c.summary, c.added, c.removed, c.significant, c.pixel_diff_pct, c.from_snapshot_id
         FROM snapshots s LEFT JOIN changes c ON c.to_snapshot_id = s.id
         WHERE s.monitor_id = ? ORDER BY s.id DESC`
      )
      .all(m.id);
    res.json({ monitor: publicView(m), snapshots: rows });
  });

  api.get('/monitors/:id/diff', (req, res) => {
    const m = getMonitor(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Not found' });
    let to = req.query.to ? snapshotOf(m.id, req.query.to) : null;
    let from = req.query.from ? snapshotOf(m.id, req.query.from) : null;
    if (!to) to = db.prepare('SELECT * FROM snapshots WHERE monitor_id = ? ORDER BY id DESC LIMIT 1').get(m.id);
    if (to && !from) from = db.prepare('SELECT * FROM snapshots WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(m.id, to.id);
    if (!from || !to) return res.status(404).json({ error: 'Need two versions to compare' });
    if (from.id > to.id) [from, to] = [to, from];
    const d = computeTextDiff(from.text, to.text);
    res.json({
      monitor: { id: m.id, name: m.name, url: m.url },
      from: { id: from.id, created_at: from.created_at, has_screenshot: !!from.screenshot_path },
      to: { id: to.id, created_at: to.created_at, has_screenshot: !!to.screenshot_path },
      added: d.added,
      removed: d.removed,
      parts: d.parts.map((p) => ({
        type: p.added ? 'add' : p.removed ? 'del' : 'same',
        lines: p.value.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')),
      })),
    });
  });

  api.get('/snapshots/:id/screenshot', (req, res) => {
    const s = db.prepare('SELECT screenshot_path FROM snapshots WHERE id = ?').get(Number(req.params.id));
    if (!s?.screenshot_path) return res.status(404).end();
    const file = path.join(config.dataDir, s.screenshot_path);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400').type('png').send(fs.readFileSync(file));
  });

  api.get('/diff-image', (req, res) => {
    const get = (id) => db.prepare('SELECT screenshot_path FROM snapshots WHERE id = ?').get(Number(id));
    const a = get(req.query.from);
    const b = get(req.query.to);
    if (!a?.screenshot_path || !b?.screenshot_path) return res.status(404).end();
    try {
      const out = diffImages(
        fs.readFileSync(path.join(config.dataDir, a.screenshot_path)),
        fs.readFileSync(path.join(config.dataDir, b.screenshot_path))
      );
      res.set('Cache-Control', 'private, max-age=3600').set('X-Diff-Pct', out.diffPct.toFixed(2)).type('png').send(out.png);
    } catch {
      res.status(404).end();
    }
  });

  // Visual picker: renders the page and returns a screenshot + clickable element boxes
  let pickerBusy = false;
  api.post(
    '/picker',
    wrap(async (req, res) => {
      let url;
      try {
        url = normalizeUrl(str(req.body?.url));
        await assertPublicUrl(url);
      } catch (e) {
        throw bad(e.message === 'Invalid URL' ? 'Enter a valid URL, including https://' : e.message);
      }
      if (pickerBusy) throw bad('Another preview is running. Try again in a few seconds.', 429);
      const wait = hostWait(new URL(url).hostname);
      if (wait > 0) throw bad(`This site was just requested. Try again in ${Math.ceil(wait / 1000)}s.`, 429);
      markHost(new URL(url).hostname);
      pickerBusy = true;
      try {
        const out = await snapshotForPicker(url);
        if (!out.ok) throw bad(`Could not load the page: ${out.detail}`, 422);
        res.json(out);
      } finally {
        pickerBusy = false;
      }
    })
  );

  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log('request error:', err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });

  return app.listen(config.port, () => log(`Website Change Detector listening on ${config.baseUrl}`));
}
