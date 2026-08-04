// KML generation for the drawn flying zone (and, optionally, the restricted
// zones it overlaps). KML coordinates are "lon,lat,alt" tuples.

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Turn a GeoJSON Polygon ring array ([[lon,lat], ...]) into a KML coord string.
function ringToKml(ring) {
  return ring.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
}

function polygonPlacemark(name, geometry, styleUrl, description) {
  // geometry is a GeoJSON Polygon (coordinates[0] = outer ring, rest = holes).
  const rings = geometry.coordinates;
  const outer = ringToKml(rings[0]);
  const inner = rings
    .slice(1)
    .map((r) => `<innerBoundaryIs><LinearRing><coordinates>${ringToKml(r)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join('');
  return `    <Placemark>
      <name>${escapeXml(name)}</name>
      ${description ? `<description>${escapeXml(description)}</description>` : ''}
      <styleUrl>${styleUrl}</styleUrl>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs>
        ${inner}
      </Polygon>
    </Placemark>`;
}

/**
 * Build a KML document string.
 * @param {object} flightGeometry GeoJSON Polygon of the drawn flying zone.
 * @param {Array<{feature: object}>} overlaps Overlapping restricted zones (optional).
 */
export function buildKml(flightGeometry, overlaps = []) {
  const generatedAt = new Date().toISOString();

  const overlapPlacemarks = overlaps
    .map(({ feature }) => {
      const p = feature.properties || {};
      const desc = [
        `Altitude: ${p.lower_lim || '?'} – ${p.upper_lim || '?'}`,
        `Status: ${p.status || '?'}`,
        `Contact: ${p.contact || '?'}`,
      ].join('\n');
      return polygonPlacemark(p.zone_id || 'Restricted zone', feature.geometry, '#restrictedZone', desc);
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Drone flying zone — RO</name>
    <description>Generated ${generatedAt} · Restricted-zone data: ROMATSA</description>
    <Style id="flightZone">
      <LineStyle><color>ff16a34a</color><width>2</width></LineStyle>
      <PolyStyle><color>4d16a34a</color></PolyStyle>
    </Style>
    <Style id="restrictedZone">
      <LineStyle><color>ff2222dc</color><width>2</width></LineStyle>
      <PolyStyle><color>4d2222dc</color></PolyStyle>
    </Style>
    <Folder>
      <name>Flying zone</name>
${polygonPlacemark('Flying zone', flightGeometry, '#flightZone')}
    </Folder>${
      overlaps.length
        ? `
    <Folder>
      <name>Overlapping restricted zones (${overlaps.length})</name>
${overlapPlacemarks}
    </Folder>`
        : ''
    }
  </Document>
</kml>`;
}

// Emit one or more placemarks for a Polygon or MultiPolygon geometry.
function geometryPlacemarks(name, geometry, styleUrl, description) {
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map((coords, i) => polygonPlacemark(`${name} ${i + 1}`, { type: 'Polygon', coordinates: coords }, styleUrl, description))
      .join('\n');
  }
  return polygonPlacemark(name, geometry, styleUrl, description);
}

/**
 * Build an LBA-compliant SORA operational-volume KML: Flight Geography (green),
 * Contingency Volume (yellow) and Ground Risk Buffer (red), each in its own
 * named folder — the format the authority expects attached to the application.
 * @param {{fg:object, cv:object, grb:object, meta?:object}} v GeoJSON Features.
 */
function pointPlacemark(name, ll) {
  return `    <Placemark><name>${escapeXml(name)}</name><Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point></Placemark>`;
}

export function buildVolumeKml({ fg, cv, grb, pilot, told, meta = {} }) {
  const generatedAt = new Date().toISOString();
  const name = meta.name || 'SORA operational volume — RO';
  const description = `${meta.description ? meta.description + '\n' : ''}Generated ${generatedAt} · method: LBA / IR (EU) 2019/947`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>
    <Style id="fg"><LineStyle><color>ff4aa316</color><width>2</width></LineStyle><PolyStyle><color>664aa316</color></PolyStyle></Style>
    <Style id="cv"><LineStyle><color>ff0677d9</color><width>2</width></LineStyle><PolyStyle><color>660677d9</color></PolyStyle></Style>
    <Style id="grb"><LineStyle><color>ff2626dc</color><width>2</width></LineStyle><PolyStyle><color>662626dc</color></PolyStyle></Style>
    <Folder>
      <name>Flight Geography</name>
${geometryPlacemarks('Flight Geography', fg.geometry, '#fg')}
    </Folder>
    <Folder>
      <name>Contingency Volume</name>
${geometryPlacemarks('Contingency Volume', cv.geometry, '#cv')}
    </Folder>
    <Folder>
      <name>Ground Risk Buffer</name>
${geometryPlacemarks('Ground Risk Buffer', grb.geometry, '#grb')}
    </Folder>${pilot ? `
    <Folder>
      <name>Pilot</name>
${pointPlacemark('Pilot', pilot)}
    </Folder>` : ''}${told ? `
    <Folder>
      <name>TO/LD</name>
${pointPlacemark('TO/LD', told)}
    </Folder>` : ''}
  </Document>
</kml>`;
}

export function downloadKml(kmlString, filename = 'flying-zone.kml') {
  const blob = new Blob([kmlString], { type: 'application/vnd.google-earth.kml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
