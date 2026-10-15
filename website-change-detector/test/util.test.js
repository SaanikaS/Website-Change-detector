import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isPrivateIp } from '../src/util.js';

test('equivalent URLs normalize to the same key (so they are fetched once)', () => {
  const a = normalizeUrl('https://Example.com/page?b=2&a=1&utm_source=x#top');
  const b = normalizeUrl('https://example.com/page?a=1&b=2');
  assert.equal(a, b);
});
test('credentials and non-http schemes are rejected', () => {
  assert.throws(() => normalizeUrl('https://user:pw@example.com/'));
  assert.throws(() => normalizeUrl('file:///etc/passwd'));
});
test('private addresses are detected', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp('93.184.216.34'), false);
});
