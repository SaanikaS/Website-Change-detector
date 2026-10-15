import { sha256 } from './util.js';

// Noise filtering for rendered text: timestamps, counters, random tokens.
// Ads / rotating banners / user-ignored regions are removed in the browser (see render.js).

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';

const RX = {
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  hex: /\b[0-9a-f]{16,}\b/gi,
  token: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g,
  isoDate: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  monthDate: new RegExp(`\\b${MONTHS} \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`, 'gi'),
  dayMonth: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTHS},? ?(?:\\d{4})?\\b`, 'gi'),
  numDate: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  time: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?(?:\s?(?:utc|gmt|[ecmp][sd]t))?\b/gi,
  relative: /\b(?:just now|(?:an?|\d+)\s+(?:second|minute|min|hour|hr|day|week|month|year)s?\s+ago)\b/gi,
  counter:
    /\b\d[\d,.]*\s?[kKmM]?\+?\s+(?:views?|visitors?|users?|people|online|likes?|shares?|comments?|followers?|downloads?|reads?|watching|viewers?)\b/gi,
  number: /\d[\d,.]*/g,
};

/** low = ignore small/numeric noise, high = report everything that survives noise filtering */
export const SENSITIVITY = {
  high: { ratio: 0, counters: false, numbers: false },
  medium: { ratio: 0.005, counters: true, numbers: false },
  low: { ratio: 0.05, counters: true, numbers: true },
};

function stripNoise(line, cfg) {
  let s = line;
  s = s.replace(RX.uuid, '<id>').replace(RX.hex, '<id>').replace(RX.token, '<token>');
  s = s.replace(RX.isoDate, '<date>').replace(RX.monthDate, '<date>').replace(RX.dayMonth, '<date>').replace(RX.numDate, '<date>');
  s = s.replace(RX.time, '<time>').replace(RX.relative, '<ago>');
  if (cfg.counters) s = s.replace(RX.counter, '<count>');
  if (cfg.numbers) s = s.replace(RX.number, '<n>');
  return s;
}

export function normalizeText(raw, { sensitivity = 'medium' } = {}) {
  const cfg = SENSITIVITY[sensitivity] || SENSITIVITY.medium;
  const out = [];
  for (const rawLine of String(raw).replace(/\u00a0/g, ' ').split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;
    const cleaned = stripNoise(line, cfg).trim();
    if (cleaned) out.push(cleaned);
  }
  return out.join('\n');
}

/**
 * Keep only lines that appear in BOTH loads of the page (multiset, order of `a`).
 * Anything that differs between two loads seconds apart is, by definition, noise.
 */
export function intersectLines(a, b) {
  const counts = new Map();
  for (const l of b.split('\n')) counts.set(l, (counts.get(l) || 0) + 1);
  const out = [];
  for (const l of a.split('\n')) {
    const n = counts.get(l) || 0;
    if (n > 0) {
      out.push(l);
      counts.set(l, n - 1);
    }
  }
  return out.join('\n');
}

export const contentHash = (text) => sha256(text);
