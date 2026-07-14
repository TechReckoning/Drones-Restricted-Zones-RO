import { buildKml, downloadKml } from './kml.js';
import { auth } from './auth.js';
import { history } from './history.js';
import { billing } from './billing.js';
import { library } from './library.js';
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
};

// zone key -> { feature, layer, item, bbox, searchText }
const zones = new Map();
const state = {
  selectedId: null,
  overlapIds: new Set(),
  flightLayer: null,
  newZones: new Set(), // zone_ids added in the current dataset version
  newOnly: false,      // "New (N)" chip filter active
};

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
  editBtn: $('edit-btn'),
  clearBtn: $('clear-btn'),
  drawHint: $('draw-hint'),
  summary: $('flight-summary'),
  statArea: $('stat-area'),
  statVertices: $('stat-vertices'),
  statOverlaps: $('stat-overlaps'),
  exportBtn: $('export-kml-btn'),
  saveBtn: $('save-flight-btn'),
  coordsList: $('coords-list'),
  copyCoordsBtn: $('copy-coords-btn'),
  overlapList: $('overlap-list'),
};

// ---- Map ----
const map = L.map('map', { zoomControl: true }).setView([45.9432, 24.9668], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const zonesGroup = L.geoJSON(null, {
  style: STYLE.base,
  onEachFeature: (feature, layer) => registerZone(feature, layer),
}).addTo(map);

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
    state.selectedId = null;
    state.overlapIds.clear();
    // Must be set BEFORE addData so registerZone/styleFor can flag new zones.
    state.newZones = new Set((meta && meta.dataset && meta.dataset.newZones) || []);
    state.datasetValidFrom = (meta && meta.dataset && meta.dataset.validFrom) || null;
    zonesGroup.addData(geojson);

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

function registerZone(feature, layer) {
  const key = feature.id || feature.properties.zone_id;
  const p = feature.properties || {};
  const record = {
    feature,
    layer,
    item: null,
    isNew: state.newZones.has(p.zone_id),
    bbox: turf.bbox(feature), // [minX, minY, maxX, maxY]
    searchText: `${p.zone_id || ''} ${p.contact || ''} ${p.lower_lim || ''} ${p.upper_lim || ''}`.toLowerCase(),
  };
  zones.set(key, record);

  layer.setStyle(styleFor(key)); // paints new zones with the "new" style up front
  layer.bindPopup(popupHtml(feature), { maxWidth: 280 });
  layer.on('click', () => selectZone(key, { pan: false }));
}

// =================================================================== //
//  Restricted-zone list (right panel)
// =================================================================== //
function renderZoneList() {
  const sorted = [...zones.entries()].sort((a, b) =>
    (a[1].feature.properties.zone_id || '').localeCompare(
      b[1].feature.properties.zone_id || '',
      undefined,
      { numeric: true }
    )
  );

  const html = sorted
    .map(([key, r]) => {
      const p = r.feature.properties || {};
      const newPill = r.isNew
        ? ` <span class="new-pill" title="Added ${escapeHtml(state.datasetValidFrom || '')}">NEW</span>`
        : '';
      return `<div class="zone-item${r.isNew ? ' is-new' : ''}" data-id="${escapeHtml(key)}" role="option">
        <div class="zi-title"><span>${escapeHtml(p.zone_id || '—')}${newPill}</span>
          <span class="zi-alt">${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}</span></div>
        <div class="zi-contact">${escapeHtml(p.contact || '')}</div>
      </div>`;
    })
    .join('');
  els.zoneList.innerHTML = html || '<div class="zone-list-empty">No zones.</div>';

  // Cache element refs back onto the records.
  els.zoneList.querySelectorAll('.zone-item').forEach((el) => {
    const rec = zones.get(el.dataset.id);
    if (rec) rec.item = el;
  });
}

// Event delegation for list clicks.
els.zoneList.addEventListener('click', (e) => {
  const item = e.target.closest('.zone-item');
  if (item) selectZone(item.dataset.id, { pan: true });
});

// Search / filter (text search + "New only" chip combine).
function applyZoneFilter() {
  const q = els.search.value.trim().toLowerCase();
  let visible = 0;
  zones.forEach((r) => {
    if (!r.item) return;
    const show = (!q || r.searchText.includes(q)) && (!state.newOnly || r.isNew);
    r.item.classList.toggle('hidden', !show);
    if (show) visible++;
  });
  const filtered = q || state.newOnly;
  els.zoneCount.textContent = filtered ? `${visible}/${zones.size}` : String(zones.size);
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
  if (id === state.selectedId) return STYLE.selected;
  if (state.overlapIds.has(id)) return STYLE.overlap;
  const r = zones.get(id);
  if (r && r.isNew) return STYLE.isNew;
  return STYLE.base;
}

function restyleZone(id) {
  const r = zones.get(id);
  if (!r) return;
  r.layer.setStyle(styleFor(id));
  if (r.item) {
    r.item.classList.toggle('selected', id === state.selectedId);
    r.item.classList.toggle('overlap', state.overlapIds.has(id) && id !== state.selectedId);
  }
}

function selectZone(id, { pan = false } = {}) {
  const prev = state.selectedId;
  if (prev === id) {
    // Re-center on repeat clicks from the list, otherwise no-op.
    if (pan) panToZone(id);
    return;
  }
  state.selectedId = id;
  if (prev) restyleZone(prev);
  restyleZone(id);

  const r = zones.get(id);
  if (r) {
    r.layer.bringToFront();
    if (r.item) r.item.scrollIntoView({ block: 'nearest' });
    if (pan) panToZone(id);
    else r.layer.openPopup();
  }
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

map.pm.setGlobalOptions({ pathOptions: STYLE.flight });

map.on('pm:create', (e) => {
  if (e.shape !== 'Polygon') return;
  attachFlightLayer(e.layer);
});

// Shared setup for a flying-zone layer, whether freshly drawn or reloaded from
// saved history.
function attachFlightLayer(layer, { fit = false } = {}) {
  if (state.flightLayer) map.removeLayer(state.flightLayer);
  state.flightLayer = layer;
  layer.setStyle(STYLE.flight);
  layer.on('pm:edit', analyzeFlight);
  layer.on('pm:markerdragend', analyzeFlight);
  els.editBtn.disabled = false;
  els.clearBtn.disabled = false;
  els.summary.classList.remove('hidden');
  if (auth.configured) els.saveBtn.classList.remove('hidden');
  analyzeFlight();
  if (fit) map.fitBounds(layer.getBounds(), { padding: [50, 50] });
}

// Reload a saved GeoJSON Polygon back onto the map as the active flying zone.
function loadSavedFlight(geometry) {
  const ring = (geometry && geometry.coordinates && geometry.coordinates[0]) || [];
  const latlngs = ring.map(([lng, lat]) => [lat, lng]);
  if (latlngs.length < 3) return;
  const layer = L.polygon(latlngs).addTo(map);
  attachFlightLayer(layer, { fit: true });
}

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
  clearOverlaps();
  els.summary.classList.add('hidden');
  els.saveBtn.classList.add('hidden');
  els.editBtn.disabled = true;
  els.clearBtn.disabled = true;
  els.editBtn.textContent = 'Edit';
  els.drawHint.textContent = 'Click Draw flying zone, then click on the map to place the corners of your planned flight area.';
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

function analyzeFlight() {
  if (!state.flightLayer) return;
  const flight = state.flightLayer.toGeoJSON(); // Feature<Polygon>
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
  els.statVertices.textContent = Math.max(ring.length - 1, 0);
  els.statOverlaps.textContent = overlaps.length;

  renderCoords(ring);
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
      return `<div class="overlap-card" data-id="${escapeHtml(o.id)}">
        <div class="oc-title"><span>${escapeHtml(p.zone_id || '—')}</span>${areaTxt}</div>
        <div class="oc-row"><strong>Altitude:</strong> ${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}</div>
        <div class="oc-row"><strong>Status:</strong> ${escapeHtml(p.status || '?')}</div>
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
  return `<div>
    <b>${escapeHtml(p.zone_id || 'Restricted zone')}</b><br>
    <b>Altitude:</b> ${escapeHtml(p.lower_lim || '?')} – ${escapeHtml(p.upper_lim || '?')}<br>
    <b>Status:</b> ${escapeHtml(p.status || '?')}<br>
    <b>Contact:</b> ${escapeHtml(p.contact || '—')}
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

function applyStatusMeta(meta) {
  if (!meta) return setStatus('live', 'Zones loaded');
  const when = meta.fetchedAt ? new Date(meta.fetchedAt).toLocaleString() : 'bundled snapshot';
  switch (meta.source) {
    case 'live':
      return setStatus('live', `● Live · ${meta.count} zones`);
    case 'live-cache':
      return setStatus('cache', `● Cached · ${meta.count} zones`);
    case 'stale-cache':
    case 'snapshot':
      return setStatus('snapshot', `⚠ Offline snapshot · ${meta.count} zones`);
    default:
      return setStatus('live', `${meta.count} zones · ${when}`);
  }
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

// ---- go ----
loadZones();
auth.init().then(() => {
  history.init({
    getFlight: currentFlightForSave,
    loadFlight: (geometry) => loadSavedFlight(geometry),
  });
  billing.init();
  library.init();
  // Reveal the save button if the user signs in while a zone is already drawn.
  auth.onChange(() => {
    if (state.flightLayer && auth.configured) els.saveBtn.classList.remove('hidden');
  });
});
