// Saved flying-zone history: save the current drawing, and list / reload /
// rename / delete previously saved zones. Talks to /api/flights (auth required).

import { auth, closeModals, openModal, toast } from './auth.js';
import { billing } from './billing.js';

const el = (id) => document.getElementById(id);

// Hooks into app.js: read the current flight, and reload a saved geometry.
let hooks = { getFlight: () => null, loadFlight: () => {} };
let cache = []; // last-fetched flights (for Load without a per-id fetch)

export const history = {
  init(h) {
    hooks = { ...hooks, ...h };
    el('save-flight-btn').addEventListener('click', () => this.saveCurrent());
    el('history-btn').addEventListener('click', () => this.open());
    el('history-list').addEventListener('click', onListClick);
  },

  async saveCurrent() {
    if (!auth.configured) { toast('Accounts are not configured on this server yet.'); return; }
    if (!auth.user) { openModal('signin-modal', () => el('signin-email').focus()); return; }
    const flight = hooks.getFlight();
    if (!flight) { toast('Draw a flying zone first.'); return; }

    const name = window.prompt('Name this flying zone:', flight.suggestedName || 'Flying zone');
    if (name === null) return; // cancelled

    const res = await api('/api/flights', {
      method: 'POST',
      body: JSON.stringify({
        name,
        geometry: flight.geometry,
        overlap_zones: flight.overlap_zones,
        area_m2: flight.area_m2,
        dataset_valid_from: flight.dataset_valid_from,
      }),
    });
    if (!res.ok) {
      const e = await safeJson(res);
      toast('Save failed: ' + (e.error || res.status));
      return;
    }
    toast('Saved to your history.');
  },

  async open() {
    openModal('history-modal');
    await refreshList();
  },
};

async function refreshList() {
  el('history-list').innerHTML = '<p class="hint">Loading…</p>';
  const res = await api('/api/flights');
  if (res.status === 402) {
    el('history-list').innerHTML =
      '<p class="hint">Your free trial has ended. Subscribe to access your saved flying zones. ' +
      '<button id="history-subscribe" class="btn btn-mini btn-primary">Subscribe</button></p>';
    el('history-subscribe')?.addEventListener('click', () => { closeModals(); billing.openSubscribe(); });
    return;
  }
  if (!res.ok) {
    el('history-list').innerHTML = '<p class="hint">Could not load your history.</p>';
    return;
  }
  cache = (await res.json()).flights || [];
  if (!cache.length) {
    el('history-list').innerHTML =
      '<p class="hint">No saved flying zones yet. Draw one, then click “Save to my history”.</p>';
    return;
  }
  el('history-list').innerHTML = cache.map(renderRow).join('');
}

function renderRow(f) {
  const date = new Date(f.created_at).toLocaleString();
  const n = Array.isArray(f.overlap_zones) ? f.overlap_zones.length : 0;
  return `<div class="history-row" data-id="${escapeHtml(f.id)}">
    <div class="hr-main">
      <div class="hr-name">${escapeHtml(f.name)}</div>
      <div class="hr-meta">${escapeHtml(date)} · ${formatArea(f.area_m2)} · ${n} overlap${n === 1 ? '' : 's'}${
        f.dataset_valid_from ? ` · data ${escapeHtml(f.dataset_valid_from)}` : ''
      }</div>
    </div>
    <div class="hr-actions">
      <button class="btn btn-mini" data-act="load">Load</button>
      <button class="btn btn-mini" data-act="rename">Rename</button>
      <button class="btn btn-mini btn-danger" data-act="delete">Delete</button>
    </div>
  </div>`;
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = e.target.closest('.history-row').dataset.id;
  const flight = cache.find((f) => f.id === id);
  if (!flight) return;

  if (btn.dataset.act === 'load') {
    closeModals();
    hooks.loadFlight(flight.geometry, flight);
    toast(`Loaded “${flight.name}”.`);
  } else if (btn.dataset.act === 'rename') {
    const name = window.prompt('Rename flying zone:', flight.name);
    if (name === null || !name.trim()) return;
    const res = await api(`/api/flights/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
    if (!res.ok) { toast('Rename failed.'); return; }
    await refreshList();
  } else if (btn.dataset.act === 'delete') {
    if (!window.confirm(`Delete “${flight.name}”? This cannot be undone.`)) return;
    const res = await api(`/api/flights/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) { toast('Delete failed.'); return; }
    await refreshList();
  }
}

// --- helpers ---
function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  return fetch(path, { ...opts, headers });
}

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}

function formatArea(m2) {
  if (m2 == null || !isFinite(m2)) return '—';
  if (m2 < 1_000_000) return `${Math.round(m2).toLocaleString()} m²`;
  return `${(m2 / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
