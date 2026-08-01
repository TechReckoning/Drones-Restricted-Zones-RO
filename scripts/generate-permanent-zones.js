'use strict';
// Generates public/data/permanent_zones.json — the national permanent prohibited
// (LRP) and restricted (LRR) airspace zones, which are NOT part of the ROMATSA UAV
// feed. Edit the Z array below (coordinates in AIP DMS format) and re-run:
//   npm i @turf/turf   # one-off dev dependency, only needed to regenerate
//   node scripts/generate-permanent-zones.js
const fs = require('fs');
const turf = require('@turf/turf');
const OUT = require('path').join(__dirname, '..', 'public', 'data', 'permanent_zones.json');

// DMS parsers: lat "DDMMSS[NS]", long "DDDMMSS[EW]" -> decimal degrees
function lat(s) { const m = s.match(/^(\d{2})(\d{2})(\d{2})([NS])$/); const v = +m[1] + m[2] / 60 + m[3] / 3600; return m[4] === 'S' ? -v : v; }
function lng(s) { const m = s.match(/^(\d{3})(\d{2})(\d{2})([EW])$/); const v = +m[1] + m[2] / 60 + m[3] / 3600; return m[4] === 'W' ? -v : v; }
const pt = ([la, lo]) => [lng(lo), lat(la)]; // [lng, lat] for GeoJSON
const nmKm = (nm) => nm * 1.852;

function circleGeom(centerLatLng, radiusKm) {
  return turf.circle(pt(centerLatLng), radiusKm, { steps: 64, units: 'kilometers' }).geometry;
}
function polyGeom(points) {
  const ring = points.map(pt);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}
// LRR6: from p1, clockwise arc (radius, centred at c) to p2, then straight back to p1.
function arcGeom(p1LatLng, cLatLng, radiusKm, p2LatLng) {
  const c = pt(cLatLng), p1 = pt(p1LatLng), p2 = pt(p2LatLng);
  const norm = (a) => ((a % 360) + 360) % 360;
  const a1 = norm(turf.bearing(c, p1));
  let a2 = norm(turf.bearing(c, p2));
  if (a2 <= a1) a2 += 360; // clockwise = increasing bearing
  const ring = [];
  for (let a = a1; a <= a2 + 1e-6; a += 2) {
    const b = ((a % 360) + 540) % 360 - 180; // -> [-180,180]
    ring.push(turf.destination(c, radiusKm, b, { units: 'kilometers' }).geometry.coordinates);
  }
  ring.push(ring[0]); // close (chord back to start)
  return { type: 'Polygon', coordinates: [ring] };
}

const Z = [
  // --- Prohibited (LRP) ---
  { id: 'LRP2 CERNAVODĂ', kind: 'prohibited', geom: () => circleGeom(['441920N', '0280324E'], nmKm(1)), lower: 'GND', upper: '4000 FT QNH', note: 'Nuclear Energy Plant. H24.' },
  { id: 'LRP4', kind: 'prohibited', geom: () => circleGeom(['434424N', '0234644E'], 5), lower: 'GND', upper: 'FL85', note: 'Except where inside SOFIA FIR. H24.' },
  // --- Restricted (LRR) ---
  { id: 'LRR1 PITEŞTI/Geamăna', kind: 'restricted', geom: () => circleGeom(['445100N', '0245300E'], nmKm(11)), lower: 'GND', upper: 'FL660', note: '(A) FL660–GND: supersonic flights prohibited. (B) FL60–GND: subsonic flights prohibited below 2000 m STD (FL60), except aircraft with MTOW below 5.7 t. H24.' },
  { id: 'LRR3', kind: 'restricted', geom: () => polyGeom([['443025N', '0261400E'], ['442720N', '0255830E'], ['442100N', '0260400E'], ['442100N', '0261400E']]), lower: 'GND', upper: 'FL105', note: 'Penetration permission required (Government Decision HG no. 859/2021). H24.' },
  { id: 'LRR4', kind: 'restricted', geom: () => circleGeom(['442000N', '0280200E'], nmKm(5)), lower: 'GND', upper: '4000 FT QNH', note: 'Nuclear Energy Plant (except LRP2 airspace). Except Romanian state aircraft performing SAR, medical evacuation, real-world air policing, radiological survey, emergency intervention for real/drill nuclear or radiological alerts. H24.' },
  { id: 'LRR5', kind: 'restricted', geom: () => polyGeom([['453500N', '0251235E'], ['453500N', '0251630E'], ['453100N', '0252240E'], ['452910N', '0251900E'], ['453000N', '0251600E'], ['452400N', '0251300E'], ['452255N', '0251455E'], ['452142N', '0251310E'], ['452310N', '0251035E'], ['452410N', '0251200E'], ['452800N', '0250840E'], ['453025N', '0250840E']]), lower: 'GND', upper: '600 M AGL', note: 'Except state aircraft. H24.' },
  { id: 'LRR6', kind: 'restricted', geom: () => arcGeom(['440922N', '0260215E'], ['440708N', '0260503E'], nmKm(3), ['440454N', '0260215E']), lower: 'GND', upper: '2000 FT AMSL', note: 'H24.' },
  { id: 'LRR7 BERCENI', kind: 'restricted', geom: () => polyGeom([['442100N', '0260400E'], ['442100N', '0261400E'], ['441840N', '0261400E'], ['441840N', '0261100E']]), lower: 'GND', upper: '2000 FT AMSL', note: 'For VFR flights except Romanian state aircraft performing SAR, real-world air policing, medical evacuation. H24.' },
  { id: 'LRR8 BALTENI', kind: 'restricted', geom: () => circleGeom(['444327N', '0260309E'], nmKm(1)), lower: 'GND', upper: '2400 FT AMSL', note: 'For VFR flights except Romanian state aircraft performing SAR, real-world air policing, medical evacuation. H24.' },
  { id: 'LRR9 NEPTUN', kind: 'restricted', geom: () => circleGeom(['435219N', '0283614E'], nmKm(1)), lower: 'GND', upper: '2100 FT AMSL', note: 'For VFR flights except Romanian state aircraft performing SAR, real-world air policing, medical evacuation. H24.' },
  { id: 'LRR50', kind: 'restricted', geom: () => circleGeom(['434424N', '0234644E'], nmKm(13.5)), lower: 'GND', upper: 'FL165', note: 'Except where inside SOFIA FIR. Except SAR, real-world air policing, medical evacuation, cartographic aerial photo aircraft and aircraft with MTOW below 5.7 t. Risk of interception in the event of penetration. H24.' },
  { id: 'LRR206', kind: 'restricted', geom: () => circleGeom(['443846N', '0253632E'], nmKm(2)), lower: 'GND', upper: '2000 FT AMSL', note: 'Except SAR, real-world air policing and medical evacuation aircraft. Risk of interception in the event of penetration. H24.' },
  { id: 'LRR501', kind: 'restricted', geom: () => circleGeom(['440436N', '0242506E'], nmKm(2.16)), lower: 'GND', upper: 'FL165', note: 'Except Romanian state aircraft performing SAR, real-world air policing, medical evacuation, cartographic aerial photo. Potential hazard to aircraft operations. Risk of interception in the event of penetration. H24.' },
  { id: 'LRR502', kind: 'restricted', geom: () => circleGeom(['440436N', '0242506E'], nmKm(4.86)), lower: 'FL165', upper: 'FL410', note: 'Except Romanian state aircraft performing SAR, real-world air policing, medical evacuation, cartographic aerial photo. Potential hazard to aircraft operations. Risk of interception in the event of penetration. H24.' },
  { id: 'LRR503', kind: 'restricted', geom: () => circleGeom(['440436N', '0242506E'], nmKm(9.18)), lower: 'FL410', upper: 'FL660', note: 'Except Romanian state aircraft performing SAR, real-world air policing, medical evacuation, cartographic aerial photo. Potential hazard to aircraft operations. Risk of interception in the event of penetration. H24.' },
];

const features = Z.map((z, i) => ({
  type: 'Feature',
  id: 'permanent.' + i,
  properties: {
    zone_id: z.id,
    lower_lim: z.lower,
    upper_lim: z.upper,
    contact: z.note,
    status: z.kind === 'prohibited' ? 'PROHIBITED' : 'RESTRICTED',
    category: 'permanent',
    kind: z.kind,
  },
  geometry: z.geom(),
}));

fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
console.log('Wrote', features.length, 'permanent zones');
// spot-check a few centres (compute centroid of each polygon)
for (const id of ['LRP2 CERNAVODĂ', 'LRR1 PITEŞTI/Geamăna', 'LRR6', 'LRR503']) {
  const f = features.find((x) => x.properties.zone_id === id);
  const c = turf.centroid(f).geometry.coordinates;
  console.log('  ', id, '-> centroid lat/lng', c[1].toFixed(4), c[0].toFixed(4), '| verts', f.geometry.coordinates[0].length);
}
