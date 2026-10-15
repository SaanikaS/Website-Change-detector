import { chromium } from 'playwright';
import { config } from './config.js';
import { assertPublicUrl } from './util.js';
import { classifyPage } from './detect.js';

const VIEWPORT = { width: 1366, height: 768 };
const MAX_SHOT_HEIGHT = 6000;

const WIDGET_SEL =
  'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],#challenge-form,.g-recaptcha,.h-captcha,.cf-turnstile';

// Hidden before text extraction and masked in screenshots.
const AD_SELECTORS = [
  'ins.adsbygoogle',
  'iframe[src*="ads"]',
  '[id^="google_ads"]',
  '[id*="advert"]',
  '[class*="advert"]',
  '[class*="adsbox"]',
  '[aria-label="Advertisement"]',
  '[data-ad]',
  '[data-ad-slot]',
  '.ad-container',
  '.ad-slot',
  '.sponsored',
  '[id*="cookie"]',
  '[class*="cookie-banner"]',
];
const ROTATOR_SELECTORS = [
  '[class*="carousel"]',
  '[class*="slider"]',
  '[class*="swiper"]',
  '[class*="rotator"]',
  '[class*="marquee"]',
  '[class*="ticker"]',
];

const BLOCKED_REQUEST_HOSTS =
  /(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|facebook\.net|taboola\.com|outbrain\.com|criteo\.com|scorecardresearch\.com|hotjar\.com|amazon-adsystem\.com|adservice\.google)/i;

const FREEZE_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const args = ['--disable-dev-shm-usage'];
    if (config.noSandbox) args.push('--no-sandbox');
    browserPromise = chromium.launch({ headless: true, args }).then((b) => {
      b.on('disconnected', () => {
        browserPromise = null;
      });
      return b;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    /* ignore */
  }
  browserPromise = null;
}

// ---- functions below run INSIDE the page (must be self-contained) ----

async function autoScroll() {
  const h = Math.min(document.documentElement.scrollHeight, 8000);
  for (let y = 0; y < h; y += 600) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 80));
  }
  window.scrollTo(0, 0);
}

function extractInPage({ watch, ignore, hideSelectors }) {
  const query = (sels) => {
    const out = [];
    for (const s of sels) {
      try {
        document.querySelectorAll(s).forEach((el) => out.push(el));
      } catch {
        /* invalid selector: skip */
      }
    }
    return out;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const visible = (b) => b.w > 0 && b.h > 0;

  const watchEls = query(watch);
  const ignoreEls = query(ignore);
  const hideEls = query(hideSelectors);

  // measure BEFORE hiding anything
  const watchBoxes = watchEls.map(box).filter(visible);
  const ignoreBoxes = [...ignoreEls, ...hideEls].map(box).filter(visible);

  const hidden = [];
  for (const el of [...ignoreEls, ...hideEls]) {
    hidden.push([el, el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')]);
    el.style.setProperty('display', 'none', 'important');
  }

  const roots = watch.length ? watchEls : [document.body];
  let text = roots.map((el) => el.innerText || '').join('\n');
  const watchMissing = watch.length > 0 && watchEls.length === 0;
  if (watchMissing) text = '[watched region not found on page]';

  for (const [el, v, p] of hidden) {
    if (v) el.style.setProperty('display', v, p);
    else el.style.removeProperty('display');
  }
  return { text, watchBoxes, ignoreBoxes, watchMissing };
}

function collectElements(maxH) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'HEAD', 'TITLE', 'HTML', 'BODY']);
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + CSS.escape(el.id);
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.localName;
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === cur.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (SKIP.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) continue;
    const y = r.top + window.scrollY;
    if (y > maxH) continue;
    out.push({
      selector: cssPath(el),
      tag: el.localName,
      x: Math.round(r.left + window.scrollX),
      y: Math.round(y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
    if (out.length >= 2500) break;
  }
  return out;
}

// ---- Node side ----

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
  await page.evaluate(autoScroll).catch(() => {});
  await page.waitForTimeout(400);
}

async function probe(page, response) {
  const info = await page.evaluate(
    (sel) => ({
      title: document.title || '',
      text: document.body ? document.body.innerText : '',
      widget: !!document.querySelector(sel),
    }),
    WIDGET_SEL
  );
  const status = response ? response.status() : 0;
  return {
    status,
    ...classifyPage({ status, title: info.title, text: info.text, hasChallengeWidget: info.widget }),
  };
}

function parseRetryAfter(v) {
  if (!v) return null;
  const n = Number(v);
  let ms = Number.isFinite(n) ? n * 1000 : Date.parse(v) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), 24 * 3600_000);
}

async function pageHeight(page) {
  return page.evaluate(
    (max) =>
      Math.min(
        Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 100),
        max
      ),
    MAX_SHOT_HEIGHT
  );
}

/**
 * Opens a URL once in a fresh, isolated browser context.
 * The returned session can extract content for MANY monitors from this single page load.
 * Throws on transient failures (timeouts, DNS, network) so the queue can retry.
 */
export async function openPage(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  const killer = setTimeout(() => context.close().catch(() => {}), Math.max(10_000, config.jobTimeoutMs - 10_000));
  const close = async () => {
    clearTimeout(killer);
    await context.close().catch(() => {});
  };

  try {
    const hostOk = new Map();
    await context.route('**/*', async (route) => {
      try {
        const req = route.request();
        const u = new URL(req.url());
        if (!['http:', 'https:'].includes(u.protocol)) return await route.continue();
        if (req.resourceType() === 'media' || BLOCKED_REQUEST_HOSTS.test(u.hostname)) return await route.abort();
        if (!hostOk.has(u.hostname)) {
          hostOk.set(u.hostname, assertPublicUrl(req.url()).then(() => true, () => false));
        }
        if (!(await hostOk.get(u.hostname))) return await route.abort();
        return await route.continue();
      } catch {
        await route.abort().catch(() => {});
      }
    });

    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
    await settle(page);

    const verdict = await probe(page, response);
    const session = {
      state: verdict.state,
      detail: verdict.detail,
      status: verdict.status,
      retryAfterMs: parseRetryAfter(response?.headers()['retry-after']),
      finalUrl: page.url(),
      screenshot: null,
      page,
      close,
    };
    if (verdict.state !== 'ok') return session;

    const h = await pageHeight(page);
    session.screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: h },
      animations: 'disabled',
    });

    const hideSelectors = [...AD_SELECTORS, ...(config.hideRotators ? ROTATOR_SELECTORS : [])];
    session.extract = async (monitors) => {
      const out = {};
      for (const m of monitors) {
        out[m.id] = await page.evaluate(extractInPage, { watch: m.watch, ignore: m.ignore, hideSelectors });
      }
      return out;
    };
    session.reload = async () => {
      const res = await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs });
      await settle(page);
      return probe(page, res);
    };
    return session;
  } catch (e) {
    await close();
    throw e;
  }
}

/** For the visual picker: a JPEG screenshot plus the boxes + CSS selectors of visible elements. */
export async function snapshotForPicker(url) {
  const session = await openPage(url);
  try {
    if (session.state !== 'ok') return { ok: false, state: session.state, detail: session.detail };
    const page = session.page;
    const h = await pageHeight(page);
    const shot = await page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: h },
      animations: 'disabled',
    });
    const elements = await page.evaluate(collectElements, h);
    return { ok: true, width: VIEWPORT.width, height: h, image: shot.toString('base64'), elements };
  } finally {
    await session.close();
  }
}
