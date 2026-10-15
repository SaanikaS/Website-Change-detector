import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage } from '../src/detect.js';

const longText = 'Lorem ipsum dolor sit amet. '.repeat(200);

test('normal page is ok', () => {
  assert.equal(classifyPage({ status: 200, title: 'Home', text: longText }).state, 'ok');
});
test('cloudflare challenge is blocked, not a change', () => {
  const r = classifyPage({ status: 403, title: 'Just a moment...', text: 'Checking your browser before accessing' });
  assert.equal(r.state, 'blocked');
});
test('captcha widget on an otherwise empty page is blocked', () => {
  assert.equal(classifyPage({ status: 200, title: 'x', text: 'Please continue', hasChallengeWidget: true }).state, 'blocked');
});
test('a long page that merely contains a captcha form is still ok', () => {
  assert.equal(classifyPage({ status: 200, title: 'Contact us', text: longText, hasChallengeWidget: true }).state, 'ok');
});
test('HTTP 500 and 404 are errors', () => {
  assert.equal(classifyPage({ status: 500, text: longText }).state, 'error');
  assert.equal(classifyPage({ status: 404, text: longText }).state, 'error');
});
test('429 is blocked (rate limited)', () => {
  assert.equal(classifyPage({ status: 429, text: longText }).state, 'blocked');
});
test('empty page is an error', () => {
  assert.equal(classifyPage({ status: 200, text: '  ' }).state, 'error');
});
