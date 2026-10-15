# Website Change Detector

Monitors public web pages in a headless browser (Playwright) and alerts you to **meaningful** changes while ignoring noise.

- Add a URL, a name and a check interval (15 min – 24 h)
- Scheduler + SQLite-backed job queue with timeouts, retries and backoff
- Saves page text + screenshot every check; stores a new **snapshot only when the content hash changes**
- Noise filtering (timestamps, counters, ads, rotating banners, random tokens) + sensitivity setting
- Visual picker for regions to watch / ignore (saved as CSS selectors)
- Text diff, highlighted screenshot diff, side-by-side comparison of any two versions
- Alerts via email, Telegram and Discord with summary + diff link, no duplicates, optional daily digest
- Per-page version timeline and a dashboard (last checked, last changed, status: OK / error / blocked)
- Bonus included: keyword-only alerts, AI one-line summaries (optional), per-page RSS feed

## Quick start (local)

Requires **Node.js 20+** (22 recommended).

```bash
git clone https://github.com/YOUR-USER/website-change-detector.git
cd website-change-detector
npm install
npm run setup:browser        # downloads Chromium (+ system libs on Linux)
cp .env.example .env         # then edit .env (set ADMIN_TOKEN at least)
npm start
```

Open http://localhost:3000, enter your `ADMIN_TOKEN` when prompted, click **Add page to watch**.

## Docker

```bash
cp .env.example .env         # edit it
docker compose up -d --build
```

Data (SQLite + screenshots) lives in the `detector-data` volume.

## Push this project to GitHub

```bash
cd website-change-detector
git init
git add .
git commit -m "Initial commit: website change detector"
git branch -M main
# create an empty repo on github.com first (no README/license), then:
git remote add origin https://github.com/YOUR-USER/website-change-detector.git
git push -u origin main
```

With the GitHub CLI instead: `gh repo create website-change-detector --public --source=. --push`

`.env` and `data/` are in `.gitignore`, so secrets and screenshots are never committed. The included GitHub Actions workflow runs the tests on every push.

## Configuration

Everything is in `.env` (see `.env.example` for all options).

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` | Protects the dashboard/API. **Set it** if the server is reachable by anyone else. |
| `BASE_URL` | Public URL of the app; used for diff links in alerts. |
| `SMTP_*` | Email alerts. |
| `TELEGRAM_BOT_TOKEN` | Create a bot with @BotFather; then give each monitor a chat id (message your bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates`). |
| Discord | No server config: create a webhook in *Channel settings → Integrations → Webhooks* and paste its URL into the monitor. |
| `ANTHROPIC_API_KEY` | Optional: one-line AI change summaries. Without it a built-in summary is used. |
| `HOST_MIN_GAP_MS`, `ALERT_COOLDOWN_MIN`, `FAILURE_ALERT_THRESHOLD` | Politeness and alert-noise controls. |

## How it works

```
Dashboard / API ──> monitors (SQLite)
                       │ every 30 s
                   Scheduler ──> ONE "check" job per distinct URL ──> Job queue (SQLite)
                                                                        │ worker pool
                          per-host throttle ──> Playwright renders page once
                                                   │
                  ┌────────────────────────────────┴──────────────┐
            blocked / error                                       ok
        status only, no snapshot            per monitor: extract text (watch/ignore regions, ads hidden)
        alert after N failures              → noise filter → compare with last snapshot
                                            → if different: reload & keep only lines present in BOTH loads
                                            → new hash? store snapshot + screenshot + diff
                                            → significant? alert (cooldown, dedupe, digest)
```

### The four design questions

1. **Is a site outage or CAPTCHA a change?** No. Every render is classified first (`src/detect.js`): HTTP 4xx/5xx, timeouts, empty pages and bot walls (Cloudflare "Just a moment", reCAPTCHA/hCaptcha/Turnstile, "verify you are human"…) become status `error` or `blocked`. No snapshot is saved and no diff is computed. You get one "can't check this page" alert after `FAILURE_ALERT_THRESHOLD` consecutive failures and one "recovered" alert later. Blocked sites are checked less often (exponential backoff) so the detector never fights a CAPTCHA.
2. **If 200 users watch the same URL, is it fetched 200 times?** No. URLs are normalized (host case, tracking params, parameter order, fragment) and the scheduler enqueues **one job per distinct URL**. That job renders the page once and every monitor on that URL extracts its own text, regions and screenshot crop from that single page load. Selectors, sensitivity and alert channels stay per monitor.
3. **How to avoid endless alerts on pages that differ on every load?** Layered: (a) timestamps, counters, ids and tokens are stripped; ads, carousels and user-ignored regions are hidden/masked in the browser; (b) when text looks different, the page is **loaded a second time** a few seconds later and only lines present in both loads count, so random or rotating content never reaches the diff; (c) the sensitivity setting ignores small changes (low also ignores numbers); (d) an alert cooldown batches bursts into one message; (e) a UNIQUE dedupe key makes a given change alert only once.
4. **How to avoid hammering a site?** Minimum interval 15 min; one fetch per URL; a minimum gap per host (`HOST_MIN_GAP_MS`, default 10 s, with jitter) that holds across all monitors; scheduling jitter so checks don't align; `Retry-After`/429/CAPTCHA backoff; bounded retries with exponential backoff; ad/tracker/media requests are blocked; an honest `USER_AGENT`.

### Other behaviour worth knowing

- **Public pages only.** No login/credential fields exist. URLs with `user:pass@` are rejected, and private/localhost addresses are blocked (SSRF guard) unless `ALLOW_PRIVATE_HOSTS=true` for local testing.
- **Snapshots** keep the last `SNAPSHOT_RETENTION` (100) versions per page. Screenshots are stored as PNG under `data/screenshots/`.
- Changes below the sensitivity threshold are still stored as a new version (the hash changed) but are marked *minor* and don't alert.
- **Rotating banners:** elements whose class contains `carousel`, `slider`, `swiper`, `rotator`, `marquee` or `ticker` are hidden before extraction. Set `HIDE_ROTATORS=false` if that hides content you care about.
- The URL of an existing monitor can't be edited; delete it and add a new one.

## API (all under `/api`, header `x-admin-token`)

| Method | Path | |
|---|---|---|
| GET/POST | `/monitors` | list / create |
| GET/PATCH/DELETE | `/monitors/:id` | read / update / delete |
| POST | `/monitors/:id/check` | check now |
| GET | `/monitors/:id/timeline` | versions + changes |
| GET | `/monitors/:id/diff?from=&to=` | text diff of any two versions |
| GET | `/snapshots/:id/screenshot` | PNG |
| GET | `/diff-image?from=&to=` | highlighted pixel diff PNG |
| POST | `/picker` | live preview + element boxes for the visual picker |
| GET | `/rss/<token>.xml` | per-page feed (no admin token; the link is unguessable) |

## Tests

```bash
npm test
```

## Limitations / ideas for next steps

- Single process, SQLite: ideal for one server; for many thousands of pages move to Postgres + Redis/BullMQ.
- No user accounts: one admin token. Add accounts if you need real multi-tenant isolation.
- Selectors from the visual picker are position-based (`div > ul > li:nth-of-type(2)`) unless an element has a unique id; they can break when a site is redesigned.
- Not included from the bonus list: number tracking with charts and a browser extension.
- Check each site's terms of service and robots.txt before monitoring it.

## License

MIT
