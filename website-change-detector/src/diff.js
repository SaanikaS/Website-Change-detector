import { diffLines } from 'diff';

const THRESHOLDS = { high: 0, medium: 0.005, low: 0.05 };

export function computeTextDiff(a, b) {
  const parts = diffLines(a ? a + '\n' : '', b ? b + '\n' : '');
  let added = 0;
  let removed = 0;
  let changedChars = 0;
  const addedLines = [];
  const removedLines = [];
  for (const p of parts) {
    if (!p.added && !p.removed) continue;
    const lines = p.value.split('\n').filter(Boolean);
    changedChars += p.value.length;
    if (p.added) {
      added += lines.length;
      addedLines.push(...lines);
    } else {
      removed += lines.length;
      removedLines.push(...lines);
    }
  }
  return {
    parts,
    added,
    removed,
    addedLines,
    removedLines,
    ratio: changedChars / Math.max(a.length, b.length, 1),
  };
}

/** Is this change worth an alert? Keyword mode alerts only when a keyword is added/removed. */
export function isSignificant(d, sensitivity = 'medium', keywords = []) {
  if (d.added + d.removed === 0) return false;
  if (keywords && keywords.length) {
    const hay = [...d.addedLines, ...d.removedLines].join('\n').toLowerCase();
    return keywords.some((k) => hay.includes(String(k).toLowerCase()));
  }
  return d.ratio >= (THRESHOLDS[sensitivity] ?? THRESHOLDS.medium);
}

export function heuristicSummary(d) {
  const clip = (s) => (s.length > 110 ? s.slice(0, 107) + '…' : s);
  const bits = [`+${d.added} / −${d.removed} lines`];
  if (d.addedLines[0]) bits.push(`added “${clip(d.addedLines[0])}”`);
  if (d.removedLines[0]) bits.push(`removed “${clip(d.removedLines[0])}”`);
  return bits.join(' · ');
}
