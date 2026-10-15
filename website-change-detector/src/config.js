import path from 'node:path';

const env = process.env;
const int = (k, d) => {
  const v = parseInt(env[k] ?? '', 10);
  return Number.isFinite(v) ? v : d;
};
const port = int('PORT', 3000);

export const config = {
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: path.resolve(env.DATA_DIR || './data'),
  adminToken: env.ADMIN_TOKEN || '',
  userAgent:
    env.USER_AGENT ||
    'WebsiteChangeDetector/1.0 (+https://github.com/YOUR-USER/website-change-detector)',
  workerConcurrency: int('WORKER_CONCURRENCY', 2),
  navTimeoutMs: int('NAV_TIMEOUT_MS', 30000),
  jobTimeoutMs: int('JOB_TIMEOUT_MS', 90000),
  maxAttempts: int('JOB_MAX_ATTEMPTS', 3),
  hostMinGapMs: int('HOST_MIN_GAP_MS', 10000),
  minIntervalMin: 15,
  maxIntervalMin: 1440,
  failureAlertThreshold: int('FAILURE_ALERT_THRESHOLD', 3),
  alertCooldownMin: int('ALERT_COOLDOWN_MIN', 30),
  snapshotRetention: int('SNAPSHOT_RETENTION', 100),
  hideRotators: env.HIDE_ROTATORS !== 'false',
  digestHour: int('DIGEST_HOUR', 8),
  allowPrivateHosts: env.ALLOW_PRIVATE_HOSTS === 'true',
  noSandbox: env.CHROMIUM_NO_SANDBOX === '1',
  smtp: {
    host: env.SMTP_HOST || '',
    port: int('SMTP_PORT', 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
};
