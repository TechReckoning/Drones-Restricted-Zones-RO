# Deploying Drones Restricted Zones RO (Render + live Stripe)

Production host: **Render**. Domain: **drones-rz-romania.com** (apex), DNS managed
at **Squarespace**. Payments: **Stripe live mode**.

> Secrets (Supabase service-role key, Stripe live secret key, webhook secret) are
> entered directly in the Render dashboard — never committed to git.

---

## 1. Create the Render web service
1. Render dashboard → **New +** → **Web Service** → connect GitHub →
   pick `TechReckoning/Drones-Restricted-Zones-RO`.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Health check path:** `/api/health`
   - **Region:** Frankfurt (EU)
   - **Instance type:** Free to start (note: free spins down when idle → slow
     first request; upgrade to Starter for always-on).

## 2. Environment variables (Render → the service → Environment)
Add each (values from your Supabase project and **live** Stripe):
```
PUBLIC_URL                = https://drones-rz-romania.com
SUPABASE_URL              = https://rukmrwugvzgvtjxsghbg.supabase.co
SUPABASE_ANON_KEY         = <your anon/publishable key>
SUPABASE_SERVICE_ROLE_KEY = <your service-role/secret key>
STRIPE_SECRET_KEY         = sk_live_...        (LIVE secret key)
STRIPE_PRICE_MONTHLY      = price_...          (from step 4, LIVE)
STRIPE_PRICE_ANNUAL       = price_...          (from step 4, LIVE)
STRIPE_WEBHOOK_SECRET     = whsec_...          (from step 5, LIVE)
```
Deploy. The service should come up at `https://<name>.onrender.com` — open
`/api/health` to confirm it returns `{ ok: true }`.

## 3. Custom domain (Render + Squarespace DNS)
1. Render → the service → **Settings → Custom Domains** → add
   `drones-rz-romania.com` **and** `www.drones-rz-romania.com`.
2. Render shows the exact DNS records to create. Typically:
   - apex `drones-rz-romania.com` → an **A** record to Render's IP (Render shows it), or an ALIAS/ANAME if offered.
   - `www` → a **CNAME** to `<name>.onrender.com`.
3. In **Squarespace → Domains → drones-rz-romania.com → DNS Settings**, add those
   exact records. Remove any conflicting default A/CNAME on the apex.
4. Wait for DNS to propagate; Render auto-issues the HTTPS certificate.

## 4. Create the LIVE Stripe products/prices (no secret handling)
In the **Stripe Dashboard**, toggle to **live mode** (top-right), then
**Products → Add product**:
- Name: `Drones Restricted Zones RO — Pro`
- Price 1: **50 RON**, recurring **monthly** → copy the `price_...` id → `STRIPE_PRICE_MONTHLY`
- Price 2: **550 RON**, recurring **yearly** → copy the `price_...` id → `STRIPE_PRICE_ANNUAL`

Put both IDs into Render env vars (step 2).

## 5. LIVE webhook
Stripe Dashboard (live mode) → **Developers → Webhooks → Add endpoint**:
- URL: `https://drones-rz-romania.com/api/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`.
- Copy the endpoint's **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`
  in Render → redeploy.

## 6. Activate the LIVE Customer Portal
Stripe Dashboard (live mode) → **Settings → Billing → Customer portal** →
enable cancellation + invoice history → **Save**. (Required or the in-app
"Manage billing" button errors.)

## 7. Supabase redirect URLs
Supabase → **Authentication → URL Configuration**:
- **Site URL:** `https://drones-rz-romania.com`
- **Redirect URLs:** add `https://drones-rz-romania.com/**`
  (keep localhost entries for local dev).

## 8. Post-deploy verification
- `https://drones-rz-romania.com` loads; map + zones render.
- Magic-link sign-in works (email link returns you to the live domain, logged in).
- "Subscribe" → Checkout opens on the live domain; a **real** payment creates a
  subscription and the webhook flips access to active (visible in Render logs +
  Stripe Dashboard).
- "Manage billing" opens the live Customer Portal.

> ⚠️ Live mode charges real cards. Do a single real subscription to confirm the
> full flow, then cancel/refund from the Stripe Dashboard if it was only a test.
