import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.join(config.dataDir, 'screenshots'), { recursive: true });

export const db = new Database(path.join(config.dataDir, 'detector.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  host TEXT NOT NULL,
  interval_min INTEGER NOT NULL,
  watch_selectors TEXT NOT NULL DEFAULT '[]',
  ignore_selectors TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL DEFAULT 'medium',
  keywords TEXT NOT NULL DEFAULT '[]',
  notify_email TEXT,
  discord_webhook TEXT,
  telegram_chat_id TEXT,
  digest INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  status_detail TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  down_alerted INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  last_changed_at INTEGER,
  next_check_at INTEGER NOT NULL,
  last_alert_at INTEGER,
  rss_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors(active, next_check_at);
CREATE INDEX IF NOT EXISTS idx_monitors_url ON monitors(normalized_url);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  screenshot_path TEXT,
  width INTEGER,
  height INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_monitor ON snapshots(monitor_id, id);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  from_snapshot_id INTEGER NOT NULL,
  to_snapshot_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  summary TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  change_ratio REAL,
  pixel_diff_pct REAL,
  significant INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_changes_monitor ON changes(monitor_id, id);
CREATE INDEX IF NOT EXISTS idx_changes_pending ON changes(significant, alerted);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  key TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_at INTEGER NOT NULL,
  locked_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_key ON jobs(key, status);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_state (
  host TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);
