'use strict';

// Supabase server helpers. Two client flavours:
//   - userClient(token): bound to the caller's access token so PostgREST enforces
//     row-level security AS that user. Used for all user data access.
//   - adminClient(): service-role, bypasses RLS. Reserved for trusted server tasks
//     (e.g. Phase 3 Stripe webhooks). Never used on user-supplied input paths.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

let _admin = null;
function adminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!_admin) _admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, noPersist);
  return _admin;
}

function userClient(accessToken) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    ...noPersist,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

module.exports = {
  isConfigured,
  adminClient,
  userClient,
  config: { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY },
};
