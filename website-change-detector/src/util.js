import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

export const log = (...args) => console.log(new Date().toISOString(), ...args);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randomToken = () => crypto.randomBytes(18).toString('hex');

export function parseJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function withTimeout(promise, ms, label = 'Timed out') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(label)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Canonical form of a URL. Two users watching the "same" page end up with the
 * same normalized URL, so the page is fetched once per cycle (not once per user).
 */
export function normalizeUrl(input) {
  const u = new URL(input);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) {
    throw new Error('URLs with credentials are not allowed (public pages only)');
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$)/i.test(k)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  return u.toString();
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7);
    return net.isIPv4(tail) ? isPrivateIp(tail) : true;
  }
  return false;
}

/** SSRF guard: only public internet hosts may be fetched. */
export async function assertPublicUrl(urlStr) {
  if (config.allowPrivateHosts) return;
  const u = new URL(urlStr);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private or local addresses are not allowed');
  }
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Private or local addresses are not allowed');
  }
}
