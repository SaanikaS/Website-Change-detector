import { config } from './config.js';
import { claim, complete, defer, fail } from './queue.js';
import { handleCheck, giveUp } from './checker.js';
import { sendNotification } from './notify.js';
import { log, sleep, withTimeout } from './util.js';

const handlers = {
  check: handleCheck,
  notify: (job) => sendNotification(job.payload),
};

let timer = null;
let running = 0;
let stopping = false;

function tick() {
  if (stopping) return;
  while (running < config.workerConcurrency) {
    const job = claim();
    if (!job) return;
    running++;
    execute(job).finally(() => {
      running--;
    });
  }
}

async function execute(job) {
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No handler for job type "${job.type}"`);
    const res = await withTimeout(Promise.resolve(handler(job)), config.jobTimeoutMs, 'Job timed out');
    if (res && res.defer) defer(job.id, res.defer);
    else complete(job.id);
  } catch (err) {
    const final = fail(job, err);
    log(`job ${job.id} (${job.type}) failed [attempt ${job.attempts}/${job.max_attempts}]:`, err.message);
    if (final && job.type === 'check') {
      try {
        giveUp(job, err);
      } catch (e) {
        log('giveUp failed:', e.message);
      }
    }
  }
}

export function startWorker() {
  timer = setInterval(tick, 1000);
  tick();
}

export async function stopWorker() {
  stopping = true;
  clearInterval(timer);
  const start = Date.now();
  while (running > 0 && Date.now() - start < 15_000) await sleep(200);
}
