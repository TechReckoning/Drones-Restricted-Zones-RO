// Volume Planner UI — the left-panel "📐 Volume Planner" mode. Renders the
// parameter form, gates the whole panel behind Pro (visible but inert for free
// users; any interaction opens the sign-in / subscribe pop-up), and computes the
// SORA operational volume via the validated calc engine.
//
// Phase 1 (this file): parameters → compute → transparent numeric breakdown.
// Map drawing (FG→CV→GRB buffers) + overlap analysis wire in next.

import { computeVolume, r1 } from './volume-planner-calc.js';

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

    <div class="vp-group">Flight geography</div>
    <div class="vp-shape">
      <button type="button" id="vp-draw-poly" class="btn btn-ghost btn-mini">✏️ Polygon</button>
      <button type="button" id="vp-draw-circle" class="btn btn-ghost btn-mini">⭕ Circle</button>
      <button type="button" id="vp-clear" class="btn btn-ghost btn-mini">Clear</button>
    </div>
    <p class="hint muted" id="vp-shape-status">No flight geography drawn yet.</p>

    <div class="vp-group">Aircraft & flight</div>
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
  const setShapeStatus = (has) => { q('#vp-shape-status').textContent = has ? '✓ Flight geography drawn — press Compute.' : 'No flight geography drawn yet.'; };

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

  // ---- Draw the flight geography (via the map bridge) ----
  const startDraw = (shape) => {
    if (!billing.access || !bridge) return;
    q('#vp-shape-status').textContent = 'Click on the map to draw the flight geography…';
    bridge.drawFG(shape, () => setShapeStatus(true));
  };
  q('#vp-draw-poly').addEventListener('click', () => startDraw('polygon'));
  q('#vp-draw-circle').addEventListener('click', () => startDraw('circle'));
  q('#vp-clear').addEventListener('click', () => { bridge && bridge.clear(); setShapeStatus(false); q('#vp-results').innerHTML = ''; });

  // ---- Compute → breakdown (+ draw volumes & overlap when an FG is drawn) ----
  q('#vp-compute').addEventListener('click', () => {
    if (!billing.access) return; // gate already blocks, belt-and-braces
    const res = computeVolume({
      aircraftType: q('input[name="vp-aircraft"]:checked').value,
      V0: num('vp-v0', 10), CD: num('vp-cd', 1), HFG: num('vp-hfg', 100),
      heightMethod: q('#vp-height').value,
      horizontalCM: q('#vp-hcm').value, verticalCM: q('#vp-vcm').value, grbMethod: q('#vp-grb').value,
      pitchAngle: num('vp-pitch', 45), rollAngle: num('vp-roll', 30),
      glideRatio: num('vp-glide', 10),
      parachuteOpenTime: num('vp-chute-t', 3), descentRate: num('vp-vz', 5), Vwind: num('vp-wind', 8),
      SGPS: num('vp-sgps', 3), SPos: num('vp-spos', 3), SK: num('vp-sk', 1),
      reactionTime: num('vp-treact', 1), groundVisibility: num('vp-gv', 5000),
    });
    const extra = (bridge && bridge.hasFG()) ? bridge.buildAndDraw(res.SCV, res.SGRB) : null;
    renderResults(q('#vp-results'), res, extra);
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtArea = (m2) => (m2 < 1e6 ? `${Math.round(m2).toLocaleString()} m²` : `${(m2 / 1e6).toFixed(2)} km²`);

function renderFootprint(extra) {
  if (!extra) {
    return `<p class="hint">Draw a flight geography (above) then <b>Compute</b> to draw the
      volumes on the map and check them against live Romanian restrictions.</p>`;
  }
  const ov = extra.overlaps || [];
  const body = ov.length
    ? `<div class="vp-warn">⚠ ${ov.length} restriction${ov.length > 1 ? 's' : ''} intersect the operational footprint (GRB):</div>
       <ul class="vp-ovl">${ov.slice(0, 25).map((o) => `<li>${esc(o.feature.properties.zone_id || '—')} <span>${esc(o.feature.properties.status || o.feature.properties.category || '')}</span></li>`).join('')}</ul>
       ${ov.length > 25 ? `<div class="hint muted">…and ${ov.length - 25} more</div>` : ''}`
    : `<div class="vp-ok">✓ No Romanian restrictions intersect the operational footprint.</div>`;
  return `<div class="vp-foot">
    <div class="vp-areas"><span>FG ${fmtArea(extra.areas.fg)}</span><span>CV ${fmtArea(extra.areas.cv)}</span><span>GRB ${fmtArea(extra.areas.grb)}</span></div>
    ${body}
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
    ${renderFootprint(extra)}
  `;
}
