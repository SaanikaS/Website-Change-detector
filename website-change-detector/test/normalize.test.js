import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, intersectLines } from '../src/normalize.js';

test('timestamps, relative times and counters are stripped', () => {
  const a = normalizeText('Updated 2026-10-15 14:32:11\nPosted 5 minutes ago\n1,234 views\nPrice: $19', { sensitivity: 'medium' });
  const b = normalizeText('Updated 2026-10-16 09:01:02\nPosted 2 hours ago\n9,999 views\nPrice: $19', { sensitivity: 'medium' });
  assert.equal(a, b);
});

test('real content changes survive filtering', () => {
  const a = normalizeText('Price: $19\nIn stock', { sensitivity: 'medium' });
  const b = normalizeText('Price: $24\nIn stock', { sensitivity: 'medium' });
  assert.notEqual(a, b);
});

test('random tokens and ids are stripped', () => {
  const a = normalizeText('csrf a1b2c3d4e5f6a7b8c9d0e1f2\nid 3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  const b = normalizeText('csrf 0f9e8d7c6b5a4f3e2d1c0b9a\nid 9b2f1c3e-1a2b-41d3-8a0c-0305e82c3999');
  assert.equal(a, b);
});

test('low sensitivity ignores numbers, high keeps them', () => {
  assert.equal(normalizeText('Items: 5', { sensitivity: 'low' }), normalizeText('Items: 6', { sensitivity: 'low' }));
  assert.notEqual(normalizeText('Items: 5', { sensitivity: 'high' }), normalizeText('Items: 6', { sensitivity: 'high' }));
});

test('intersectLines keeps only lines present in both loads', () => {
  const load1 = 'Header\nTip of the day: A\nPrice $5';
  const load2 = 'Header\nTip of the day: B\nPrice $5';
  assert.equal(intersectLines(load1, load2), 'Header\nPrice $5');
});
