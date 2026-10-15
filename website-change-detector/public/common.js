export const token = () => localStorage.getItem('wcd_token') || '';

export async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-admin-token': token() },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  if (res.status === 401) {
    const t = prompt('Enter the admin token (ADMIN_TOKEN from your .env):');
    if (!t) throw new Error('Unauthorized');
    localStorage.setItem('wcd_token', t);
    return api(path, opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// <img> tags cannot send headers, so image URLs carry the token in the query string
export const imgUrl = (p) => p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token());
export const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const qs = (k) => new URLSearchParams(location.search).get(k);
