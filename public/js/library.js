// Profile & equipment library: the operator profile plus a library of pilots and
// drones, used to pre-fill the ROMATSA flight-request forms. Talks to
// /api/profile/operator, /api/pilots, /api/drones (auth + entitlement required).

import { auth, openModal, toast } from './auth.js';

const el = (id) => document.getElementById(id);

const OPERATOR_FIELDS = [
  { k: 'operator_name', label: 'Operator / holder name' },
  { k: 'contact_details', label: 'Contact details (address)' },
  { k: 'contact_person', label: 'Contact person' },
  { k: 'phone_landline', label: 'Landline' },
  { k: 'phone_mobile', label: 'Mobile' },
  { k: 'fax', label: 'Fax' },
  { k: 'email', label: 'Email', type: 'email' },
  { k: 'operator_code', label: 'Operator code' },
];
const PILOT_FIELDS = [
  { k: 'name', label: 'Name' },
  { k: 'phone', label: 'Phone' },
  { k: 'qualifications', label: 'Relevant qualifications', type: 'textarea' },
];
const DRONE_FIELDS = [
  { k: 'registration', label: 'Registration / ID' },
  { k: 'serial', label: 'Serial' },
  { k: 'manufacturer', label: 'Manufacturer' },
  { k: 'model', label: 'Model' },
  { k: 'operating_class', label: 'Operating class', type: 'select', options: ['', 'C0', 'C1', 'C2', 'C3', 'C4', 'PRV250', 'PRV25'] },
  { k: 'category', label: 'Category', type: 'select', options: ['', 'A1', 'A2', 'A3'] },
  { k: 'operator_code', label: 'Operator code' },
  { k: 'mtom_kg', label: 'MTOM (kg)', type: 'number' },
];

// In-memory copies so the request wizard can read them without refetching.
export const libraryData = { operator: null, pilots: [], drones: [] };

export const library = {
  init() {
    el('library-btn').addEventListener('click', () => this.open());
    document.querySelectorAll('.lib-tab').forEach((t) =>
      t.addEventListener('click', () => selectTab(t.dataset.tab))
    );
    auth.onChange((user) => {
      el('library-btn').classList.toggle('hidden', !(user && auth.configured));
    });
  },
  async open() {
    openModal('library-modal');
    selectTab('operator');
    await Promise.all([loadOperator(), loadList('pilots'), loadList('drones')]);
  },
  async refresh() {
    await Promise.all([loadOperator(), loadList('pilots'), loadList('drones')]);
  },
};

function selectTab(name) {
  document.querySelectorAll('.lib-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['operator', 'pilots', 'drones', 'privacy'].forEach((p) => el('lib-' + p).classList.toggle('hidden', p !== name));
  if (name === 'privacy') renderPrivacy();
}

// ---------- Privacy: GDPR export + account deletion ----------
function renderPrivacy() {
  const email = (auth.user && auth.user.email) || '';
  el('lib-privacy').innerHTML = `
    <p class="hint">Your data, your control — these options always work, even without an active subscription.</p>

    <h3 class="lib-formtitle">Export your data</h3>
    <p class="hint">Download everything we hold about you — account, operator profile, pilots, drones,
      saved flying zones, generated requests and subscription status — as a JSON file.</p>
    <button id="gdpr-export" class="btn btn-primary btn-block">⬇ Download my data (JSON)</button>

    <h3 class="lib-formtitle">Delete your account</h3>
    <p class="hint">Permanently deletes your account and all of the data above. <strong>This cannot be undone.</strong>
      Any active subscription is cancelled automatically. Invoices already issued are kept by our payment
      processor for the period required by Romanian fiscal law.</p>
    <button id="gdpr-del-start" class="btn btn-danger btn-block">Delete my account…</button>
    <div id="gdpr-del-confirm" class="hidden">
      <p class="hint" style="color:var(--danger)">Type your email (<strong>${escapeHtml(email)}</strong>) to confirm:</p>
      <input id="del-confirm" class="search" type="email" placeholder="your@email" autocomplete="off" />
      <button id="gdpr-del-go" class="btn btn-danger btn-block">Delete permanently</button>
      <p id="del-status" class="hint"></p>
    </div>`;

  el('gdpr-export').addEventListener('click', exportData);
  el('gdpr-del-start').addEventListener('click', () => {
    el('gdpr-del-confirm').classList.remove('hidden');
    el('del-confirm').focus();
  });
  el('gdpr-del-go').addEventListener('click', deleteAccount);
}

async function exportData() {
  const btn = el('gdpr-export');
  btn.disabled = true;
  const res = await api('/api/account/export');
  btn.disabled = false;
  if (!res.ok) return toast('Export failed.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'drones-rz-romania-my-data.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('Your data has been downloaded.');
}

async function deleteAccount() {
  const status = el('del-status');
  status.textContent = 'Deleting…';
  const res = await api('/api/account/delete', { method: 'POST', body: JSON.stringify({ confirm: el('del-confirm').value }) });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    status.textContent = e.error || 'Deletion failed.';
    return;
  }
  await auth.signOut();
  window.location.href = '/';
}

// ---------- Operator ----------
async function loadOperator() {
  const res = await api('/api/profile/operator');
  libraryData.operator = res.ok ? (await res.json()).operator : null;
  renderOperator();
}

function renderOperator() {
  const o = libraryData.operator || {};
  el('lib-operator').innerHTML = `
    <p class="hint">Your details as UAS operator — reused across every request.</p>
    <div class="lib-form">${OPERATOR_FIELDS.map((f) => fieldHtml(f, o[f.k], 'op')).join('')}</div>
    <button id="op-save" class="btn btn-primary btn-block">Save operator profile</button>`;
  el('op-save').addEventListener('click', async () => {
    const body = collectFields('op', OPERATOR_FIELDS);
    const res = await api('/api/profile/operator', { method: 'PUT', body: JSON.stringify(body) });
    if (!res.ok) return toast('Save failed.');
    libraryData.operator = (await res.json()).operator;
    toast('Operator profile saved.');
  });
}

// ---------- Pilots / Drones (list + add/edit/delete) ----------
async function loadList(kind) {
  const res = await api('/api/' + kind);
  libraryData[kind] = res.ok ? (await res.json()).items : [];
  renderList(kind);
}

function renderList(kind) {
  const fields = kind === 'pilots' ? PILOT_FIELDS : DRONE_FIELDS;
  const items = libraryData[kind];
  const rows = items.length
    ? items.map((it) => `
      <div class="lib-row" data-id="${escapeHtml(it.id)}">
        <div class="lr-main"><strong>${escapeHtml(primaryLabel(kind, it))}</strong>
          <span class="lr-sub">${escapeHtml(secondaryLabel(kind, it))}</span></div>
        <div class="lr-actions">
          <button class="btn btn-mini" data-act="edit">Edit</button>
          <button class="btn btn-mini btn-danger" data-act="delete">Delete</button>
        </div>
      </div>`).join('')
    : `<p class="hint">No ${kind} yet.</p>`;

  el('lib-' + kind).innerHTML = `
    <div class="lib-list">${rows}</div>
    <h3 class="lib-formtitle">Add ${kind === 'pilots' ? 'pilot' : 'drone'}</h3>
    <div class="lib-form" id="${kind}-form">${fields.map((f) => fieldHtml(f, '', kind)).join('')}</div>
    <input type="hidden" id="${kind}-editid" />
    <button id="${kind}-save" class="btn btn-primary btn-block">Add</button>`;

  el(kind + '-save').addEventListener('click', () => saveItem(kind, fields));
  el('lib-' + kind).querySelector('.lib-list').addEventListener('click', (e) => onRowClick(e, kind, fields));
}

async function saveItem(kind, fields) {
  const body = collectFields(kind, fields);
  const id = el(kind + '-editid').value;
  const res = await api('/api/' + kind + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  if (!res.ok) return toast('Save failed.');
  toast(id ? 'Updated.' : 'Added.');
  await loadList(kind);
}

function onRowClick(e, kind, fields) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = e.target.closest('.lib-row').dataset.id;
  const item = libraryData[kind].find((x) => x.id === id);
  if (btn.dataset.act === 'edit') {
    fields.forEach((f) => { const inp = el(`f_${kind}_${f.k}`); if (inp) inp.value = item[f.k] == null ? '' : item[f.k]; });
    el(kind + '-editid').value = id;
    el(kind + '-save').textContent = 'Update';
    el('lib-' + kind).scrollTop = el('lib-' + kind).scrollHeight;
  } else if (btn.dataset.act === 'delete') {
    if (!window.confirm('Delete this entry?')) return;
    api('/api/' + kind + '/' + id, { method: 'DELETE' }).then((r) => {
      if (r.ok || r.status === 204) loadList(kind); else toast('Delete failed.');
    });
  }
}

function primaryLabel(kind, it) {
  return kind === 'pilots' ? (it.name || 'Unnamed pilot') : [it.manufacturer, it.model].filter(Boolean).join(' ') || it.registration || 'Drone';
}
function secondaryLabel(kind, it) {
  return kind === 'pilots'
    ? [it.phone, it.qualifications].filter(Boolean).join(' · ')
    : [it.registration, it.operating_class, it.category, it.mtom_kg != null ? it.mtom_kg + ' kg' : ''].filter(Boolean).join(' · ');
}

// ---------- shared form helpers ----------
// Inputs are namespaced by form prefix (op/pilots/drones) because some keys
// (e.g. operator_code) appear in more than one form → avoids duplicate IDs.
function fieldHtml(f, value, prefix) {
  const v = value == null ? '' : value;
  const id = `f_${prefix}_${f.k}`;
  if (f.type === 'textarea') return `<label class="lib-field"><span>${f.label}</span><textarea id="${id}" rows="2">${escapeHtml(v)}</textarea></label>`;
  if (f.type === 'select') {
    const opts = f.options.map((o) => `<option value="${o}"${String(v) === o ? ' selected' : ''}>${o || '—'}</option>`).join('');
    return `<label class="lib-field"><span>${f.label}</span><select id="${id}">${opts}</select></label>`;
  }
  return `<label class="lib-field"><span>${f.label}</span><input id="${id}" type="${f.type || 'text'}" value="${escapeHtml(v)}" /></label>`;
}
function collectFields(prefix, fields) {
  const body = {};
  fields.forEach((f) => { const inp = el(`f_${prefix}_${f.k}`); if (inp) body[f.k] = inp.value.trim(); });
  return body;
}

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  return fetch(path, { ...opts, headers });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
