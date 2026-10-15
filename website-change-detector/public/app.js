import { api, fmt, esc } from './common.js';

const list = document.getElementById('list');
const dlg = document.getElementById('dlg');
const form = document.getElementById('form');
const errBox = document.getElementById('form-error');
let monitors = [];

function statusBadge(m) {
  if (!m.active) return '<span class="badge paused">paused</span>';
  const label = { ok: 'OK', error: 'error', blocked: 'blocked', pending: 'pending' }[m.status] || m.status;
  const title = m.status_detail ? ` title="${esc(m.status_detail)}"` : '';
  return `<span class="badge ${esc(m.status)}"${title}>${label}</span>`;
}

function render() {
  if (!monitors.length) {
    list.innerHTML = '<div class="empty">Nothing is being watched yet. Add a page and you will be alerted when it meaningfully changes.</div>';
    return;
  }
  list.innerHTML = `<div class="scroll"><table>
    <thead><tr><th>Page</th><th>Status</th><th>Last checked</th><th>Last changed</th><th>Every</th><th></th></tr></thead>
    <tbody>${monitors.map((m) => `
      <tr data-id="${m.id}">
        <td><strong>${esc(m.name)}</strong><div class="url">${esc(m.url)}</div>
          ${m.status_detail && m.status !== 'ok' ? `<div class="muted">${esc(m.status_detail)}</div>` : ''}</td>
        <td>${statusBadge(m)}</td>
        <td>${fmt(m.last_checked_at)}</td>
        <td>${fmt(m.last_changed_at)}</td>
        <td>${m.interval_min >= 60 ? m.interval_min / 60 + ' h' : m.interval_min + ' min'}</td>
        <td><div class="row">
          <a class="btn small" href="/timeline.html?monitor=${m.id}">Timeline (${m.snapshot_count})</a>
          <button class="small" data-act="check">Check now</button>
          <button class="small" data-act="edit">Edit</button>
          <button class="small" data-act="toggle">${m.active ? 'Pause' : 'Resume'}</button>
          <a class="btn small" href="${esc(m.rss_url)}">RSS</a>
          <button class="small danger" data-act="delete">Delete</button>
        </div></td>
      </tr>`).join('')}</tbody></table></div>`;
}

async function load() {
  try {
    monitors = await api('/api/monitors');
    render();
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function openForm(m) {
  form.reset();
  errBox.textContent = '';
  document.getElementById('dlg-title').textContent = m ? 'Edit page' : 'Add page to watch';
  form.id.value = m?.id || '';
  form.url.disabled = !!m;
  if (m) {
    form.name.value = m.name;
    form.url.value = m.url;
    form.interval_min.value = String(m.interval_min);
    form.watch_selectors.value = m.watch_selectors.join('\n');
    form.ignore_selectors.value = m.ignore_selectors.join('\n');
    form.sensitivity.value = m.sensitivity;
    form.keywords.value = m.keywords.join(', ');
    form.notify_email.value = m.notify_email || '';
    form.discord_webhook.value = m.discord_webhook || '';
    form.telegram_chat_id.value = m.telegram_chat_id || '';
    form.digest.checked = !!m.digest;
  }
  dlg.showModal();
}

document.getElementById('add').onclick = () => openForm(null);
document.getElementById('cancel').onclick = () => dlg.close();

document.getElementById('pick').onclick = () => {
  const url = form.url.value.trim();
  if (!url) {
    errBox.textContent = 'Enter the page URL first.';
    return;
  }
  const p = new URLSearchParams({ url, watch: form.watch_selectors.value, ignore: form.ignore_selectors.value });
  window.open('/picker.html?' + p, 'picker', 'width=1200,height=850');
};

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'selectors') return;
  form.watch_selectors.value = (e.data.watch || []).join('\n');
  form.ignore_selectors.value = (e.data.ignore || []).join('\n');
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errBox.textContent = '';
  const body = {
    name: form.name.value,
    interval_min: Number(form.interval_min.value),
    watch_selectors: form.watch_selectors.value,
    ignore_selectors: form.ignore_selectors.value,
    sensitivity: form.sensitivity.value,
    keywords: form.keywords.value,
    notify_email: form.notify_email.value,
    discord_webhook: form.discord_webhook.value,
    telegram_chat_id: form.telegram_chat_id.value,
    digest: form.digest.checked,
  };
  try {
    if (form.id.value) await api('/api/monitors/' + form.id.value, { method: 'PATCH', body });
    else await api('/api/monitors', { method: 'POST', body: { ...body, url: form.url.value } });
    dlg.close();
    await load();
  } catch (e) {
    errBox.textContent = e.message;
  }
});

list.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const m = monitors.find((x) => String(x.id) === id);
  try {
    if (btn.dataset.act === 'edit') return openForm(m);
    if (btn.dataset.act === 'check') {
      await api(`/api/monitors/${id}/check`, { method: 'POST', body: {} });
      btn.textContent = 'Queued…';
      setTimeout(load, 6000);
      return;
    }
    if (btn.dataset.act === 'toggle') await api('/api/monitors/' + id, { method: 'PATCH', body: { active: !m.active } });
    if (btn.dataset.act === 'delete') {
      if (!confirm(`Delete "${m.name}" and all of its saved versions?`)) return;
      await api('/api/monitors/' + id, { method: 'DELETE' });
    }
    await load();
  } catch (e) {
    alert(e.message);
  }
});

api('/api/config')
  .then((c) => {
    const notes = [];
    if (!c.emailConfigured) notes.push('Email alerts are off (set SMTP_* in .env).');
    if (!c.telegramConfigured) notes.push('Telegram alerts are off (set TELEGRAM_BOT_TOKEN).');
    document.getElementById('notice').textContent = notes.join(' ');
  })
  .catch(() => {});
load();
setInterval(load, 30000);
