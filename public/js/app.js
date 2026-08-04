import { buildKml, downloadKml } from './kml.js';
import { auth } from './auth.js';
import { history } from './history.js';
import { billing } from './billing.js';
import { library } from './library.js';
import { request } from './request-form.js';
import { initVolumePlanner } from './volume-planner.js';
import './consent.js';

/* ------------------------------------------------------------------ *
 * Drones Restricted Zones RO — frontend controller.
 *
 * Wires together three things around a Leaflet map:
 *   - the restricted-zone layers + the synced list on the right
 *   - a drawn "flying zone" (Leaflet-Geoman) with overlap analysis on the left
 *   - KML export of the flying zone
 * ------------------------------------------------------------------ */

// dashArray is set explicitly on every style (incl. null) so setStyle() reliably
// clears the dashes when a "new" zone becomes selected/overlap.
const STYLE = {
  base:     { color: '#2563eb', weight: 1, opacity: 0.7, fillColor: '#3b82f6', fillOpacity: 0.10, dashArray: null },
  selected: { color: '#f97316', weight: 3, opacity: 1,   fillColor: '#f97316', fillOpacity: 0.35, dashArray: null },
  overlap:  { color: '#dc2626', weight: 2, opacity: 1,   fillColor: '#dc2626', fillOpacity: 0.30, dashArray: null },
  flight:   { color: '#16a34a', weight: 2, opacity: 1,   fillColor: '#16a34a', fillOpacity: 0.20, dashArray: null },
  isNew:    { color: '#0891b2', weight: 3, opacity: 1,   fillColor: '#06b6d4', fillOpacity: 0.25, dashArray: '5,4' },
  ctr:      { color: '#7c3aed', weight: 2, opacity: 1,   fillColor: '#8b5cf6', fillOpacity: 0.28, dashArray: null },
  permanent:{ color: '#db2777', weight: 2, opacity: 1,   fillColor: '#ec4899', fillOpacity: 0.30, dashArray: null },
  notam:    { color: '#b45309', weight: 2, opacity: 1,   fillColor: '#f59e0b', fillOpacity: 0.28, dashArray: '6,4' },
};

// zone key -> { feature, layer, item, bbox, searchText }
const zones = new Map();
const state = {
  selectedIds: new Set(), // zones picked by a map/list click (may be several at one point)
  overlapIds: new Set(),
  flightLayer: null,
  flightShape: null,   // 'polygon' | 'circle'
  circle: null,        // { center: [lng, lat], radius_m } when flightShape === 'circle'
  newZones: new Set(), // zone_ids added in the current dataset version
  ctrZones: new Set(), // zone_ids classified as CTR (control zone)
  newOnly: false,      // "New (N)" chip filter active
};

// Radius unit → metres.
const RADIUS_UNIT_M = { m: 1, km: 1000, NM: 1852 };

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);
const els = {
  status: $('data-status'),
  validFrom: $('valid-from'),
  newChip: $('new-chip'),
  refresh: $('refresh-btn'),
  zoneList: $('zone-list'),
  zoneCount: $('zone-count'),
  search: $('zone-search'),
  drawBtn: $('draw-btn'),
  drawCircleBtn: $('draw-circle-btn'),
  circleRadiusRow: $('circle-radius-row'),
  circleRadius: $('circle-radius'),
  circleRadiusUnit: $('circle-radius-unit'),
  editBtn: $('edit-btn'),
  clearBtn: $('clear-btn'),
  drawHint: $('draw-hint'),
  summary: $('flight-summary'),
  statArea: $('stat-area'),
  statVertices: $('stat-vertices'),
  statOverlaps: $('stat-overlaps'),
  exportBtn: $('export-kml-btn'),
  saveBtn: $('save-flight-btn'),
  requestBtn: $('request-btn'),
  coordsList: $('coords-list'),
  copyCoordsBtn: $('copy-coords-btn'),
  overlapList: $('overlap-list'),
};

// ---- Map ----
const map = L.map('map', { zoomControl: true }).setView([45.9432, 24.9668], 7);

// Basemap gallery — the underlying map style. Zones/NOTAMs/drawings live in higher
// panes, so they always stay on top when the basemap changes. All free / no API key.
const basemaps = {
  'Street (OSM)': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
  'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }),
  'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }),
  'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }),
  'Topographic': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }),
};

// Restore the user's last choice (persisted); default to Dark.
let savedBase = null;
try { savedBase = localStorage.getItem('dz-basemap'); } catch { /* private mode */ }
const startBase = (savedBase && basemaps[savedBase]) ? savedBase : 'Dark';
basemaps[startBase].addTo(map);

L.control.layers(basemaps, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => { try { localStorage.setItem('dz-basemap', e.name); } catch { /* ignore */ } });

const zonesGroup = L.geoJSON(null, {
  style: STYLE.base,
  onEachFeature: (feature, layer) => registerZone(feature, layer),
}).addTo(map);

// Clicking empty map (not on any zone layer) runs the same point query, which
// clears the selection when nothing is there. Guarded while drawing/editing.
map.on('click', (e) => selectAtPoint(e.latlng));

// Live coordinate readout — always shows the cursor's lat/lng as it moves.
const coordControl = L.control({ position: 'bottomleft' });
coordControl.onAdd = function () {
  this._div = L.DomUtil.create('div', 'coord-readout');
  this._div.innerHTML = '<span class="cr-label">Lat, Lng</span> —';
  return this._div;
};
coordControl.update = function (latlng) {
  this._div.innerHTML = latlng
    ? `<span class="cr-label">Lat, Lng</span> ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`
    : '<span class="cr-label">Lat, Lng</span> —';
};
coordControl.addTo(map);
map.on('mousemove', (e) => coordControl.update(e.latlng));
map.on('mouseout', () => coordControl.update(null));

// =================================================================== //
//  Volume Planner map bridge (draw FG → buffer to CV/GRB → overlap)
// =================================================================== //
const plannerGroup = L.layerGroup().addTo(map);
let plannerFG = null;          // Feature<Polygon> — the drawn flight geography
let plannerDrawing = false;    // true while Geoman is drawing for the planner
// LBA colours: Flight Geography green · Contingency Volume yellow · GRB red.
const VP_STYLE = {
  fg:  { color: '#16a34a', weight: 2, opacity: 1, fillColor: '#22c55e', fillOpacity: 0.25, dashArray: null },
  cv:  { color: '#d97706', weight: 2, opacity: 1, fillColor: '#f59e0b', fillOpacity: 0.18, dashArray: null },
  grb: { color: '#dc2626', weight: 2, opacity: 1, fillColor: '#ef4444', fillOpacity: 0.12, dashArray: null },
};

// Which live restrictions intersect a given footprint (reuses the zone index).
function findZoneOverlaps(feature) {
  const bb = turf.bbox(feature);
  const out = [];
  zones.forEach((r, id) => {
    if (!bboxOverlap(bb, r.bbox)) return;
    try { if (!turf.booleanIntersects(feature, r.feature)) return; } catch { return; }
    let overlapArea = null;
    try {
      const inter = turf.intersect(turf.featureCollection([feature, r.feature]));
      if (inter) overlapArea = turf.area(inter);
    } catch { /* degenerate geometry */ }
    out.push({ id, feature: r.feature, overlapArea });
  });
  return out;
}

const vpBridge = {
  hasFG: () => Boolean(plannerFG),
  // Enable Geoman to draw the flight geography; onDone(fgFeature) when finished.
  drawFG(shape, onDone) {
    plannerDrawing = true;
    map.pm.disableDraw();
    if (shape === 'circle') map.pm.enableDraw('Circle', { snappable: true });
    else map.pm.enableDraw('Polygon', { snappable: true, finishOn: 'dblclick' });
    map.once('pm:create', (e) => {
      map.pm.disableDraw();
      let fg;
      if (e.shape === 'Circle') {
        const c = e.layer.getLatLng();
        fg = turf.circle([c.lng, c.lat], e.layer.getRadius() / 1000, { steps: 64, units: 'kilometers' });
      } else {
        fg = e.layer.toGeoJSON();
      }
      map.removeLayer(e.layer);
      plannerFG = fg;
      plannerGroup.clearLayers();
      L.geoJSON(fg, { style: VP_STYLE.fg }).addTo(plannerGroup);
      try { map.fitBounds(L.geoJSON(fg).getBounds(), { padding: [60, 60] }); } catch { /* */ }
      plannerDrawing = false;
      if (onDone) onDone(fg);
    });
  },
  // Buffer the stored FG outward by S_CV then S_GRB, draw all three, return
  // the overlap list + ground-projection areas.
  buildAndDraw(SCV, SGRB) {
    if (!plannerFG) return null;
    const cv = turf.buffer(plannerFG, SCV / 1000, { units: 'kilometers', steps: 24 });
    const grb = turf.buffer(cv, SGRB / 1000, { units: 'kilometers', steps: 24 });
    plannerGroup.clearLayers();
    L.geoJSON(grb, { style: VP_STYLE.grb }).addTo(plannerGroup);
    L.geoJSON(cv, { style: VP_STYLE.cv }).addTo(plannerGroup);
    L.geoJSON(plannerFG, { style: VP_STYLE.fg }).addTo(plannerGroup);
    try { map.fitBounds(L.geoJSON(grb).getBounds(), { padding: [40, 40] }); } catch { /* */ }
    return {
      overlaps: findZoneOverlaps(grb),
      areas: { fg: turf.area(plannerFG), cv: turf.area(cv), grb: turf.area(grb) },
    };
  },
  clear() { plannerFG = null; plannerGroup.clearLayers(); },
};

// =================================================================== //
//  Data loading
// =================================================================== //
async function loadZones({ refresh = false } = {}) {
  setStatus('loading', 'Loading zones…');
  try {
    const res = await fetch('/api/zones' + (refresh ? '?refresh=1' : ''));
    if (!res.ok) throw new Error(`server responded ${res.status}`);
    const { meta, geojson } = await res.json();

    zones.clear();
    zonesGroup.clearLayers();
    state.selectedIds = new Set();
    state.overlapIds.clear();
    // Must be set BEFORE addData so registerZone/styleFor can flag new/CTR zones.
    state.newZones = new Set((meta && meta.dataset && meta.dataset.newZones) || []);
    state.ctrZones = new Set((meta && meta.dataset && meta.dataset.ctrZones) || []);
    state.datasetValidFrom = (meta && meta.dataset && meta.dataset.validFrom) || null;
    zonesGroup.addData(geojson);

    // Merge the bundled permanent prohibited/restricted zones (LRP/LRR) — these
    // are national permanent zones, not part of the ROMATSA UAV feed.
    try {
      const perm = await (await fetch('/data/permanent_zones.json')).json();
      if (perm && Array.isArray(perm.features)) zonesGroup.addData(perm);
    } catch (e) {
      console.warn('permanent zones failed to load:', e.message);
    }

    // Merge active + upcoming NOTAMs (time-limited restrictions). A manual refresh
    // forces a live re-pull of the NOTAMs too, not just the zones.
    await loadNotams({ refresh });

    renderZoneList();
    els.zoneCount.textContent = zones.size;
    applyStatusMeta(meta);
    renderDatasetInfo(meta);
  } catch (err) {
    console.error(err);
    setStatus('error', 'Failed to load zones');
    els.zoneList.innerHTML = `<div class="zone-list-empty">Could not load restricted zones.<br>${escapeHtml(err.message)}</div>`;
  }
}

// Fetch NOTAMs, keep active + upcoming (drop expired), normalise each into the
// common zone property shape, and add them to the map/list.
async function loadNotams({ refresh = false } = {}) {
  try {
    const { geojson } = await (await fetch('/api/notams' + (refresh ? '?refresh=1' : ''))).json();
    if (!geojson || !Array.isArray(geojson.features)) return;
    const now = Date.now();
    const features = geojson.features
      .map((f) => normalizeNotam(f, now))
      .filter((f) => f && f.properties.notam_state !== 'expired');
    if (features.length) zonesGroup.addData({ type: 'FeatureCollection', features });
    state.notamCount = features.length;
  } catch (e) {
    console.warn('NOTAMs failed to load:', e.message);
  }
}

const NOTAM_TIP = { R: 'Restricted', D: 'Danger', O: 'Other' };

// Turn a raw ROMATSA NOTAM feature into the shared zone property shape.
function normalizeNotam(f, now) {
  const p = f.properties || {};
  if (!f.geometry) return null;
  const from = Date.parse(p.dfrom);
  const to = Date.parse(p.dto);
  let stateName = 'active';
  if (isFinite(to) && to < now) stateName = 'expired';
  else if (isFinite(from) && from > now) stateName = 'upcoming';

  const msg = (p.mesaj || '').replace(/\r/g, ' ');
  const fg = msg.match(/\bF\)\s*([\s\S]*?)\s*\bG\)\s*([\s\S]*?)\s*\)?\s*$/);
  const lower = fg ? fg[1].trim() : 'GND';
  const upper = fg ? fg[2].trim() : '';
  const eMatch = msg.match(/\bE\)\s*([\s\S]*?)\s*(?=\bF\)|\bG\)|$)/);
  const desc = eMatch ? eMatch[1].replace(/\s+/g, ' ').trim() : '';

  return {
    type: 'Feature',
    id: f.id,
    geometry: f.geometry,
    properties: {
      zone_id: p.serie || 'NOTAM',
      lower_lim: lower || 'GND',
      upper_lim: upper || '',
      contact: desc,
      status: 'NOTAM',
      category: 'notam',
      notam_tip: p.tip || '',
      notam_from: p.dfrom || null,
      notam_to: p.dto || null,
      notam_state: stateName,
      notam_raw: msg.replace(/\s+/g, ' ').trim(), // full decoded message for the expanded view
    },
  };
}

// "3 Aug 07:00Z → 3 Aug 14:30Z" (times in UTC, as NOTAMs are published).
function formatNotamValidity(from, to) {
  const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' };
  const fmt = (s) => (s ? new Date(s).toLocaleString('en-GB', opts) + 'Z' : '?');
  return `${fmt(from)} → ${fmt(to)}`;
}

function registerZone(feature, layer) {
  const key = feature.id || feature.properties.zone_id;
  const p = feature.properties || {};
  const record = {
    feature,
    layer,
    item: null,
    isNew: state.newZones.has(p.zone_id),
    isCtr: state.ctrZones.has(p.zone_id),
    isPermanent: p.category === 'permanent',
    isNotam: p.category === 'notam',
    bbox: turf.bbox(feature), // [minX, minY, maxX, maxY]
    searchText: `${p.zone_id || ''} ${p.status || ''} ${p.contact || ''} ${p.lower_lim || ''} ${p.upper_lim || ''}`.toLowerCase(),
  };
  zones.set(key, record);

  layer.setStyle(styleFor(key)); // paints new zones with the "new" style up front
  // Click a zone → select EVERY restriction stacked at that exact point (not just
  // the top layer). Map clicks on empty areas clear the selection (see map 'click').
  // While drawing/editing a flying zone we must NOT swallow the click — let it
  // bubble to Geoman so a vertex can be placed even over a restriction.
  layer.on('click', (e) => {
    if (isBusyDrawing()) return;
    L.DomEvent.stop(e);
    selectAtPoint(e.latlng);
  });
}

// =================================================================== //
//  Restricted-zone list (right panel) — grouped, collapsible, expandable
// =================================================================== //
function renderZoneList() {
  // Partition into branches: RZ (with a CTR subgroup), NOTAMs, Permanent.
  const g = { ctr: [], rz: [], notam: [], permanent: [] };
  zones.forEach((r, key) => {
    if (r.isNotam) g.notam.push([key, r]);
    else if (r.isPermanent) g.permanent.push([key, r]);
    else if (r.isCtr) g.ctr.push([key, r]);
    else g.rz.push([key, r]);
  });
  const byId = (a, b) =>
    (a[1].feature.properties.zone_id || '').localeCompare(
      b[1].feature.properties.zone_id || '', undefined, { numeric: true }
    );
  Object.values(g).forEach((list) => list.sort(byId));

  const sections = [];
  const rzTotal = g.ctr.length + g.rz.length;
  if (rzTotal) {
    let body = '';
    if (g.ctr.length) body += subHtml('Control zones (CTR)', g.ctr);
    if (g.rz.length) body += subHtml(g.ctr.length ? 'Other restricted zones' : 'Restricted zones', g.rz);
    sections.push(sectionHtml('rz', 'Restricted zones (RZ)', rzTotal, body));
  }
  if (g.notam.length) sections.push(sectionHtml('notam', 'NOTAMs', g.notam.length, itemsHtml(g.notam)));
  if (g.permanent.length) sections.push(sectionHtml('permanent', 'Permanent restrictions', g.permanent.length, itemsHtml(g.permanent)));

  els.zoneList.innerHTML = sections.join('') || '<div class="zone-list-empty">No zones.</div>';

  // Cache element refs back onto the records.
  els.zoneList.querySelectorAll('.zone-item').forEach((el) => {
    const rec = zones.get(el.dataset.id);
    if (rec) rec.item = el;
  });
}

function sectionHtml(cat, name, count, body) {
  return `<section class="zgroup" data-cat="${cat}">
    <button type="button" class="zgroup-head" aria-expanded="true">
      <span class="zg-caret" aria-hidden="true">▾</span>
      <span class="zg-name">${escapeHtml(name)}</span>
      <span class="zg-count" data-total="${count}">${count}</span>
    </button>
    <div class="zgroup-body">${body}</div>
  </section>`;
}

function subHtml(name, list) {
  return `<div class="zsub">
    <div class="zsub-head">${escapeHtml(name)} <span class="zsub-count" data-total="${list.length}">${list.length}</span></div>
    ${itemsHtml(list)}
  </div>`;
}

function itemsHtml(list) {
  return list.map(([key, r]) => zoneItemHtml(key, r)).join('');
}

// One collapsed-by-default row: a summary line + a hidden detail panel.
function zoneItemHtml(key, r) {
  const p = r.feature.properties || {};
  const accent = r.isNotam ? 'is-notam'
    : r.isPermanent ? 'is-permanent'
    : r.isNew ? 'is-new'
    : r.isCtr ? 'is-ctr'
    : 'is-rz';
  const alt = `${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}`;
  return `<div class="zone-item ${accent}" data-id="${escapeHtml(key)}" role="option">
    <div class="zi-title"><span>${escapeHtml(p.zone_id || '—')}${zonePills(r, p)}</span>
      <span class="zi-alt">${alt}</span></div>
    <div class="zi-detail">${zoneDetailHtml(r, p, key)}</div>
  </div>`;
}

function zonePills(r, p) {
  if (r.isNotam) {
    const t = NOTAM_TIP[p.notam_tip] || p.notam_tip || '';
    return ` <span class="notam-pill">NOTAM${t ? ' · ' + escapeHtml(t) : ''}</span>` +
      (p.notam_state === 'active' ? ' <span class="notam-active">ACTIVE</span>' : '');
  }
  let s = '';
  if (r.isPermanent) s += ` <span class="perm-pill">${p.kind === 'prohibited' ? 'PROHIBITED' : 'RESTRICTED'}</span>`;
  if (r.isCtr) s += ' <span class="ctr-pill" title="Control zone (CTR)">CTR</span>';
  if (r.isNew) s += ` <span class="new-pill" title="Added ${escapeHtml(state.datasetValidFrom || '')}">NEW</span>`;
  return s;
}

function zoneDetailHtml(r, p, key) {
  const rows = [detRow('Altitude', `${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}`)];
  if (r.isNotam) {
    const t = NOTAM_TIP[p.notam_tip] || p.notam_tip || '';
    rows.push(detRow('Type', `NOTAM${t ? ' · ' + escapeHtml(t) : ''} (${p.notam_state === 'active' ? 'active now' : 'upcoming'})`));
    rows.push(detRow('Valid', escapeHtml(formatNotamValidity(p.notam_from, p.notam_to))));
    if (p.notam_raw) rows.push(`<div class="zd-raw">${escapeHtml(p.notam_raw)}</div>`);
  } else {
    rows.push(detRow('Status', escapeHtml(p.status || '?')));
    if (r.isCtr) rows.push(detRow('Class', 'Control zone (CTR)'));
    if (r.isPermanent) rows.push(detRow('Type', `Permanent ${p.kind === 'prohibited' ? 'prohibited' : 'restricted'} zone`));
    if (p.contact) rows.push(detRow(r.isPermanent ? 'Notes' : 'Contact', escapeHtml(p.contact)));
  }
  rows.push(`<button type="button" class="zi-zoom" data-zoom="${escapeHtml(key)}">⤢ Zoom to on map</button>`);
  return rows.join('');
}

function detRow(label, val) {
  return `<div class="zd-row"><span class="zd-label">${escapeHtml(label)}</span><span class="zd-val">${val}</span></div>`;
}

// Event delegation for list clicks: collapse a section, zoom a row, or expand a row.
els.zoneList.addEventListener('click', (e) => {
  const head = e.target.closest('.zgroup-head');
  if (head) {
    const sec = head.closest('.zgroup');
    const collapsed = sec.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    return;
  }
  const zoom = e.target.closest('.zi-zoom');
  if (zoom) { selectZone(zoom.dataset.zoom, { pan: true }); return; }
  const item = e.target.closest('.zone-item');
  if (item) {
    const id = item.dataset.id;
    item.classList.toggle('expanded');
    // Highlight on the map without moving it (per design: expand-in-place).
    applySelection(new Set([id]));
    const r = zones.get(id);
    if (r) r.layer.bringToFront();
  }
});

// Search / filter (text search + "New only" chip combine). Hides empty
// sub-groups/sections and reflects the visible counts while filtering.
function applyZoneFilter() {
  const q = els.search.value.trim().toLowerCase();
  const filtered = Boolean(q || state.newOnly);
  zones.forEach((r) => {
    if (!r.item) return;
    const show = (!q || r.searchText.includes(q)) && (!state.newOnly || r.isNew);
    r.item.classList.toggle('hidden', !show);
  });
  els.zoneList.querySelectorAll('.zsub').forEach((sub) => {
    const vis = sub.querySelectorAll('.zone-item:not(.hidden)').length;
    sub.classList.toggle('hidden', vis === 0);
    const c = sub.querySelector('.zsub-count');
    if (c) c.textContent = filtered ? vis : c.dataset.total;
  });
  els.zoneList.querySelectorAll('.zgroup').forEach((sec) => {
    const vis = sec.querySelectorAll('.zone-item:not(.hidden)').length;
    sec.classList.toggle('hidden', vis === 0);
    const gc = sec.querySelector('.zg-count');
    if (gc) gc.textContent = filtered ? vis : gc.dataset.total;
  });
  const total = els.zoneList.querySelectorAll('.zone-item:not(.hidden)').length;
  els.zoneCount.textContent = filtered ? `${total}/${zones.size}` : String(zones.size);
}

els.search.addEventListener('input', () => {
  // Typing in the search box clears the "New only" filter for clarity.
  if (state.newOnly) {
    state.newOnly = false;
    els.newChip.classList.remove('active');
  }
  applyZoneFilter();
});

els.newChip.addEventListener('click', () => {
  state.newOnly = !state.newOnly;
  els.newChip.classList.toggle('active', state.newOnly);
  els.search.value = '';
  applyZoneFilter();
  if (state.newOnly) zoomToNewZones();
});

function zoomToNewZones() {
  const bounds = L.latLngBounds([]);
  zones.forEach((r) => {
    if (r.isNew) bounds.extend(r.layer.getBounds());
  });
  if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 11, padding: [60, 60] });
}

// =================================================================== //
//  Selection & styling
// =================================================================== //
function styleFor(id) {
  if (state.selectedIds.has(id)) return STYLE.selected;
  if (state.overlapIds.has(id)) return STYLE.overlap;
  const r = zones.get(id);
  if (r && r.isNotam) return STYLE.notam;
  if (r && r.isPermanent) return STYLE.permanent;
  if (r && r.isNew) return STYLE.isNew;
  if (r && r.isCtr) return STYLE.ctr;
  return STYLE.base;
}

function restyleZone(id) {
  const r = zones.get(id);
  if (!r) return;
  r.layer.setStyle(styleFor(id));
  if (r.item) {
    r.item.classList.toggle('selected', state.selectedIds.has(id));
    r.item.classList.toggle('overlap', state.overlapIds.has(id) && !state.selectedIds.has(id));
  }
}

// Replace the current selection with `ids` (a Set), restyling only what changed
// and bringing the newly-selected layers to the front.
function applySelection(ids) {
  const prev = state.selectedIds || new Set();
  state.selectedIds = ids;
  new Set([...prev, ...ids]).forEach(restyleZone);
  ids.forEach((id) => {
    const r = zones.get(id);
    if (r) r.layer.bringToFront();
  });
}

// True while the user is drawing or editing the flying zone — map clicks then
// belong to Geoman, not to zone selection.
function isBusyDrawing() {
  return (
    (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) ||
    (state.flightLayer && state.flightLayer.pm && state.flightLayer.pm.enabled())
  );
}

// Select EVERY restriction whose polygon contains the clicked point, list them all
// in a popup at that point, and highlight them all in the right-hand list.
function selectAtPoint(latlng) {
  if (isBusyDrawing()) return;
  const lng = latlng.lng, lat = latlng.lat;
  const pt = turf.point([lng, lat]);
  const matches = [];
  zones.forEach((r, id) => {
    const b = r.bbox; // quick reject via bbox before the point-in-polygon test
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return;
    try {
      if (turf.booleanPointInPolygon(pt, r.feature)) matches.push(id);
    } catch {
      /* skip degenerate geometry */
    }
  });

  if (!matches.length) {
    applySelection(new Set());
    map.closePopup();
    return;
  }

  const ordered = matches.sort((a, b) =>
    (zones.get(a).feature.properties.zone_id || '').localeCompare(
      zones.get(b).feature.properties.zone_id || '', undefined, { numeric: true }
    )
  );
  applySelection(new Set(ordered));
  const first = zones.get(ordered[0]);
  if (first && first.item) first.item.scrollIntoView({ block: 'nearest' });
  L.popup({ maxWidth: 320 })
    .setLatLng(latlng)
    .setContent(pointPopupHtml(ordered, latlng))
    .openOn(map);
}

// Backwards-compatible single-zone select used by the list + overlap cards.
function selectZone(id, { pan = false } = {}) {
  applySelection(new Set([id]));
  const r = zones.get(id);
  if (!r) return;
  r.layer.bringToFront();
  if (r.item) r.item.scrollIntoView({ block: 'nearest' });
  if (pan) panToZone(id);
  else r.layer.openPopup();
}

function panToZone(id) {
  const r = zones.get(id);
  if (!r) return;
  map.fitBounds(r.layer.getBounds(), { maxZoom: 13, padding: [40, 40] });
  r.layer.openPopup();
}

// =================================================================== //
//  Drawing the flying zone (left panel)
// =================================================================== //
els.drawBtn.addEventListener('click', () => {
  if (!billing.ensurePro()) return; // gate: sign-in / active trial / subscription
  map.pm.enableDraw('Polygon', { snappable: true, finishOn: 'dblclick', templineStyle: STYLE.flight, hintlineStyle: STYLE.flight });
  els.drawHint.textContent = 'Click on the map to add corners. Double-click the last point (or click the first) to finish.';
});

els.drawCircleBtn.addEventListener('click', () => {
  if (!billing.ensurePro()) return;
  map.pm.enableDraw('Circle', { snappable: true, hintlineStyle: STYLE.flight });
  els.drawHint.textContent = 'Click a center point on the map, then click again to set the radius. Fine-tune the radius below.';
});

map.pm.setGlobalOptions({ pathOptions: STYLE.flight });

map.on('pm:create', (e) => {
  if (plannerDrawing) return; // the Volume Planner handles its own draw
  if (e.shape === 'Circle') activateFlight(e.layer, 'circle');
  else if (e.shape === 'Polygon') activateFlight(e.layer, 'polygon');
});

// Shared setup for the active flying-zone layer (freshly drawn or reloaded).
function activateFlight(layer, shape, { fit = false } = {}) {
  if (state.flightLayer) map.removeLayer(state.flightLayer);
  state.flightLayer = layer;
  state.flightShape = shape;
  layer.setStyle(STYLE.flight);
  layer.on('pm:edit', onFlightEdit);
  layer.on('pm:markerdragend', onFlightEdit);
  els.editBtn.disabled = false;
  els.clearBtn.disabled = false;
  els.summary.classList.remove('hidden');
  els.circleRadiusRow.classList.toggle('hidden', shape !== 'circle');
  if (shape === 'circle') {
    const c = layer.getLatLng();
    state.circle = { center: [c.lng, c.lat], radius_m: layer.getRadius() };
    showRadiusInUnit();
  } else {
    state.circle = null;
  }
  if (auth.configured) {
    els.saveBtn.classList.remove('hidden');
    els.requestBtn.classList.remove('hidden');
  }
  analyzeFlight();
  if (fit) map.fitBounds(layer.getBounds(), { padding: [50, 50] });
}

// Keep the circle model in sync when the layer is edited (center dragged / radius resized).
function onFlightEdit() {
  if (state.flightShape === 'circle' && state.flightLayer) {
    const c = state.flightLayer.getLatLng();
    state.circle = { center: [c.lng, c.lat], radius_m: state.flightLayer.getRadius() };
    showRadiusInUnit();
  }
  analyzeFlight();
}

// Reload a saved GeoJSON Polygon back onto the map as the active flying zone.
function loadSavedFlight(geometry) {
  const ring = (geometry && geometry.coordinates && geometry.coordinates[0]) || [];
  const latlngs = ring.map(([lng, lat]) => [lat, lng]);
  if (latlngs.length < 3) return;
  const layer = L.polygon(latlngs).addTo(map);
  activateFlight(layer, 'polygon', { fit: true });
}

// --- circle radius editor (m / km / NM) ---
function showRadiusInUnit() {
  if (!state.circle) return;
  const v = state.circle.radius_m / RADIUS_UNIT_M[els.circleRadiusUnit.value];
  els.circleRadius.value = els.circleRadiusUnit.value === 'm' ? String(Math.round(v)) : String(Math.round(v * 1000) / 1000);
}
function applyRadiusInput() {
  if (state.flightShape !== 'circle' || !state.circle || !state.flightLayer) return;
  const meters = (parseFloat(els.circleRadius.value) || 0) * RADIUS_UNIT_M[els.circleRadiusUnit.value];
  if (!(meters > 0)) return;
  state.circle.radius_m = meters;
  state.flightLayer.setRadius(meters);
  analyzeFlight();
}
els.circleRadius.addEventListener('input', applyRadiusInput);
els.circleRadiusUnit.addEventListener('change', showRadiusInUnit);

els.editBtn.addEventListener('click', () => {
  if (!state.flightLayer) return;
  if (state.flightLayer.pm.enabled()) {
    state.flightLayer.pm.disable();
    els.editBtn.textContent = 'Edit';
  } else {
    state.flightLayer.pm.enable({ allowSelfIntersection: false });
    els.editBtn.textContent = 'Done';
  }
});

els.clearBtn.addEventListener('click', clearFlight);

function clearFlight() {
  if (state.flightLayer) {
    map.removeLayer(state.flightLayer);
    state.flightLayer = null;
  }
  state.flightShape = null;
  state.circle = null;
  clearOverlaps();
  els.summary.classList.add('hidden');
  els.circleRadiusRow.classList.add('hidden');
  els.saveBtn.classList.add('hidden');
  els.requestBtn.classList.add('hidden');
  els.editBtn.disabled = true;
  els.clearBtn.disabled = true;
  els.editBtn.textContent = 'Edit';
  els.drawHint.textContent = 'Draw a polygon (click corners, double-click to finish) or a circle (click a center, then set the radius).';
}

// =================================================================== //
//  Overlap analysis
// =================================================================== //
function bboxOverlap(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function clearOverlaps() {
  const prev = [...state.overlapIds];
  state.overlapIds.clear();
  prev.forEach(restyleZone);
}

// The flight geometry as a Feature<Polygon> — a circle becomes a 64-gon
// approximation so all overlap/area/export logic works unchanged.
function flightGeoJSON() {
  if (state.flightShape === 'circle' && state.circle) {
    return turf.circle(state.circle.center, state.circle.radius_m / 1000, { steps: 64, units: 'kilometers' });
  }
  return state.flightLayer && state.flightLayer.toGeoJSON ? state.flightLayer.toGeoJSON() : null;
}

function analyzeFlight() {
  if (!state.flightLayer) return;
  const flight = flightGeoJSON();
  if (!flight) return;
  const ring = flight.geometry.coordinates[0] || [];
  const flightBbox = turf.bbox(flight);

  // Find overlapping restricted zones.
  const overlaps = [];
  zones.forEach((r, id) => {
    if (!bboxOverlap(flightBbox, r.bbox)) return;
    try {
      if (!turf.booleanIntersects(flight, r.feature)) return;
    } catch {
      return;
    }
    let overlapArea = null;
    try {
      const inter = turf.intersect(turf.featureCollection([flight, r.feature]));
      if (inter) overlapArea = turf.area(inter);
    } catch {
      /* intersection can fail on degenerate geometry; area is optional */
    }
    overlaps.push({ id, feature: r.feature, overlapArea });
  });

  // Update overlap highlight state.
  clearOverlaps();
  overlaps.forEach((o) => state.overlapIds.add(o.id));
  overlaps.forEach((o) => restyleZone(o.id));

  // Stats.
  const area = turf.area(flight);
  els.statArea.textContent = formatArea(area);
  els.statOverlaps.textContent = overlaps.length;
  if (state.flightShape === 'circle') {
    els.statVertices.textContent = '⭕ circle';
    renderCircleCoords();
  } else {
    els.statVertices.textContent = Math.max(ring.length - 1, 0);
    renderCoords(ring);
  }
  renderOverlaps(overlaps);

  // Stash current analysis for export.
  state.lastFlight = flight;
  state.lastOverlaps = overlaps;
}

function renderCoords(ring) {
  const pts = ring.slice(0, ring.length > 1 && sameCoord(ring[0], ring[ring.length - 1]) ? -1 : undefined);
  els.coordsList.innerHTML = pts
    .map(([lon, lat]) => `<li>${lat.toFixed(6)}, ${lon.toFixed(6)}</li>`)
    .join('');
  state.lastCoords = pts.map(([lon, lat]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`).join('\n');
}

// For a circle, show the center + radius instead of a vertex list.
function renderCircleCoords() {
  const [lng, lat] = state.circle.center;
  const unit = els.circleRadiusUnit.value;
  const r = state.circle.radius_m / RADIUS_UNIT_M[unit];
  const rTxt = unit === 'm' ? Math.round(r) : Math.round(r * 1000) / 1000;
  els.coordsList.innerHTML =
    `<li>Center: ${lat.toFixed(6)}, ${lng.toFixed(6)}</li>` +
    `<li>Radius: ${rTxt} ${unit} (${Math.round(state.circle.radius_m)} m)</li>`;
  state.lastCoords = `Center: ${lat.toFixed(6)}, ${lng.toFixed(6)}\nRadius: ${rTxt} ${unit}`;
}

function renderOverlaps(overlaps) {
  if (!overlaps.length) {
    els.overlapList.innerHTML =
      '<div class="overlap-empty">✓ No overlap with restricted zones detected. Always re-verify against official sources before flying.</div>';
    return;
  }
  const sorted = [...overlaps].sort(
    (a, b) => (b.overlapArea || 0) - (a.overlapArea || 0)
  );
  els.overlapList.innerHTML = sorted
    .map((o) => {
      const p = o.feature.properties || {};
      const areaTxt = o.overlapArea != null ? `<span class="zi-alt">${formatArea(o.overlapArea)}</span>` : '';
      const isNotam = p.category === 'notam';
      const statusTxt = isNotam
        ? `NOTAM${p.notam_tip ? ' · ' + escapeHtml(NOTAM_TIP[p.notam_tip] || p.notam_tip) : ''}${p.notam_state === 'active' ? ' (ACTIVE)' : ' (upcoming)'}`
        : escapeHtml(p.status || '?');
      const validityRow = isNotam
        ? `<div class="oc-row"><strong>Valid:</strong> ${escapeHtml(formatNotamValidity(p.notam_from, p.notam_to))}</div>`
        : '';
      return `<div class="overlap-card${isNotam ? ' oc-notam' : ''}" data-id="${escapeHtml(o.id)}">
        <div class="oc-title"><span>${escapeHtml(p.zone_id || '—')}</span>${areaTxt}</div>
        <div class="oc-row"><strong>Altitude:</strong> ${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}</div>
        <div class="oc-row"><strong>Status:</strong> ${statusTxt}</div>
        ${validityRow}
        <div class="oc-contact">${escapeHtml(p.contact || '')}</div>
      </div>`;
    })
    .join('');
}

els.overlapList.addEventListener('click', (e) => {
  const card = e.target.closest('.overlap-card');
  if (card) selectZone(card.dataset.id, { pan: true });
});

// =================================================================== //
//  Export & copy
// =================================================================== //
els.exportBtn.addEventListener('click', () => {
  if (!state.lastFlight) return;
  const kml = buildKml(state.lastFlight.geometry, state.lastOverlaps || []);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadKml(kml, `flying-zone-${stamp}.kml`);
});

els.copyCoordsBtn.addEventListener('click', async () => {
  if (!state.lastCoords) return;
  try {
    await navigator.clipboard.writeText(state.lastCoords);
    els.copyCoordsBtn.textContent = 'Copied!';
    setTimeout(() => (els.copyCoordsBtn.textContent = 'Copy'), 1200);
  } catch {
    els.copyCoordsBtn.textContent = 'Copy failed';
    setTimeout(() => (els.copyCoordsBtn.textContent = 'Copy'), 1200);
  }
});

els.refresh.addEventListener('click', () => loadZones({ refresh: true }));

// =================================================================== //
//  Helpers
// =================================================================== //
function popupHtml(feature) {
  const p = feature.properties || {};
  if (p.category === 'notam') {
    const type = NOTAM_TIP[p.notam_tip] || p.notam_tip || '';
    return `<div>
      <b>NOTAM ${escapeHtml(p.zone_id || '')}</b>${type ? ' · ' + escapeHtml(type) : ''}
      ${p.notam_state === 'active' ? ' <b style="color:#b45309">ACTIVE</b>' : ''}<br>
      <b>Valid:</b> ${escapeHtml(formatNotamValidity(p.notam_from, p.notam_to))}<br>
      <b>Altitude:</b> ${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}<br>
      ${p.contact ? escapeHtml(p.contact) : ''}
    </div>`;
  }
  return `<div>
    <b>${escapeHtml(p.zone_id || 'Restricted zone')}</b><br>
    <b>Altitude:</b> ${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}<br>
    <b>Status:</b> ${escapeHtml(p.status || '?')}<br>
    <b>Contact:</b> ${escapeHtml(p.contact || '—')}
  </div>`;
}

// Combined popup listing every restriction stacked at a clicked point.
function pointPopupHtml(ids, latlng) {
  const head =
    `<div class="pt-pop-head"><b>${ids.length} restriction${ids.length > 1 ? 's' : ''} here</b>` +
    `<span class="pt-pop-coord">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</span></div>`;
  return `<div class="pt-pop">${head}<div class="pt-pop-list">${ids.map(pointRowHtml).join('')}</div></div>`;
}

function pointRowHtml(id) {
  const r = zones.get(id);
  const p = (r && r.feature.properties) || {};
  let tag = '';
  if (r && r.isNotam) {
    const t = NOTAM_TIP[p.notam_tip] || p.notam_tip || '';
    tag = `<span class="notam-pill">NOTAM${t ? ' · ' + escapeHtml(t) : ''}</span>` +
      (p.notam_state === 'active' ? ' <span class="notam-active">ACTIVE</span>' : '');
  } else if (r && r.isPermanent) {
    tag = `<span class="perm-pill">${p.kind === 'prohibited' ? 'PROHIBITED' : 'RESTRICTED'}</span>`;
  } else if (r && r.isCtr) {
    tag = '<span class="ctr-pill">CTR</span>';
  } else if (r && r.isNew) {
    tag = '<span class="new-pill">NEW</span>';
  }
  const validity = r && r.isNotam
    ? `<div class="pt-row-sub">🕑 ${escapeHtml(formatNotamValidity(p.notam_from, p.notam_to))}</div>`
    : '';
  return `<div class="pt-row">
      <div class="pt-row-top"><span>${escapeHtml(p.zone_id || '—')} ${tag}</span>
        <span class="zi-alt">${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}</span></div>
      ${validity}
    </div>`;
}

function formatArea(m2) {
  if (m2 == null || !isFinite(m2)) return '—';
  if (m2 < 1_000_000) return `${Math.round(m2).toLocaleString()} m²`;
  return `${(m2 / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`;
}

function sameCoord(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(kind, text) {
  const cls = { loading: 'badge-loading', live: 'badge-live', cache: 'badge-cache', snapshot: 'badge-snapshot', error: 'badge-error' };
  els.status.className = `badge ${cls[kind] || 'badge-loading'}`;
  els.status.textContent = text;
}

// The pill reports data freshness/source, NOT a count (the list carries counts).
function applyStatusMeta(meta) {
  if (!meta) return setStatus('live', '● Live');
  const rel = meta.fetchedAt ? relTime(meta.fetchedAt) : null;
  const title = meta.fetchedAt ? `Fetched from ROMATSA ${new Date(meta.fetchedAt).toLocaleString()}` : '';
  els.status.title = title;
  switch (meta.source) {
    case 'live':
    case 'live-cache':
      return setStatus('live', `● Live${rel ? ' · updated ' + rel : ''}`);
    case 'stale-cache':
      return setStatus('cache', `● Cached${rel ? ' · ' + rel : ''}`);
    case 'snapshot':
      return setStatus('snapshot', '⚠ Offline snapshot');
    default:
      return setStatus('live', '● Live');
  }
}

// Compact relative time: "just now", "3 min ago", "2 h ago", "1 d ago".
function relTime(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// Header dataset provenance: "Valid from <date>" + the "New (N)" filter chip.
function renderDatasetInfo(meta) {
  const ds = (meta && meta.dataset) || {};
  const fetched = meta && meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString() : null;
  if (ds.validFrom) {
    els.validFrom.textContent = `📅 Valid from ${ds.validFrom}`;
    els.validFrom.title = fetched
      ? `ROMATSA dataset effective ${ds.validFrom} · fetched ${fetched}`
      : `ROMATSA dataset effective ${ds.validFrom}`;
    els.validFrom.classList.remove('hidden');
  } else {
    els.validFrom.classList.add('hidden');
  }

  const n = state.newZones.size;
  if (n > 0) {
    els.newChip.textContent = `✨ New (${n})`;
    els.newChip.classList.remove('hidden');
  } else {
    els.newChip.classList.add('hidden');
    state.newOnly = false;
    els.newChip.classList.remove('active');
  }
}

// Compact snapshot of the current drawing for saving to history.
function currentFlightForSave() {
  if (!state.lastFlight) return null;
  const overlaps = (state.lastOverlaps || []).map((o) => {
    const p = o.feature.properties || {};
    return {
      zone_id: p.zone_id,
      lower_lim: p.lower_lim,
      upper_lim: p.upper_lim,
      status: p.status,
      contact: p.contact,
      overlap_area_m2: o.overlapArea != null ? Math.round(o.overlapArea) : null,
    };
  });
  return {
    geometry: state.lastFlight.geometry,
    overlap_zones: overlaps,
    area_m2: turf.area(state.lastFlight),
    dataset_valid_from: state.datasetValidFrom || null,
    suggestedName: `Flying zone (${overlaps.length} overlap${overlaps.length === 1 ? '' : 's'})`,
  };
}

// ---- Left-panel mode switch: Flying zone ↔ Volume Planner ----
initVolumePlanner({ container: $('mode-volume-body'), billing, bridge: vpBridge });
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('mode-flight-body').classList.toggle('hidden', mode !== 'flight');
    $('mode-volume-body').classList.toggle('hidden', mode !== 'volume');
  });
});

// ---- go ----
loadZones();
auth.init().then(() => {
  history.init({
    getFlight: currentFlightForSave,
    loadFlight: (geometry) => loadSavedFlight(geometry),
  });
  billing.init();
  library.init();
  request.init({
    getFlight: () => state.lastFlight
      ? {
          geometry: state.lastFlight.geometry,
          circle: state.flightShape === 'circle' && state.circle ? { ...state.circle } : null,
          overlaps: (state.lastOverlaps || []).map((o) => ({
            zone_id: o.feature.properties.zone_id,
            contact: o.feature.properties.contact,
          })),
        }
      : null,
  });
  // Reveal the save/request buttons if the user signs in while a zone is drawn.
  auth.onChange(() => {
    if (state.flightLayer && auth.configured) {
      els.saveBtn.classList.remove('hidden');
      els.requestBtn.classList.remove('hidden');
    }
  });
});
