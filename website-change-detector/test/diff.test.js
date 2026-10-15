import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTextDiff, isSignificant } from '../src/diff.js';

const base = Array.from({ length: 100 }, (_, i) => `line number ${i} with some words`).join('\n');

test('tiny change is ignored at low/medium, reported at high', () => {
  const changed = base.replace('line number 5 with', 'line number 5 wiht');
  const d = computeTextDiff(base, changed);
  assert.equal(isSignificant(d, 'high'), true);
  assert.equal(isSignificant(d, 'low'), false);
});
test('big change is significant everywhere', () => {
  const d = computeTextDiff(base, base.split('\n').slice(0, 50).join('\n'));
  assert.equal(isSignificant(d, 'low'), true);
});
test('keyword mode only alerts on matching changes', () => {
  const d = computeTextDiff('a\nPrice 10\nb', 'a\nPrice 12\nb');
  assert.equal(isSignificant(d, 'high', ['sold out']), false);
  assert.equal(isSignificant(d, 'high', ['price']), true);
});
