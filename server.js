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
const https = require('https');
const supa = require('./lib/supabase');
const billing = require('./lib/stripe');

const app = express();
// Render (and most PaaS) terminate TLS at a proxy and forward the request, so
// trust the first proxy hop for correct client IPs / protocol.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ---- Beta / staging gate (env-driven; a no-op in production) ----
// On the staging service set BETA_MODE=1 to mark the whole site noindex, and
// optionally BETA_PASSWORD to require a shared password (HTTP Basic Auth) so the
// public and unfinished features don't collide. Production leaves these unset.
if (process.env.BETA_MODE === '1' || process.env.BETA_MODE === 'true') {
  const BETA_USER = process.env.BETA_USER || 'beta';
  const BETA_PASSWORD = process.env.BETA_PASSWORD || '';
  app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');        // keep staging out of search
    if (!BETA_PASSWORD) return next();                    // noindex only, no password
    // Only gate the UI (pages/assets). The /api routes carry their own
    // `Authorization: Bearer <supabase JWT>` and are protected by requireUser /
    // requireEntitlement — Basic-auth'ing them too would clash with that header
    // (e.g. it would 401 the checkout call). The Stripe webhook is under /api too.
    if (req.path.startsWith('/api/')) return next();
    const [scheme, b64] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && b64) {
      const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
      if (u === BETA_USER && p === BETA_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Drones Restricted Zones RO (beta)"');
    return res.status(401).send('Beta access required.');
  });
}

// The Stripe webhook must see the RAW request body to verify its signature, so
// it is registered with express.raw BEFORE the JSON parser below consumes it.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler);

app.use(express.json({ limit: '1mb' }));

const SOURCE_URL =
  process.env.ZONES_SOURCE_URL ||
  'https://flightplan.romatsa.ro/init/static/zone_restrictionate_uav.json';
const SNAPSHOT_PATH = path.join(__dirname, 'data', 'zones.snapshot.json');
const DATASET_META_PATH = path.join(__dirname, 'data', 'dataset-meta.json');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (matches the background refresh)
const FETCH_TIMEOUT_MS = 20 * 1000;

// NOTAMs (time-limited restrictions). Live source is a ROMATSA GeoServer WFS
// endpoint — set NOTAM_SOURCE_URL to enable live fetching; otherwise the bundled
// snapshot is served. Cached briefly because NOTAMs change often.
const NOTAM_SOURCE_URL = process.env.NOTAM_SOURCE_URL || '';
const NOTAM_SNAPSHOT_PATH = path.join(__dirname, 'data', 'notams.snapshot.json');
const NOTAM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (matches the background refresh)

/** @type {{ data: any, ts: number }} */
let cache = { data: null, ts: 0 };
/** @type {{ data: any, ts: number }} */
let notamCache = { data: null, ts: 0 };

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
      ctrZones: Array.isArray(meta.ctrZones) ? meta.ctrZones : [],
    };
  } catch (err) {
    console.warn('[dataset-meta] could not read metadata:', err.message);
    return { validFrom: null, newZones: [], ctrZones: [] };
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

// ROMATSA's TLS endpoint (an old Jetty) negotiates a weak (<2048-bit) Diffie-
// Hellman key that modern OpenSSL rejects with ERR_SSL_DH_KEY_TOO_SMALL from
// datacenter hosts like Render — even though the same request succeeds from other
// networks. The server also offers plain-RSA key-exchange GCM ciphers (no DH), so
// we pin those to sidestep the weak-DH path entirely while KEEPING full
// certificate validation (rejectUnauthorized stays true). Used for both feeds.
function fetchRomatsaJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256',
        headers: { 'User-Agent': 'DronesRestrictedZonesRO/1.0 (+github.com/TechReckoning)' },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`source responded ${res.statusCode} ${res.statusMessage || ''}`.trim()));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('source payload was not valid JSON: ' + e.message)); }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

async function fetchZonesFromSource() {
  const json = await fetchRomatsaJson(SOURCE_URL);
  if (!isFeatureCollection(json)) throw new Error('source payload is not a non-empty FeatureCollection');
  return json;
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

// Pull the zones feed and update the in-memory cache + on-disk snapshot. Used by
// the background refresher so the cache stays warm even with zero traffic.
async function refreshZonesCache(reason) {
  try {
    const json = await fetchZonesFromSource();
    cache = { data: json, ts: Date.now() };
    writeSnapshot(json);
    return true;
  } catch (err) {
    console.warn(`[zones] background refresh failed (${reason}):`, describeFetchError(err));
    return false;
  }
}

// Same for the NOTAM feed (no-op when no source is configured).
async function refreshNotamCache(reason) {
  if (!NOTAM_SOURCE_URL) return false;
  try {
    const json = await fetchRomatsaJson(NOTAM_SOURCE_URL);
    if (!isFeatureCollection(json)) throw new Error('NOTAM source payload is not a non-empty FeatureCollection');
    notamCache = { data: json, ts: Date.now() };
    fs.promises.writeFile(NOTAM_SNAPSHOT_PATH, JSON.stringify(json)).catch(() => {});
    return true;
  } catch (err) {
    console.warn(`[notams] background refresh failed (${reason}):`, describeFetchError(err));
    return false;
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

// NOTAMs — proxied live from the ROMATSA WFS endpoint when configured, otherwise
// served from the bundled snapshot. Same cache-with-snapshot-fallback shape as /api/zones.
async function readNotamSnapshot() {
  const json = JSON.parse(await fs.promises.readFile(NOTAM_SNAPSHOT_PATH, 'utf8'));
  if (!isFeatureCollection(json)) throw new Error('NOTAM snapshot is not a valid FeatureCollection');
  return json;
}

// Node's fetch throws a generic "fetch failed"; the real reason (ECONNREFUSED,
// UND_ERR_CONNECT_TIMEOUT, cert errors, host firewall drop) is on err.cause.
function describeFetchError(err) {
  const c = err && err.cause;
  if (c && (c.code || c.message)) return `${err.message} (${c.code || ''}${c.code && c.message ? ': ' : ''}${c.message || ''})`;
  return err ? err.message : 'unknown error';
}

app.get('/api/notams', async (req, res) => {
  const force = 'refresh' in req.query;
  const now = Date.now();

  if (!NOTAM_SOURCE_URL) {
    try {
      const snap = await readNotamSnapshot();
      return res.json({ meta: { source: 'snapshot', fetchedAt: null, count: snap.features.length }, geojson: snap });
    } catch (err) {
      return res.status(502).json({ error: 'No NOTAM source configured and snapshot unavailable.', detail: err.message });
    }
  }

  if (!force && notamCache.data && now - notamCache.ts < NOTAM_CACHE_TTL_MS) {
    return res.json({ meta: { source: 'live-cache', fetchedAt: new Date(notamCache.ts).toISOString(), count: notamCache.data.features.length }, geojson: notamCache.data });
  }

  try {
    const json = await fetchRomatsaJson(NOTAM_SOURCE_URL);
    if (!isFeatureCollection(json)) throw new Error('NOTAM source payload is not a non-empty FeatureCollection');
    notamCache = { data: json, ts: now };
    fs.promises.writeFile(NOTAM_SNAPSHOT_PATH, JSON.stringify(json)).catch(() => {});
    return res.json({ meta: { source: 'live', fetchedAt: new Date(now).toISOString(), count: json.features.length }, geojson: json });
  } catch (err) {
    const reason = describeFetchError(err);
    console.warn('[notams] live fetch failed, falling back:', reason);
    if (notamCache.data) {
      return res.json({ meta: { source: 'stale-cache', fetchedAt: new Date(notamCache.ts).toISOString(), count: notamCache.data.features.length, warning: reason }, geojson: notamCache.data });
    }
    try {
      const snap = await readNotamSnapshot();
      return res.json({ meta: { source: 'snapshot', fetchedAt: null, count: snap.features.length, warning: reason }, geojson: snap });
    } catch (snapErr) {
      return res.status(502).json({ error: 'Could not fetch live NOTAMs and no usable snapshot.', detail: reason, snapshotError: snapErr.message });
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

app.get('/api/flights', requireUser, requireEntitlement, async (req, res) => {
  const { data, error } = await req.db
    .from('flight_zones')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ flights: data });
});

app.post('/api/flights', requireUser, requireEntitlement, async (req, res) => {
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

app.patch('/api/flights/:id', requireUser, requireEntitlement, async (req, res) => {
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

app.delete('/api/flights/:id', requireUser, requireEntitlement, async (req, res) => {
  const { error } = await req.db.from('flight_zones').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Profile + equipment library (flight-request generator, Phase A)
// Pro feature → requireEntitlement. User-scoped client so RLS applies.
// ---------------------------------------------------------------------------

// Keep only allowed columns from the request body; treat '' as null.
function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body && body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  return out;
}

// Single operator profile per user (upsert).
app.get('/api/profile/operator', requireUser, requireEntitlement, async (req, res) => {
  const { data, error } = await req.db.from('operator_profile').select('*').eq('user_id', req.user.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ operator: data || null });
});

app.put('/api/profile/operator', requireUser, requireEntitlement, async (req, res) => {
  const row = pick(req.body, ['operator_name', 'contact_details', 'contact_person', 'phone_landline', 'phone_mobile', 'fax', 'email', 'operator_code']);
  row.user_id = req.user.id;
  row.updated_at = new Date().toISOString();
  const { data, error } = await req.db.from('operator_profile').upsert(row, { onConflict: 'user_id' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ operator: data });
});

// Generic owner-scoped CRUD for the library tables (pilots, drones).
function registerLibraryCrud(path, table, fields) {
  app.get(`/api/${path}`, requireUser, requireEntitlement, async (req, res) => {
    const { data, error } = await req.db.from(table).select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ items: data });
  });
  app.post(`/api/${path}`, requireUser, requireEntitlement, async (req, res) => {
    const row = pick(req.body, fields);
    row.user_id = req.user.id;
    const { data, error } = await req.db.from(table).insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ item: data });
  });
  app.patch(`/api/${path}/:id`, requireUser, requireEntitlement, async (req, res) => {
    const { data, error } = await req.db.from(table).update(pick(req.body, fields)).eq('id', req.params.id).select().maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Not found.' });
    res.json({ item: data });
  });
  app.delete(`/api/${path}/:id`, requireUser, requireEntitlement, async (req, res) => {
    const { error } = await req.db.from(table).delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.status(204).end();
  });
}

registerLibraryCrud('pilots', 'pilots', ['name', 'phone', 'qualifications']);
registerLibraryCrud('drones', 'drones', ['registration', 'serial', 'manufacturer', 'model', 'operating_class', 'category', 'operator_code', 'mtom_kg',
  'aircraft_type', 'v0_ms', 'cd_m', 'v_wind_ms', 'glide_ratio']);
// Saved flight-request history (Phase B). `fields` is the jsonb PDF field map.
registerLibraryCrud('requests', 'flight_requests', ['form_type', 'label', 'fields']);

// ---------------------------------------------------------------------------
// GDPR self-serve: data export (portability) + account deletion (erasure).
//
// Deliberately behind requireUser ONLY — never requireEntitlement: these rights
// are unconditional and must keep working after a trial/subscription lapses.
// ---------------------------------------------------------------------------

const USER_TABLES = ['operator_profile', 'pilots', 'drones', 'flight_zones', 'flight_requests', 'subscriptions'];

app.get('/api/account/export', requireUser, async (req, res) => {
  const out = {
    exported_at: new Date().toISOString(),
    account: { id: req.user.id, email: req.user.email, created_at: req.user.created_at },
  };
  for (const t of USER_TABLES) {
    const { data, error } = await req.db.from(t).select('*'); // RLS → only own rows
    if (error) return res.status(500).json({ error: `Could not export ${t}: ${error.message}` });
    out[t] = data;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="drones-rz-romania-my-data.json"`);
  res.send(JSON.stringify(out, null, 2));
});

app.post('/api/account/delete', requireUser, async (req, res) => {
  const admin = supa.adminClient();
  if (!admin) return res.status(503).json({ error: 'Account deletion is not available on this server.' });
  // Require the caller to retype their email — guards against accidental deletion.
  const confirm = String((req.body && req.body.confirm) || '').trim().toLowerCase();
  if (!confirm || confirm !== String(req.user.email || '').toLowerCase()) {
    return res.status(400).json({ error: 'The confirmation does not match your account email.' });
  }
  // Stop billing first, so a deleted account can never be charged again.
  try {
    const { data: sub } = await admin.from('subscriptions').select('stripe_subscription_id').eq('user_id', req.user.id).maybeSingle();
    if (sub && sub.stripe_subscription_id && billing.configured()) {
      try { await billing.stripe.subscriptions.cancel(sub.stripe_subscription_id); }
      catch (e) { console.warn('[delete] could not cancel subscription:', e.message); }
    }
  } catch (e) { console.warn('[delete] subscription lookup failed:', e.message); }
  // Delete the auth user; all app tables cascade via ON DELETE CASCADE.
  // Invoices already issued stay with Stripe (Romanian fiscal retention).
  const { error } = await admin.auth.admin.deleteUser(req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Trial + billing entitlement (Phase 3)
//
// Access to pro features = an active 7-day trial OR an active subscription.
// The trial is anchored to the account creation date and stored in the
// `subscriptions` row; subscription state is written by the Stripe webhook.
// ---------------------------------------------------------------------------

const TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_SUB = new Set(['active', 'trialing']);

function trialEndsFor(user) {
  return new Date(new Date(user.created_at).getTime() + TRIAL_MS).toISOString();
}

// Ensure a subscriptions row exists (creates one with the trial window on first
// sight). Uses the service role; returns null if that key isn't configured, in
// which case the trial is derived from the account creation date instead.
async function ensureBillingRow(user) {
  const admin = supa.adminClient();
  if (!admin) return null;
  const { data } = await admin.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  if (data) return data;
  const row = { user_id: user.id, trial_ends_at: trialEndsFor(user), updated_at: new Date().toISOString() };
  const { data: inserted } = await admin.from('subscriptions').insert(row).select().maybeSingle();
  return inserted || row;
}

function entitlementFor(user, row) {
  const now = Date.now();
  const trialEndsAt = (row && row.trial_ends_at) || trialEndsFor(user);
  const trialActive = new Date(trialEndsAt).getTime() > now;
  const status = (row && row.status) || null;
  const subActive = ACTIVE_SUB.has(status);
  return {
    access: trialActive || subActive,
    trialActive,
    trialEndsAt,
    daysLeft: Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now) / (24 * 60 * 60 * 1000))),
    subscription: row && row.stripe_subscription_id ? { status, plan: row.plan, currentPeriodEnd: row.current_period_end } : null,
    billingConfigured: billing.configured(),
  };
}

async function requireEntitlement(req, res, next) {
  const row = await ensureBillingRow(req.user);
  const ent = entitlementFor(req.user, row);
  if (!ent.access) {
    return res.status(402).json({ error: 'Your free trial has ended. Subscribe to use pro features.', entitlement: ent });
  }
  req.entitlement = ent;
  next();
}

app.get('/api/account', requireUser, async (req, res) => {
  const row = await ensureBillingRow(req.user);
  res.json(entitlementFor(req.user, row));
});

function publicBase() {
  return process.env.PUBLIC_URL || `http://localhost:${PORT}`;
}

async function getOrCreateCustomer(user) {
  const admin = supa.adminClient();
  const existing = admin ? (await admin.from('subscriptions').select('stripe_customer_id').eq('user_id', user.id).maybeSingle()).data : null;
  if (existing && existing.stripe_customer_id) return existing.stripe_customer_id;
  const customer = await billing.stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
  if (admin) {
    await admin.from('subscriptions').upsert({
      user_id: user.id,
      stripe_customer_id: customer.id,
      trial_ends_at: trialEndsFor(user),
      updated_at: new Date().toISOString(),
    });
  }
  return customer.id;
}

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  if (!billing.configured()) return res.status(503).json({ error: 'Billing is not configured on this server.' });
  const plan = req.body && req.body.plan === 'annual' ? 'annual' : 'monthly';
  const accountType = req.body && req.body.accountType === 'business' ? 'business' : 'individual';
  const price = plan === 'annual' ? billing.PRICE_ANNUAL : billing.PRICE_MONTHLY;
  if (!price) return res.status(503).json({ error: 'Subscription prices are not configured.' });
  try {
    const customer = await getOrCreateCustomer(req.user);
    const base = publicBase();

    // Invoicing fields differ by customer type (Stripe custom fields can't branch,
    // so we build the right set here). Individuals: CNP is OPTIONAL. Businesses:
    // company name + CIF are REQUIRED — Stripe enforces optional:false on its page.
    const custom_fields = accountType === 'business'
      ? [
          {
            key: 'company',
            label: { type: 'custom', custom: 'Denumire firmă (Company name)' },
            type: 'text',
            text: { minimum_length: 2, maximum_length: 200 },
            optional: false,
          },
          {
            key: 'cif',
            label: { type: 'custom', custom: 'CIF / CUI (cod fiscal)' },
            type: 'text',
            text: { minimum_length: 2, maximum_length: 20 },
            optional: false,
          },
        ]
      : [
          {
            key: 'cnp',
            label: { type: 'custom', custom: 'CNP (optional — pentru factură)' },
            type: 'numeric',
            numeric: { minimum_length: 13, maximum_length: 13 },
            optional: true,
          },
        ];

    const session = await billing.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: req.user.id,
      subscription_data: { metadata: { user_id: req.user.id } },
      metadata: { account_type: accountType },
      allow_promotion_codes: true,
      // Collect the details needed to issue legally-required Romanian invoices.
      billing_address_collection: 'required', // full name + billing address
      custom_fields,
      success_url: `${base}/app?checkout=success`,
      cancel_url: `${base}/app?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout error:', err.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

app.post('/api/billing/portal', requireUser, async (req, res) => {
  if (!billing.configured()) return res.status(503).json({ error: 'Billing is not configured on this server.' });
  const admin = supa.adminClient();
  const row = admin ? (await admin.from('subscriptions').select('stripe_customer_id').eq('user_id', req.user.id).maybeSingle()).data : null;
  if (!row || !row.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet.' });
  try {
    const session = await billing.stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${publicBase()}/app`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] portal error:', err.message);
    res.status(500).json({ error: 'Could not open billing portal.' });
  }
});

// Webhook handler (registered with express.raw near the top of the file).
async function billingWebhookHandler(req, res) {
  if (!billing.configured() || !billing.WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = billing.stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], billing.WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await captureBillingDetails(event.data.object);
        await syncSubscription(event);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(event);
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    res.status(500).end();
  }
}

// On checkout completion, persist the invoicing identity (name, address, CNP) onto
// the Stripe customer so it's available for every invoice, including renewals.
// CNP is kept in Stripe customer metadata (not duplicated into our own database).
async function captureBillingDetails(session) {
  try {
    if (!session || !session.customer) return;
    const details = session.customer_details || {};
    const fields = session.custom_fields || [];
    const textVal = (key) => { const f = fields.find((x) => x.key === key); return f && f.text ? f.text.value : null; };
    const numVal = (key) => { const f = fields.find((x) => x.key === key); return f && f.numeric ? f.numeric.value : null; };

    const accountType = (session.metadata && session.metadata.account_type) === 'business' ? 'business' : 'individual';
    const metadata = { account_type: accountType };
    if (accountType === 'business') {
      const company = textVal('company');
      const cif = textVal('cif');
      if (company) metadata.company_name = company;
      if (cif) metadata.cif = cif;
    } else {
      const cnp = numVal('cnp'); // optional now — may be null
      if (cnp) metadata.cnp = cnp;
    }

    const update = { metadata };
    // For a business, show the company name on the Stripe customer/invoice.
    if (accountType === 'business' && metadata.company_name) update.name = metadata.company_name;
    else if (details.name) update.name = details.name;
    if (details.address) update.address = details.address;
    if (details.phone) update.phone = details.phone;
    await billing.stripe.customers.update(session.customer, update);
  } catch (err) {
    console.warn('[billing] could not capture billing details:', err.message);
  }
}

async function syncSubscription(event) {
  const admin = supa.adminClient();
  if (!admin) return;
  let sub;
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (!session.subscription) return;
    sub = await billing.stripe.subscriptions.retrieve(session.subscription);
  } else {
    sub = event.data.object;
  }
  let userId = sub.metadata && sub.metadata.user_id;
  if (!userId) {
    const { data } = await admin.from('subscriptions').select('user_id').eq('stripe_customer_id', sub.customer).maybeSingle();
    userId = data && data.user_id;
  }
  if (!userId) {
    console.warn('[webhook] could not map subscription', sub.id, 'to a user');
    return;
  }
  await upsertSubscription(userId, sub);
}

// Write a Stripe subscription object into our subscriptions table (service role).
async function upsertSubscription(userId, sub) {
  const admin = supa.adminClient();
  if (!admin) return;
  const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
  const plan = priceId === billing.PRICE_ANNUAL ? 'annual' : priceId === billing.PRICE_MONTHLY ? 'monthly' : null;
  await admin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    status: sub.status,
    plan,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
}

// Pull the caller's latest subscription from Stripe and persist it. Called by the
// frontend right after a successful checkout so access unlocks without waiting on
// the webhook (webhooks still handle later lifecycle changes).
app.post('/api/billing/sync', requireUser, async (req, res) => {
  if (!billing.configured()) return res.status(503).json({ error: 'Billing is not configured on this server.' });
  const admin = supa.adminClient();
  const row = admin ? (await admin.from('subscriptions').select('stripe_customer_id').eq('user_id', req.user.id).maybeSingle()).data : null;
  if (!row || !row.stripe_customer_id) return res.json({ synced: false });
  try {
    const subs = await billing.stripe.subscriptions.list({ customer: row.stripe_customer_id, status: 'all', limit: 1 });
    const sub = subs.data[0];
    if (sub) await upsertSubscription(req.user.id, sub);
    res.json({ synced: Boolean(sub) });
  } catch (err) {
    console.error('[billing] sync error:', err.message);
    res.status(500).json({ error: 'Sync failed.' });
  }
});

// Landing page at "/", the interactive map app at "/app". Registered before the
// static middleware so "/" serves the landing rather than index.html.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get(['/app', '/app/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Clean URLs for the legal/policy pages (Phase 4).
['privacy', 'cookies', 'consumer'].forEach((page) => {
  app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, 'public', 'legal', page + '.html')));
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Background refresh: keep both caches warm from ROMATSA even with no visitors, so
// the first request is always live and the data never silently goes stale.
const ZONES_REFRESH_MS = 30 * 60 * 1000; // 30 minutes
const NOTAM_REFRESH_MS = 5 * 60 * 1000;  // 5 minutes
function startBackgroundRefresh() {
  refreshZonesCache('startup');
  refreshNotamCache('startup');
  setInterval(() => refreshZonesCache('interval'), ZONES_REFRESH_MS).unref();
  if (NOTAM_SOURCE_URL) setInterval(() => refreshNotamCache('interval'), NOTAM_REFRESH_MS).unref();
}

app.listen(PORT, () => {
  console.log(`Drones Restricted Zones RO running at http://localhost:${PORT}`);
  console.log(`Zones source: ${SOURCE_URL}`);
  console.log(`NOTAM source: ${NOTAM_SOURCE_URL ? NOTAM_SOURCE_URL : 'NOT configured (snapshot only)'}`);
  console.log(`Accounts (Supabase): ${supa.isConfigured() ? 'configured' : 'NOT configured (account features disabled)'}`);
  console.log(`Billing (Stripe): ${billing.configured() ? 'configured' : 'NOT configured (trial-only / no paywall)'}`);
  startBackgroundRefresh();
});
