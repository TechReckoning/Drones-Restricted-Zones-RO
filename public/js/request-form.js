// Flight-request generator: builds the official ROMATSA AcroForm PDFs (Anexa 1
// Informare / Anexa 2 Solicitare) from the user's saved library + the drawn zone,
// fills them client-side with pdf-lib, and keeps a re-downloadable request history.

import { auth, openModal, closeModals, toast } from './auth.js';
import { library, libraryData } from './library.js';

const el = (id) => document.getElementById(id);
let getFlight = () => null; // set in init() by app.js

// TWR dropdown options — export VALUE must match the PDF field's option values
// exactly (the two București entries have no export/display pair in the form).
const TOWERS = [
  ['LRAR', 'Arad (LRAR)'], ['LRBC', 'Bacău (LRBC)'], ['LRBM', 'Baia Mare (LRBM)'],
  ['LRBV', 'Brașov (LRBV)'], ['București Băneasa- LRBS', 'București Băneasa (LRBS)'],
  ['București Otopeni- LROP', 'București Otopeni (LROP)'], ['LRCL', 'Cluj-Napoca (LRCL)'],
  ['LRCK', 'Constanța (LRCK)'], ['LRCV', 'Craiova (LRCV)'], ['LRIA', 'Iași (LRIA)'],
  ['LROD', 'Oradea (LROD)'], ['LRSM', 'Satu Mare (LRSM)'], ['LRSB', 'Sibiu (LRSB)'],
  ['LRSV', 'Suceava (LRSV)'], ['LRTM', 'Târgu Mureș (LRTM)'], ['LRTR', 'Timișoara (LRTR)'],
  ['LRTC', 'Tulcea (LRTC)'],
];
// Map a zone's contact string (e.g. "twr.brasov@romatsa.ro") → TWR option value.
const TOWER_KEYWORDS = [
  ['baneasa', 'București Băneasa- LRBS'], ['băneasa', 'București Băneasa- LRBS'],
  ['otopeni', 'București Otopeni- LROP'], ['arad', 'LRAR'], ['bacau', 'LRBC'], ['bacău', 'LRBC'],
  ['baia', 'LRBM'], ['brasov', 'LRBV'], ['brașov', 'LRBV'], ['cluj', 'LRCL'],
  ['constanta', 'LRCK'], ['constanța', 'LRCK'], ['craiova', 'LRCV'], ['iasi', 'LRIA'], ['iași', 'LRIA'],
  ['oradea', 'LROD'], ['satu', 'LRSM'], ['sibiu', 'LRSB'], ['suceava', 'LRSV'],
  ['mures', 'LRTM'], ['mureș', 'LRTM'], ['targu', 'LRTM'], ['tirgu', 'LRTM'],
  ['timisoara', 'LRTR'], ['timișoara', 'LRTR'], ['tulcea', 'LRTC'],
];
function towerFromContact(contact) {
  const c = (contact || '').toLowerCase();
  for (const [kw, val] of TOWER_KEYWORDS) if (c.includes(kw)) return val;
  return '';
}
function decimalToDMS(dd) {
  const a = Math.abs(dd);
  let d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60);
  if (s === 60) { s = 0; m++; }
  if (m === 60) { m = 0; d++; }
  return { d, m, s };
}
const stripRZ = (z) => (z || '').replace(/^RZ\s*/i, '').trim();

export const request = {
  init(hooks) {
    getFlight = hooks.getFlight || getFlight;
    el('request-btn').addEventListener('click', () => this.openWizard());
    el('requests-btn').addEventListener('click', () => this.openRequests());
    el('requests-list').addEventListener('click', onRequestsListClick);
    auth.onChange((user) => el('requests-btn').classList.toggle('hidden', !(user && auth.configured)));
  },

  async openWizard() {
    if (!window.PDFLib) return toast('PDF engine not loaded — check your connection.');
    const flight = getFlight();
    if (!flight) return toast('Draw a flying zone first.');
    await library.refresh(); // ensure operator/pilots/drones are current
    renderWizard(flight);
    openModal('request-modal');
  },

  async openRequests() {
    openModal('requests-modal');
    el('requests-list').innerHTML = '<p class="hint">Loading…</p>';
    const res = await api('/api/requests');
    reqCache = res.ok ? (await res.json()).items : [];
    if (!reqCache.length) { el('requests-list').innerHTML = '<p class="hint">No generated requests yet.</p>'; return; }
    el('requests-list').innerHTML = reqCache.map((r) => `
      <div class="history-row" data-id="${escapeHtml(r.id)}">
        <div class="hr-main"><div class="hr-name">${escapeHtml(r.label || r.form_type)}</div>
          <div class="hr-meta">${escapeHtml(r.form_type === 'solicitare' ? 'Anexa 2 · Solicitare' : 'Anexa 1 · Informare')} · ${new Date(r.created_at).toLocaleString()}</div></div>
        <div class="hr-actions">
          <button class="btn btn-mini" data-act="download">Download</button>
          <button class="btn btn-mini btn-danger" data-act="delete">Delete</button>
        </div>
      </div>`).join('');
  },
};

// ---------- wizard ----------
function renderWizard(flight) {
  const overlaps = flight.overlaps || [];
  const suggestedTwr = overlaps.length ? towerFromContact(overlaps[0].contact) : '';
  const op = libraryData.operator;

  // The coordinates section is filled according to what the user drew: a circle
  // goes in the circular section; a polygon with ≤5 vertices in the polygon
  // section; a polygon with >5 vertices leaves that section blank (the form only
  // has room for 5 points), which we warn about here.
  const isCircle = !!flight.circle;
  const polyPts = isCircle ? [] : polygonPoints(flight.geometry);
  let areaHint;
  if (isCircle) {
    const r = circleFromFlight(flight.geometry, flight.circle).radius_m;
    areaHint = `The flight area will be filled in the form's <strong>circular</strong> section (center + radius ≈ <strong>${r} m</strong>).`;
  } else if (polyPts.length <= 5) {
    areaHint = `The flight area (<strong>${polyPts.length}</strong> point${polyPts.length === 1 ? '' : 's'}) will be filled in the form's <strong>polygon</strong> section.`;
  } else {
    areaHint = `<span class="rq-warn">⚠ Your polygon has <strong>${polyPts.length}</strong> vertices, but the form's polygon section holds at most <strong>5</strong>. The coordinates section will be left <strong>blank</strong> — reduce the polygon to 5 points or fewer, or draw a circle, to include the flight area.</span>`;
  }

  const opts = (arr, sel) => arr.map((o) => `<option value="${escapeHtml(o[0])}"${o[0] === sel ? ' selected' : ''}>${escapeHtml(o[1])}</option>`).join('');
  const pilotOpts = libraryData.pilots.map((p) => `<option value="${p.id}">${escapeHtml(p.name || 'Unnamed')}</option>`).join('');
  const droneOpts = libraryData.drones.map((d) => `<option value="${d.id}">${escapeHtml([d.manufacturer, d.model].filter(Boolean).join(' ') || d.registration || 'Drone')}</option>`).join('');
  const rzList = overlaps.map((o) => `<option value="${escapeHtml(stripRZ(o.zone_id))}"></option>`).join('');

  el('request-body').innerHTML = `
    <p class="hint">${areaHint}</p>
    <p class="hint">Choose which request you're submitting — this is your decision as the operator.</p>
    ${op && op.operator_name ? '' : '<p class="hint" style="color:var(--warn)">⚠ No operator profile yet — open “👤 Profile” to fill it; operator fields will be blank otherwise.</p>'}
    ${libraryData.drones.length ? '' : '<p class="hint" style="color:var(--warn)">⚠ No drones saved — add one under “👤 Profile”.</p>'}

    <div class="lib-form">
      <label class="lib-field"><span>Request type</span><select id="rq_type">
        <option value="">— Select the request type —</option>
        <option value="informare">Anexa 1 — Informare (open category in CTR)</option>
        <option value="solicitare">Anexa 2 — Solicitare autorizare (restricted zone)</option>
      </select></label>
      <label class="lib-field"><span>Tower / CTR</span><select id="rq_twr">${opts(TOWERS, suggestedTwr)}</select></label>
      <label class="lib-field"><span>Pilot</span><select id="rq_pilot"><option value="">—</option>${pilotOpts}</select></label>
      <label class="lib-field"><span>Drone</span><select id="rq_drone"><option value="">—</option>${droneOpts}</select></label>
      <label class="lib-field rq-solicitare"><span>Restricted zone (RZ)</span><input id="rq_rz" type="text" list="rq-rz-list" value="${overlaps.length ? escapeHtml(stripRZ(overlaps[0].zone_id)) : ''}" /><datalist id="rq-rz-list">${rzList}</datalist></label>
      <label class="lib-field rq-solicitare"><span>Institution aviz (ref.)</span><input id="rq_aviz" type="text" /></label>
      <label class="lib-field"><span>Purpose (scopul zborului)</span><input id="rq_scop" type="text" /></label>
      <label class="lib-field"><span>Operation mode</span><select id="rq_mode"><option value="VLOS">VLOS</option><option value="BVLOS">BVLOS</option></select></label>
      <label class="lib-field"><span>Date from</span><input id="rq_date" type="date" /></label>
      <label class="lib-field"><span>Date to</span><input id="rq_date_end" type="date" /></label>
      <label class="lib-field"><span>Time from (LT)</span><input id="rq_ora" type="time" /></label>
      <label class="lib-field"><span>Time to (LT)</span><input id="rq_ora_end" type="time" /></label>
      <label class="lib-field"><span>Locality</span><input id="rq_loc" type="text" /></label>
      <label class="lib-field"><span>Max height AGL (m)</span><input id="rq_height" type="text" value="120" /></label>
    </div>
    <p id="rq_status" class="hint"></p>
    <button id="rq_generate" class="btn btn-primary btn-block">⬇ Generate &amp; download PDF</button>`;

  const toggleSolicitare = () => {
    const on = el('rq_type').value === 'solicitare';
    el('request-body').querySelectorAll('.rq-solicitare').forEach((n) => n.classList.toggle('hidden', !on));
  };
  el('rq_type').addEventListener('change', toggleSolicitare);
  toggleSolicitare();
  el('rq_generate').addEventListener('click', () => generate(flight));
}

function circleFromFlight(geometry, circle) {
  // If the zone was drawn as a circle, use its exact center + radius.
  if (circle && Array.isArray(circle.center)) {
    return { center: circle.center, radius_m: Math.max(1, Math.round(circle.radius_m)) };
  }
  // Otherwise derive an enclosing circle from the polygon.
  const center = turf.centroid(geometry).geometry.coordinates; // [lng,lat]
  const ring = geometry.coordinates[0] || [];
  let rkm = 0;
  for (const pt of ring) { const d = turf.distance(center, pt); if (d > rkm) rkm = d; }
  return { center, radius_m: Math.max(1, Math.ceil(rkm * 1000)) };
}

// Distinct polygon vertices ([lng, lat]) without the closing duplicate.
function polygonPoints(geometry) {
  const ring = (geometry && geometry.coordinates && geometry.coordinates[0]) || [];
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

// Fill the coordinates section matching the drawn shape: circular for a circle;
// polygon (points 1..N) for a polygon with ≤5 vertices; nothing for a polygon
// with >5 vertices (the form's polygon section only holds 5 points).
function coordinateFields(flight) {
  if (flight.circle) {
    const { center, radius_m } = circleFromFlight(flight.geometry, flight.circle);
    const clat = decimalToDMS(center[1]), clon = decimalToDMS(center[0]);
    return {
      gr_center_lat: String(clat.d), min_center_lat: String(clat.m), sec_center_lat: String(clat.s),
      gr_center_long: String(clon.d), min_center_long: String(clon.m), sec_center_long: String(clon.s),
      raza: String(radius_m),
    };
  }
  const pts = polygonPoints(flight.geometry);
  if (pts.length > 5) return {};
  const out = {};
  pts.forEach(([lng, lat], i) => {
    const n = i + 1, dlat = decimalToDMS(lat), dlon = decimalToDMS(lng);
    out[`gr${n}_lat`] = String(dlat.d); out[`min${n}_lat`] = String(dlat.m); out[`sec${n}_lat`] = String(dlat.s);
    out[`gr${n}_long`] = String(dlon.d); out[`min${n}_long`] = String(dlon.m); out[`sec${n}_long`] = String(dlon.s);
  });
  return out;
}

function buildFields(flight) {
  const type = el('rq_type').value;
  const op = libraryData.operator || {};
  const pilot = libraryData.pilots.find((p) => p.id === el('rq_pilot').value) || {};
  const drone = libraryData.drones.find((d) => d.id === el('rq_drone').value) || {};
  const v = (id) => (el(id) ? el(id).value.trim() : '');

  const text = {
    operator: op.operator_name, 'Date de contact': op.contact_details, pers_contact: op.contact_person,
    telefon_fix: op.phone_landline, mobil: op.phone_mobile, Fax: op.fax, email: op.email,
    inmatriculare: drone.registration, greutate: drone.mtom_kg != null ? String(drone.mtom_kg) : '',
    Nume_pilot: pilot.name, telefon_pilot: pilot.phone,
    scop_zbor: v('rq_scop'), localitatea: v('rq_loc'), inaltime_zbor: v('rq_height'),
    data_zbor: v('rq_date'), data_zbor_end: v('rq_date_end'), ora_start: v('rq_ora'), 'ora_finală': v('rq_ora_end'),
    ...coordinateFields(flight),
  };
  // Baked appearances render the /V text directly, so use readable values (the
  // drone's real class, VLOS/BVLOS) rather than the form's quirky export codes.
  const dropdowns = {
    TWR: v('rq_twr'), Clasa: drone.operating_class || '', categorie_zbor: drone.category || '',
    mod_operare: v('rq_mode') || 'VLOS',
  };
  if (type === 'solicitare') { text.RZ = stripRZ(v('rq_rz')); text.calificari = pilot.qualifications; text.aviz = v('rq_aviz'); }

  const label = type === 'solicitare'
    ? `Anexa 2 · RZ ${stripRZ(v('rq_rz'))} · ${v('rq_date') || ''}`
    : `Anexa 1 · ${v('rq_loc') || ''} · ${v('rq_date') || ''}`;
  return { type, text, dropdowns, label };
}

let _fontBytesPromise = null;
function fontBytes() {
  if (!_fontBytesPromise) _fontBytesPromise = fetch('/fonts/DejaVuSans.ttf').then((r) => r.arrayBuffer());
  return _fontBytesPromise;
}

async function fillPdf(type, text, dropdowns) {
  const { PDFName, PDFHexString, PDFString } = PDFLib;
  const path = type === 'solicitare' ? '/forms/anexa2_solicitare.pdf' : '/forms/anexa1_informare.pdf';
  const bytes = await (await fetch(path)).arrayBuffer();
  const pdf = await PDFLib.PDFDocument.load(bytes);
  // Bake field appearances ourselves with an embedded Unicode font. This is the
  // only approach that renders in EVERY viewer (incl. macOS Preview) AND supports
  // Romanian diacritics (ș, ț, ă, î, â) — pdf-lib's default WinAnsi appearance
  // font cannot encode them, and relying on the viewer (NeedAppearances) drops
  // them too. We set each value at /V (Unicode-safe) then regenerate that field's
  // appearance with the font. Result stays editable; the signature is left blank.
  pdf.registerFontkit(window.fontkit);
  const font = await pdf.embedFont(await fontBytes(), { subset: true });
  const form = pdf.getForm();
  const asStr = (v) => (/[^\x00-\x7F]/.test(v) ? PDFHexString.fromText(v) : PDFString.of(v));
  for (const [name, val] of Object.entries(text)) {
    if (val == null || val === '') continue;
    try {
      const f = form.getTextField(name);
      f.acroField.dict.set(PDFName.of('V'), PDFHexString.fromText(String(val)));
      f.updateAppearances(font);
    } catch { /* field not on this form */ }
  }
  for (const [name, val] of Object.entries(dropdowns)) {
    if (!val) continue;
    try {
      const f = form.getDropdown(name);
      f.acroField.dict.set(PDFName.of('V'), asStr(String(val)));
      f.updateAppearances(font);
    } catch (e) { console.warn('dropdown', name, val, e.message); }
  }
  return pdf.save({ updateFieldAppearances: false });
}

async function generate(flight) {
  if (!el('rq_type').value) {
    el('rq_status').textContent = 'Please choose the request type (Anexa 1 or Anexa 2) first.';
    return;
  }
  const { type, text, dropdowns, label } = buildFields(flight);
  el('rq_status').textContent = 'Generating…';
  let bytes;
  try { bytes = await fillPdf(type, text, dropdowns); }
  catch (e) { el('rq_status').textContent = 'Failed: ' + e.message; return; }
  downloadPdf(bytes, `${type === 'solicitare' ? 'anexa2-solicitare' : 'anexa1-informare'}-${Date.now()}.pdf`);
  el('rq_status').textContent = '✓ Downloaded.';
  // Save to history (best-effort).
  api('/api/requests', { method: 'POST', body: JSON.stringify({ form_type: type, label, fields: { text, dropdowns } }) })
    .then((r) => { if (r.ok) toast('Request generated and saved to history.'); });
}

function downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- requests history ----------
let reqCache = [];
async function onRequestsListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = e.target.closest('.history-row').dataset.id;
  const r = reqCache.find((x) => x.id === id);
  if (!r) return;
  if (btn.dataset.act === 'download') {
    const f = r.fields || {};
    const bytes = await fillPdf(r.form_type, f.text || {}, f.dropdowns || {});
    downloadPdf(bytes, `${r.form_type}-${id.slice(0, 8)}.pdf`);
  } else if (btn.dataset.act === 'delete') {
    if (!window.confirm('Delete this saved request?')) return;
    const res = await api('/api/requests/' + id, { method: 'DELETE' });
    if (res.ok || res.status === 204) request.openRequests(); else toast('Delete failed.');
  }
}

// ---------- helpers ----------
function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  return fetch(path, { ...opts, headers });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
