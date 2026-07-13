'use strict';

/**
 * Drones Restricted Zones RO — backend.
 *
 * Two jobs:
 *  1. Serve the static frontend in ./public
 *  2. Proxy the official ROMATSA restricted-zones GeoJSON at /api/zones.
 *
 * The proxy exists because the ROMATSA endpoint sends no CORS header, so a
 * browser cannot fetch it directly. Fetching server-side sidesteps that and
 * lets us cache the result and keep an on-disk snapshot as an offline fallback.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  process.env.ZONES_SOURCE_URL ||
  'https://flightplan.romatsa.ro/init/static/zone_restrictionate_uav.json';
const SNAPSHOT_PATH = path.join(__dirname, 'data', 'zones.snapshot.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 20 * 1000;

/** @type {{ data: any, ts: number }} */
let cache = { data: null, ts: 0 };

function isFeatureCollection(json) {
  return (
    json &&
    json.type === 'FeatureCollection' &&
    Array.isArray(json.features) &&
    json.features.length > 0
  );
}

async function fetchZonesFromSource() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'DronesRestrictedZonesRO/1.0 (+github.com/TechReckoning)' },
    });
    if (!res.ok) throw new Error(`source responded ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (!isFeatureCollection(json)) throw new Error('source payload is not a non-empty FeatureCollection');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function readSnapshot() {
  const raw = await fs.promises.readFile(SNAPSHOT_PATH, 'utf8');
  const json = JSON.parse(raw);
  if (!isFeatureCollection(json)) throw new Error('snapshot is not a valid FeatureCollection');
  return json;
}

async function writeSnapshot(json) {
  try {
    await fs.promises.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    await fs.promises.writeFile(SNAPSHOT_PATH, JSON.stringify(json));
  } catch (err) {
    console.warn('[zones] could not persist snapshot:', err.message);
  }
}

app.get('/api/zones', async (req, res) => {
  const force = 'refresh' in req.query;
  const now = Date.now();

  if (!force && cache.data && now - cache.ts < CACHE_TTL_MS) {
    return res.json({
      meta: { source: 'live-cache', fetchedAt: new Date(cache.ts).toISOString(), count: cache.data.features.length },
      geojson: cache.data,
    });
  }

  try {
    const json = await fetchZonesFromSource();
    cache = { data: json, ts: now };
    writeSnapshot(json); // fire-and-forget refresh of the offline fallback
    return res.json({
      meta: { source: 'live', fetchedAt: new Date(now).toISOString(), count: json.features.length },
      geojson: json,
    });
  } catch (err) {
    console.warn('[zones] live fetch failed, falling back to snapshot:', err.message);
    // Prefer an in-memory cached copy over disk if we have one.
    if (cache.data) {
      return res.json({
        meta: { source: 'stale-cache', fetchedAt: new Date(cache.ts).toISOString(), count: cache.data.features.length, warning: err.message },
        geojson: cache.data,
      });
    }
    try {
      const snap = await readSnapshot();
      return res.json({
        meta: { source: 'snapshot', fetchedAt: null, count: snap.features.length, warning: err.message },
        geojson: snap,
      });
    } catch (snapErr) {
      return res.status(502).json({
        error: 'Could not fetch live zones and no usable snapshot is available.',
        detail: err.message,
        snapshotError: snapErr.message,
      });
    }
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cached: Boolean(cache.data), cachedAt: cache.ts ? new Date(cache.ts).toISOString() : null });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Drones Restricted Zones RO running at http://localhost:${PORT}`);
  console.log(`Zones source: ${SOURCE_URL}`);
});
