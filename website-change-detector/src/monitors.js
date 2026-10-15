import { db } from './db.js';
import { parseJson } from './util.js';

export const getMonitor = (id) => db.prepare('SELECT * FROM monitors WHERE id = ?').get(id);

export const dueMonitors = (normalizedUrl) =>
  db
    .prepare('SELECT * FROM monitors WHERE active = 1 AND normalized_url = ? AND next_check_at <= ?')
    .all(normalizedUrl, Date.now());

export const toRuntime = (m) => ({
  ...m,
  watch: parseJson(m.watch_selectors, []),
  ignore: parseJson(m.ignore_selectors, []),
  keywordList: parseJson(m.keywords, []),
});

export function publicView(m) {
  const { rss_token, watch_selectors, ignore_selectors, keywords, ...rest } = m;
  return {
    ...rest,
    watch_selectors: parseJson(watch_selectors, []),
    ignore_selectors: parseJson(ignore_selectors, []),
    keywords: parseJson(keywords, []),
    rss_url: `/rss/${rss_token}.xml`,
  };
}
