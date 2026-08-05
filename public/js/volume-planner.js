// Volume Planner UI — the left-panel "📐 Volume Planner" mode. Renders the
// parameter form, gates the whole panel behind Pro (visible but inert for free
// users; any interaction opens the sign-in / subscribe pop-up), and computes the
// SORA operational volume via the validated calc engine.
//
// Phase 1 (this file): parameters → compute → transparent numeric breakdown.
// Map drawing (FG→CV→GRB buffers) + overlap analysis wire in next.

import { computeVolume, r1 } from './volume-planner-calc.js';
import { buildVolumeKml, downloadKml } from './kml.js';
import { libraryData } from './library.js';
import { auth, toast } from './auth.js';

const MANEUVERS = {
  multirotor: {
    horizontal: [['stopMultirotor', 'Stop / decelerate to hover'], ['parachute', 'Parachute (terminate)']],
    vertical:   [['multirotor', 'Climb (kinetic → potential)'], ['parachute', 'Parachute (terminate)']],
    grb:        [['oneToOne', '1:1 rule'], ['ballistic', 'Ballistic'], ['parachute', 'Parachute']],
  },
  fixedwing: {
    horizontal: [['turnFixedwing', '180° turn'], ['parachute', 'Parachute (terminate)']],
    vertical:   [['fixedwing', 'Climb + level turn'], ['parachute', 'Parachute (terminate)']],
    grb:        [['fixedwingGlide', 'Glide (power off)'], ['fixedwingNoGlide', 'No glide (1:1)'], ['oneToOne', '1:1 rule'], ['parachute', 'Parachute']],
  },
};

const FORM_HTML = `
  <div class="vp">
    <div class="vp-lockbadge">🔒 Pro feature — sign in to use</div>
    <p class="hint">Compute the SORA operational volume (Flight Geography → Contingency
      Volume → Ground Risk Buffer) per the LBA/EU 2019/947 method.</p>
    <div class="vp-shape">
      <button type="button" id="vp-save" class="btn btn-ghost btn-mini">💾 Save plan</button>
      <button type="button" id="vp-myplans" class="btn btn-ghost btn-mini">📂 My plans</button>
    </div>
    <div id="vp-plans-list" class="vp-plans-list hidden"></div>

    <div class="vp-group">Operational area</div>
    <div class="vp-seg" role="radiogroup" aria-label="Build method">
      <label><input type="radio" name="vp-variant" value="v1" checked /> <span>Flight geography<small>grow outward</small></span></label>
      <label><input type="radio" name="vp-variant" value="v2" /> <span>Controlled area<small>shrink inward</small></span></label>
    </div>
    <div class="vp-shape">
      <button type="button" id="vp-draw-poly" class="btn btn-ghost btn-mini">✏️ Polygon</button>
      <button type="button" id="vp-draw-circle" class="btn btn-ghost btn-mini">⭕ Circle</button>
      <button type="button" id="vp-draw-corridor" class="btn btn-ghost btn-mini">↔ Corridor</button>
      <button type="button" id="vp-clear" class="btn btn-ghost btn-mini">Clear</button>
    </div>
    <label class="vp-f vp-load"><span>Corridor width (m)</span><input id="vp-corridor-w" type="number" min="1" step="any" value="400" /></label>
    <p class="hint muted" id="vp-shape-status">No area drawn yet.</p>
    <div class="vp-shape">
      <button type="button" id="vp-set-pilot" class="btn btn-ghost btn-mini">📍 Pilot</button>
      <button type="button" id="vp-set-told" class="btn btn-ghost btn-mini">🛫 TO/LD</button>
    </div>

    <div class="vp-group">Aircraft & flight</div>
    <label class="vp-f vp-load"><span>Load from my drones</span><select id="vp-drone"><option value="">— manual entry —</option></select></label>
    <div class="vp-seg" role="radiogroup" aria-label="Aircraft type">
      <label><input type="radio" name="vp-aircraft" value="multirotor" checked /> <span>Multirotor</span></label>
      <label><input type="radio" name="vp-aircraft" value="fixedwing" /> <span>Fixed-wing</span></label>
    </div>
    <div class="vp-grid">
      <label class="vp-f"><span>Max speed V₀ (m/s)</span><input id="vp-v0" type="number" min="0" step="any" value="10" /></label>
      <label class="vp-f"><span>Char. dimension CD (m)</span><input id="vp-cd" type="number" min="0" step="any" value="1" /></label>
      <label class="vp-f"><span>Flight geo. height H_FG (m)</span><input id="vp-hfg" type="number" min="0" step="any" value="100" /></label>
      <label class="vp-f"><span>Height source</span><select id="vp-height"><option value="baro">Barometric (±1 m)</option><option value="gnss">GNSS (±4 m)</option></select></label>
    </div>

    <div class="vp-group">Maneuvers</div>
    <div class="vp-grid vp-grid-1">
      <label class="vp-f"><span>Horizontal contingency</span><select id="vp-hcm"></select></label>
      <label class="vp-f"><span>Vertical contingency</span><select id="vp-vcm"></select></label>
      <label class="vp-f"><span>Ground-risk termination</span><select id="vp-grb"></select></label>
    </div>

    <details class="vp-adv">
      <summary>Advanced assumptions</summary>
      <div class="vp-grid">
        <label class="vp-f"><span>Reaction time t (s)</span><input id="vp-treact" type="number" min="0" step="any" value="1" /></label>
        <label class="vp-f" data-when="multirotor"><span>Pitch angle Θ (°)</span><input id="vp-pitch" type="number" min="1" max="89" step="any" value="45" /></label>
        <label class="vp-f" data-when="fixedwing"><span>Roll angle Φ (°)</span><input id="vp-roll" type="number" min="1" max="89" step="any" value="30" /></label>
        <label class="vp-f" data-when="glide"><span>Glide ratio (E)</span><input id="vp-glide" type="number" min="1" step="any" value="10" /></label>
        <label class="vp-f" data-when="chute"><span>Parachute open time (s)</span><input id="vp-chute-t" type="number" min="0" step="any" value="3" /></label>
        <label class="vp-f" data-when="chute"><span>Descent rate V_z (m/s)</span><input id="vp-vz" type="number" min="0" step="any" value="5" /></label>
        <label class="vp-f" data-when="chute"><span>Max wind V_wind (m/s)</span><input id="vp-wind" type="number" min="0" step="any" value="8" /></label>
        <label class="vp-f"><span>GPS error S_GPS (m)</span><input id="vp-sgps" type="number" min="0" step="any" value="3" /></label>
        <label class="vp-f"><span>Position error S_Pos (m)</span><input id="vp-spos" type="number" min="0" step="any" value="3" /></label>
        <label class="vp-f"><span>Map error S_K (m)</span><input id="vp-sk" type="number" min="0" step="any" value="1" /></label>
        <label class="vp-f"><span>Ground visibility (m)</span><input id="vp-gv" type="number" min="0" max="5000" step="any" value="5000" /></label>
      </div>
    </details>

    <button id="vp-compute" class="btn btn-primary btn-block">Compute volume</button>
    <div id="vp-results" class="vp-results"></div>

    <p class="hint muted">Unofficial aid based on the LBA/EU 2019/947 method — always verify with AACR &amp; ROMATSA before flying.</p>
  </div>
`;

export function initVolumePlanner({ container, billing, bridge }) {
  container.innerHTML = FORM_HTML;
  const q = (sel) => container.querySelector(sel);
  const root = q('.vp');
  const num = (id, dflt) => { const v = parseFloat(q('#' + id)?.value); return isFinite(v) ? v : dflt; };
  const setShapeStatus = (has) => { q('#vp-shape-status').textContent = has ? '✓ Area drawn — press Compute.' : 'No area drawn yet.'; };

  // ---- Gate: visible but inert until entitled ----
  function updateGate() { root.classList.toggle('vp-locked', !billing.access); }
  container.addEventListener('pointerdown', (e) => {
    if (billing.access) return;
    e.preventDefault(); e.stopPropagation();
    billing.ensurePro(); // sign-in (anonymous) or subscribe (signed-in, no access)
  }, true);
  ['click', 'keydown'].forEach((type) =>
    container.addEventListener(type, (e) => { if (!billing.access) { e.preventDefault(); e.stopPropagation(); } }, true)
  );
  billing.onChange(updateGate);
  updateGate();

  // ---- Maneuver options depend on aircraft type ----
  const fillSelect = (sel, opts) => { sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); };
  function syncAircraft() {
    const type = q('input[name="vp-aircraft"]:checked').value;
    const m = MANEUVERS[type];
    fillSelect(q('#vp-hcm'), m.horizontal);
    fillSelect(q('#vp-vcm'), m.vertical);
    fillSelect(q('#vp-grb'), m.grb);
    syncConditional();
  }
  // Show only the advanced fields relevant to the current choices.
  function syncConditional() {
    const type = q('input[name="vp-aircraft"]:checked').value;
    const grb = q('#vp-grb').value;
    const anyChute = [q('#vp-hcm').value, q('#vp-vcm').value, grb].includes('parachute');
    container.querySelectorAll('[data-when]').forEach((elm) => {
      const w = elm.dataset.when;
      const show = w === type || (w === 'glide' && grb === 'fixedwingGlide') || (w === 'chute' && anyChute);
      elm.classList.toggle('hidden', !show);
    });
  }
  container.querySelectorAll('input[name="vp-aircraft"]').forEach((r) => r.addEventListener('change', syncAircraft));
  ['#vp-hcm', '#vp-vcm', '#vp-grb'].forEach((s) => q(s).addEventListener('change', syncConditional));
  syncAircraft();

  // ---- Auto-fill from a saved drone (library) ----
  const populateDrones = () => {
    const sel = q('#vp-drone'); if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = ['<option value="">— manual entry —</option>']
      .concat((libraryData.drones || []).map((d) => `<option value="${d.id}">${esc([d.manufacturer, d.model].filter(Boolean).join(' ') || d.registration || 'Drone')}</option>`))
      .join('');
    sel.value = cur;
  };
  const applyDrone = (d) => {
    if (!d) return;
    if (d.aircraft_type === 'multirotor' || d.aircraft_type === 'fixedwing') {
      const radio = q(`input[name="vp-aircraft"][value="${d.aircraft_type}"]`);
      if (radio) { radio.checked = true; syncAircraft(); }
    }
    const set = (id, v) => { if (v != null && v !== '') q('#' + id).value = v; };
    set('vp-v0', d.v0_ms); set('vp-cd', d.cd_m); set('vp-wind', d.v_wind_ms); set('vp-glide', d.glide_ratio);
  };
  q('#vp-drone').addEventListener('focus', populateDrones);
  q('#vp-drone').addEventListener('change', () => applyDrone((libraryData.drones || []).find((x) => x.id === q('#vp-drone').value)));
  populateDrones();

  // ---- All planner inputs → object (for compute + save) ----
  const collectInputs = () => ({
    aircraftType: q('input[name="vp-aircraft"]:checked').value,
    V0: num('vp-v0', 10), CD: num('vp-cd', 1), HFG: num('vp-hfg', 100),
    heightMethod: q('#vp-height').value,
    horizontalCM: q('#vp-hcm').value, verticalCM: q('#vp-vcm').value, grbMethod: q('#vp-grb').value,
    pitchAngle: num('vp-pitch', 45), rollAngle: num('vp-roll', 30), glideRatio: num('vp-glide', 10),
    parachuteOpenTime: num('vp-chute-t', 3), descentRate: num('vp-vz', 5), Vwind: num('vp-wind', 8),
    SGPS: num('vp-sgps', 3), SPos: num('vp-spos', 3), SK: num('vp-sk', 1),
    reactionTime: num('vp-treact', 1), groundVisibility: num('vp-gv', 5000),
    corridorWidth: num('vp-corridor-w', 400),
  });
  const applyInputs = (p) => {
    if (!p) return;
    const setV = (id, v) => { if (v != null) q('#' + id).value = v; };
    if (p.aircraftType) { const r = q(`input[name="vp-aircraft"][value="${p.aircraftType}"]`); if (r) r.checked = true; }
    syncAircraft(); // rebuild maneuver options for the aircraft type
    if (p.horizontalCM) q('#vp-hcm').value = p.horizontalCM;
    if (p.verticalCM) q('#vp-vcm').value = p.verticalCM;
    if (p.grbMethod) q('#vp-grb').value = p.grbMethod;
    if (p.heightMethod) q('#vp-height').value = p.heightMethod;
    setV('vp-v0', p.V0); setV('vp-cd', p.CD); setV('vp-hfg', p.HFG);
    setV('vp-pitch', p.pitchAngle); setV('vp-roll', p.rollAngle); setV('vp-glide', p.glideRatio);
    setV('vp-chute-t', p.parachuteOpenTime); setV('vp-vz', p.descentRate); setV('vp-wind', p.Vwind);
    setV('vp-sgps', p.SGPS); setV('vp-spos', p.SPos); setV('vp-sk', p.SK);
    setV('vp-treact', p.reactionTime); setV('vp-gv', p.groundVisibility); setV('vp-corridor-w', p.corridorWidth);
    syncConditional();
  };

  // ---- Save / reopen plans (owner-scoped, Pro) ----
  const plansApi = (path, opts = {}) => fetch('/api/plans' + path, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token, ...(opts.headers || {}) },
  });
  let plansCache = [];
  async function loadPlans() {
    const box = q('#vp-plans-list');
    try {
      const res = await plansApi('', {});
      if (!res.ok) { box.innerHTML = '<p class="hint muted">Could not load plans.</p>'; return; }
      plansCache = (await res.json()).items || [];
      box.innerHTML = plansCache.length
        ? plansCache.map((p) => `<div class="vp-plan-row" data-id="${esc(p.id)}"><span>${esc(p.name)}</span>
            <span class="vp-plan-acts"><button type="button" class="btn btn-mini" data-act="open">Open</button>
            <button type="button" class="btn btn-mini btn-danger" data-act="del">✕</button></span></div>`).join('')
        : '<p class="hint muted">No saved plans yet.</p>';
    } catch { box.innerHTML = '<p class="hint muted">Could not load plans.</p>'; }
  }
  q('#vp-save').addEventListener('click', async () => {
    if (!billing.access) return;
    if (!bridge || !bridge.hasFG()) { q('#vp-shape-status').textContent = 'Draw an area first, then save.'; return; }
    const name = (window.prompt('Plan name:', 'My plan') || '').trim();
    if (!name) return;
    const data = { variant: variant(), params: collectInputs(), ...bridge.getState() };
    const res = await plansApi('', { method: 'POST', body: JSON.stringify({ name, data }) });
    toast(res.ok ? `Saved "${name}".` : 'Save failed.');
    if (res.ok && !q('#vp-plans-list').classList.contains('hidden')) loadPlans();
  });
  q('#vp-myplans').addEventListener('click', () => {
    if (!billing.access) return;
    const box = q('#vp-plans-list');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) loadPlans();
  });
  q('#vp-plans-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.vp-plan-row'); if (!row) return;
    const id = row.dataset.id;
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (act === 'del') {
      if (!window.confirm('Delete this plan?')) return;
      await plansApi('/' + id, { method: 'DELETE' }); loadPlans();
    } else if (act === 'open') {
      const p = plansCache.find((x) => x.id === id); if (!p) return;
      const d = p.data || {};
      const vr = q(`input[name="vp-variant"][value="${d.variant || 'v1'}"]`); if (vr) vr.checked = true;
      applyInputs(d.params);
      if (bridge) bridge.loadState(d.geometry, d.variant || 'v1', d.pilot, d.told);
      setShapeStatus(Boolean(d.geometry));
      q('#vp-plans-list').classList.add('hidden');
      q('#vp-compute').click(); // redraw the volumes
    }
  });

  // ---- Draw the flight geography (via the map bridge) ----
  const variant = () => q('input[name="vp-variant"]:checked').value;
  const startDraw = (shape) => {
    if (!billing.access || !bridge) return;
    q('#vp-shape-status').textContent = shape === 'corridor'
      ? 'Click to add corridor points, double-click to finish…'
      : `Click on the map to draw the ${variant() === 'v2' ? 'controlled ground area' : 'flight geography'}…`;
    bridge.drawFG(shape, variant(), () => setShapeStatus(true), num('vp-corridor-w', 400));
  };
  q('#vp-draw-poly').addEventListener('click', () => startDraw('polygon'));
  q('#vp-draw-circle').addEventListener('click', () => startDraw('circle'));
  q('#vp-draw-corridor').addEventListener('click', () => startDraw('corridor'));
  q('#vp-clear').addEventListener('click', () => { bridge && bridge.clear(); setShapeStatus(false); q('#vp-results').innerHTML = ''; });
  // Switching build method invalidates the drawn shape (FG vs controlled area).
  container.querySelectorAll('input[name="vp-variant"]').forEach((r) =>
    r.addEventListener('change', () => { bridge && bridge.clear(); setShapeStatus(false); q('#vp-results').innerHTML = ''; })
  );
  const placeMk = (kind, msg) => {
    if (!billing.access || !bridge) return;
    q('#vp-shape-status').textContent = msg;
    bridge.placeMarker(kind, () => setShapeStatus(bridge.hasFG()));
  };
  q('#vp-set-pilot').addEventListener('click', () => placeMk('pilot', 'Click the map to place the pilot position…'));
  q('#vp-set-told').addEventListener('click', () => placeMk('told', 'Click the map to place take-off / landing…'));

  // ---- Compute → breakdown (+ draw volumes & overlap when an FG is drawn) ----
  q('#vp-compute').addEventListener('click', () => {
    if (!billing.access) return; // gate already blocks, belt-and-braces
    const res = computeVolume(collectInputs());
    const extra = (bridge && bridge.hasFG()) ? bridge.buildAndDraw(res.SCV, res.SGRB, variant(), res.inputs.CD) : null;
    renderResults(q('#vp-results'), res, extra);
    // Wire the export button (only present when volumes were drawn).
    const exp = q('#vp-export');
    if (exp && extra && !extra.collapsed) {
      exp.onclick = () => {
        const i = res.inputs;
        const kml = buildVolumeKml({
          fg: extra.fg, cv: extra.cv, grb: extra.grb, pilot: extra.pilot, told: extra.told,
          meta: {
            name: 'SORA operational volume — RO',
            description: `${i.aircraftType} · V₀=${i.V0} m/s · CD=${i.CD} m · H_FG=${i.HFG} m · `
              + `S_CV=${r1(res.SCV)} m · H_CV=${r1(res.HCV)} m · S_GRB=${r1(res.SGRB)} m`,
          },
        });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadKml(kml, `operational-volume-${stamp}.kml`);
      };
    }
    // Adjacent-volume toggle.
    const adjCb = q('#vp-adj');
    if (adjCb && extra && !extra.collapsed) {
      adjCb.addEventListener('change', () => {
        const info = q('#vp-adj-info');
        const r = bridge && bridge.toggleAdjacent(res.SAV, adjCb.checked);
        info.textContent = (adjCb.checked && r)
          ? `Adjacent volume ${(r.area / 1e6).toFixed(1)} km² · ${r.overlaps} restriction${r.overlaps === 1 ? '' : 's'} inside`
          : '';
      });
    }
  });
}

// Schematic (not-to-scale) side + top views, LBA-style, with the real dimensions
// labelled. Structure shows FG (green) ⊂ CV (yellow) ⊂ GRB (red).
function schematicHtml(res) {
  const G = 112;                 // ground line (side view)
  const hcvPx = 84;
  const hfgPx = Math.max(12, Math.min(hcvPx - 6, hcvPx * (res.inputs.HFG / res.HCV)));
  const topCV = G - hcvPx, topFG = G - hfgPx, ramp = 54;
  const side = `<svg viewBox="0 0 260 140" class="vp-svg" preserveAspectRatio="xMidYMid meet">
    <line x1="12" y1="${G}" x2="248" y2="${G}" class="vp-ground"/>
    <path d="M172 ${topCV} L${172 + ramp} ${G} L172 ${G} Z" fill="rgba(239,68,68,.18)" stroke="#dc2626"/>
    <path d="M88 ${topCV} L${88 - ramp} ${G} L88 ${G} Z" fill="rgba(239,68,68,.18)" stroke="#dc2626"/>
    <rect x="88" y="${topCV}" width="84" height="${hcvPx}" fill="rgba(245,158,11,.16)" stroke="#d97706"/>
    <rect x="106" y="${topFG}" width="48" height="${hfgPx}" fill="rgba(34,197,94,.24)" stroke="#16a34a"/>
    <text x="130" y="${topFG + hfgPx / 2 + 3}" class="vp-svg-t" text-anchor="middle">FG</text>
    <text x="130" y="${topCV - 4}" class="vp-svg-d" text-anchor="middle">H_CV ${r1(res.HCV)} m · H_FG ${r1(res.inputs.HFG)} m</text>
    <text x="${172 + ramp / 2}" y="${G + 11}" class="vp-svg-d" text-anchor="middle">S_GRB ${r1(res.SGRB)} m</text>
  </svg>`;
  const top = `<svg viewBox="0 0 260 140" class="vp-svg" preserveAspectRatio="xMidYMid meet">
    <rect x="14" y="12" width="232" height="116" fill="rgba(239,68,68,.14)" stroke="#dc2626"/>
    <rect x="44" y="34" width="172" height="72" fill="rgba(245,158,11,.16)" stroke="#d97706"/>
    <rect x="98" y="58" width="64" height="24" fill="rgba(34,197,94,.24)" stroke="#16a34a"/>
    <text x="130" y="73" class="vp-svg-t" text-anchor="middle">FG</text>
    <text x="130" y="26" class="vp-svg-d" text-anchor="middle">S_GRB ${r1(res.SGRB)} m</text>
    <text x="130" y="49" class="vp-svg-d" text-anchor="middle">S_CV ${r1(res.SCV)} m</text>
  </svg>`;
  return `<div class="vp-schem">
    <figure><figcaption>Side view</figcaption>${side}</figure>
    <figure><figcaption>Top view</figcaption>${top}</figure>
  </div>`;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtArea = (m2) => (m2 < 1e6 ? `${Math.round(m2).toLocaleString()} m²` : `${(m2 / 1e6).toFixed(2)} km²`);

function renderFootprint(extra, res) {
  if (!extra) {
    return `<p class="hint">Draw the operational area (above) then <b>Compute</b> to draw the
      volumes on the map and check them against live Romanian restrictions.</p>`;
  }
  if (extra.collapsed) {
    return `<div class="vp-foot">
      <div class="vp-warn">⚠ The controlled ground area is too small for these buffers
        (needs ≥ ${res ? r1(res.SCV + res.SGRB) : '?'} m of inward margin). Draw a larger area,
        or reduce speed / choose a tighter termination.</div>
      <div class="vp-areas"><span>GRB ${fmtArea(extra.areas.grb)}</span>${extra.areas.cv ? `<span>CV ${fmtArea(extra.areas.cv)}</span>` : ''}</div>
    </div>`;
  }
  const tooSmall = extra.fgTooSmall
    ? '<div class="vp-warn">⚠ Flight geography is below the 3·CD minimum realistic size.</div>' : '';
  let vlos = '';
  if (res && extra.pilotToCV != null) {
    const bvlos = extra.pilotToCV > res.vlosLimit;
    vlos = `<div class="vp-vlos ${bvlos ? 'vp-bvlos' : 'vp-isvlos'}">${bvlos ? '⚠ BVLOS required' : '✓ VLOS'}
      — pilot → CV edge ${r1(extra.pilotToCV)} m vs VLOS limit ${r1(res.vlosLimit)} m</div>`;
  } else if (res) {
    vlos = `<div class="hint muted">Place a 📍 Pilot marker to check VLOS/BVLOS (limit ${r1(res.vlosLimit)} m).</div>`;
  }
  const ov = extra.overlaps || [];
  const body = ov.length
    ? `<div class="vp-warn">⚠ ${ov.length} restriction${ov.length > 1 ? 's' : ''} intersect the operational footprint (GRB):</div>
       <ul class="vp-ovl">${ov.slice(0, 25).map((o) => `<li>${esc(o.feature.properties.zone_id || '—')} <span>${esc(o.feature.properties.status || o.feature.properties.category || '')}</span></li>`).join('')}</ul>
       ${ov.length > 25 ? `<div class="hint muted">…and ${ov.length - 25} more</div>` : ''}`
    : `<div class="vp-ok">✓ No Romanian restrictions intersect the operational footprint.</div>`;
  return `<div class="vp-foot">
    <div class="vp-areas"><span>FG ${fmtArea(extra.areas.fg)}</span><span>CV ${fmtArea(extra.areas.cv)}</span><span>GRB ${fmtArea(extra.areas.grb)}</span></div>
    ${tooSmall}
    ${vlos}
    ${body}
    <label class="vp-adj-toggle"><input type="checkbox" id="vp-adj" /> <span>Show adjacent volume${res ? ` (S_AV ${r1(res.SAV)} m)` : ''}</span></label>
    <div id="vp-adj-info" class="hint muted"></div>
    <button type="button" id="vp-export" class="btn btn-primary btn-block">⬇ Export KML (FG · CV · GRB${extra.pilot ? ' · Pilot' : ''})</button>
  </div>`;
}

function renderResults(box, res, extra) {
  const m = (x) => `${r1(x)} m`;
  const row = (label, value, sub) => `<tr><td>${label}${sub ? ` <span class="vp-sub">${sub}</span>` : ''}</td><td>${value}</td></tr>`;
  box.innerHTML = `
    <div class="vp-headline">
      <div class="vp-hcard"><small>Contingency · lateral</small><b>${m(res.SCV)}</b><span>S_CV</span></div>
      <div class="vp-hcard"><small>Contingency · height</small><b>${m(res.HCV)}</b><span>H_CV</span></div>
      <div class="vp-hcard vp-hcard-red"><small>Ground risk buffer</small><b>${m(res.SGRB)}</b><span>S_GRB</span></div>
    </div>
    ${schematicHtml(res)}
    <table class="vp-table">
      <tr class="vp-th"><td colspan="2">Lateral contingency (S_CV)</td></tr>
      ${row('GPS / position / map', m(res.inputs.SGPS + res.inputs.SPos + res.inputs.SK), 'S_GPS+S_Pos+S_K')}
      ${row('Reaction distance', m(res.SRZ), 'S_RZ')}
      ${row('Contingency maneuver', m(res.SCM), 'S_CM')}
      <tr class="vp-th"><td colspan="2">Vertical contingency (H_CV)</td></tr>
      ${row('Flight geography height', m(res.inputs.HFG), 'H_FG')}
      ${row('Altitude error', m(res.Hbaro), 'H_baro')}
      ${row('Reaction height', m(res.HRZ), 'H_RZ')}
      ${row('Contingency maneuver', m(res.HCM), 'H_CM')}
      <tr class="vp-th"><td colspan="2">Adjacent volume & VLOS</td></tr>
      ${row('Adjacent width', m(res.SAV), 'S_AV = 120·V₀')}
      ${row('Adjacent height', m(res.HAV), 'H_AV')}
      ${row('VLOS limit', m(res.vlosLimit), `min(ALOS ${r1(res.ALOS)}, DLOS ${r1(res.DLOS)})`)}
    </table>
    ${renderFootprint(extra, res)}
  `;
}
