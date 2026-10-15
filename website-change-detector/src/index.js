import 'dotenv/config';
import { config } from './config.js';
import './db.js';
import { startServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startWorker, stopWorker } from './worker.js';
import { closeBrowser } from './render.js';
import { log } from './util.js';

if (!config.adminToken) {
  log('WARNING: ADMIN_TOKEN is empty. Anyone who can reach this server can use it. Do not expose it publicly.');
}

const server = startServer();
const schedulerTimer = startScheduler();
startWorker();

async function shutdown(signal) {
  log(`${signal} received, shutting down...`);
  clearInterval(schedulerTimer);
  server.close();
  await stopWorker();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e));
