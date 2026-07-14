'use strict';

/**
 * Drones Restricted Zones RO — backend.
 *
 * Jobs:
 *  1. Serve the static frontend in ./public
 *  2. Proxy the official ROMATSA restricted-zones GeoJSON at /api/zones.
 *  3. (Phase 2) Accounts + saved flying-zone history via Supabase (/api/flights).
 *
 * The zones proxy exists because the ROMATSA endpoint sends no CORS header, so a
 * browser cannot fetch it directly. Fetching server-side sidesteps that and
 * lets us cache the result and keep an on-disk snapshot as an offline fallback.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const supa = require('./lib/supabase');

const app = express();
app.use(express.json({ limit: '1mb' }));
const PORT = process.env.PORT || 3000;

const SOURCE_URL =
  process.env.ZONES_SOURCE_URL ||
  'https://flightplan.romatsa.ro/init/static/zone_restrictionate_uav.json';
const SNAPSHOT_PATH = path.join(__dirname, 'data', 'zones.snapshot.json');
const DATASET_META_PATH = path.join(__dirname, 'data', 'dataset-meta.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 20 * 1000;

/** @type {{ data: any, ts: number }} */
let cache = { data: null, ts: 0 };

/**
 * Manually-maintained dataset provenance (the ROMATSA feed itself carries no
 * effective-date field). Loaded once at startup; the file changes rarely and is
 * edited by hand when a new AIRAC-style update lands.
 * @returns {{ validFrom: string|null, newZones: string[] }}
 */
function loadDatasetInfo() {
  try {
    const meta = JSON.parse(fs.readFileSync(DATASET_META_PATH, 'utf8'));
    const versions = Array.isArray(meta.versions) ? meta.versions : [];
    const current =
      versions.find((v) => v.validFrom === meta.currentValidFrom) || versions[0] || null;
    return {
      validFrom: meta.currentValidFrom || (current && current.validFrom) || null,
      newZones: (current && Array.isArray(current.newZones) && current.newZones) || [],
    };
  } catch (err) {
    console.warn('[dataset-meta] could not read metadata:', err.message);
    return { validFrom: null, newZones: [] };
  }
}
const datasetInfo = loadDatasetInfo();

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
      meta: { source: 'live-cache', fetchedAt: new Date(cache.ts).toISOString(), count: cache.data.features.length, dataset: datasetInfo },
      geojson: cache.data,
    });
  }

  try {
    const json = await fetchZonesFromSource();
    cache = { data: json, ts: now };
    writeSnapshot(json); // fire-and-forget refresh of the offline fallback
    return res.json({
      meta: { source: 'live', fetchedAt: new Date(now).toISOString(), count: json.features.length, dataset: datasetInfo },
      geojson: json,
    });
  } catch (err) {
    console.warn('[zones] live fetch failed, falling back to snapshot:', err.message);
    // Prefer an in-memory cached copy over disk if we have one.
    if (cache.data) {
      return res.json({
        meta: { source: 'stale-cache', fetchedAt: new Date(cache.ts).toISOString(), count: cache.data.features.length, warning: err.message, dataset: datasetInfo },
        geojson: cache.data,
      });
    }
    try {
      const snap = await readSnapshot();
      return res.json({
        meta: { source: 'snapshot', fetchedAt: null, count: snap.features.length, warning: err.message, dataset: datasetInfo },
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

// ---------------------------------------------------------------------------
// Accounts + saved flying-zone history (Phase 2)
// ---------------------------------------------------------------------------

// Public browser config: safe to expose (anon key is a browser key). If Supabase
// isn't configured, the frontend hides all account UI and stays fully usable.
app.get('/api/config', (req, res) => {
  if (!supa.isConfigured()) return res.json({ configured: false });
  res.json({ configured: true, supabaseUrl: supa.config.url, supabaseAnonKey: supa.config.anonKey });
});

// Verify the caller's Supabase access token and attach a user-scoped DB client
// (RLS enforced as that user). 401 on any failure.
async function requireUser(req, res, next) {
  if (!supa.isConfigured()) {
    return res.status(503).json({ error: 'Accounts are not configured on this server.' });
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const db = supa.userClient(token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Invalid or expired session.' });
    req.user = data.user;
    req.db = db;
    next();
  } catch (err) {
    console.error('[auth] verification error:', err.message);
    res.status(401).json({ error: 'Could not verify session.' });
  }
}

app.get('/api/flights', requireUser, async (req, res) => {
  const { data, error } = await req.db
    .from('flight_zones')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ flights: data });
});

app.post('/api/flights', requireUser, async (req, res) => {
  const { name, geometry, overlap_zones, area_m2, dataset_valid_from } = req.body || {};
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    return res.status(400).json({ error: 'A GeoJSON Polygon geometry is required.' });
  }
  const row = {
    user_id: req.user.id, // RLS `with check` also enforces this matches the caller
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : 'Untitled flying zone',
    geometry,
    overlap_zones: Array.isArray(overlap_zones) ? overlap_zones.slice(0, 1000) : [],
    area_m2: Number.isFinite(area_m2) ? area_m2 : null,
    dataset_valid_from: dataset_valid_from || null,
  };
  const { data, error } = await req.db.from('flight_zones').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ flight: data });
});

app.patch('/api/flights/:id', requireUser, async (req, res) => {
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  const { data, error } = await req.db
    .from('flight_zones')
    .update({ name })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Flying zone not found.' });
  res.json({ flight: data });
});

app.delete('/api/flights/:id', requireUser, async (req, res) => {
  const { error } = await req.db.from('flight_zones').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Drones Restricted Zones RO running at http://localhost:${PORT}`);
  console.log(`Zones source: ${SOURCE_URL}`);
  console.log(`Accounts (Supabase): ${supa.isConfigured() ? 'configured' : 'NOT configured (account features disabled)'}`);
});
