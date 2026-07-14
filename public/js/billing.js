// Trial + subscription (Stripe) UI: entitlement banner, subscribe modal, and the
// ensurePro() gate used before any pro feature (drawing, overlap, KML, history).

import { auth, openModal, toast } from './auth.js';

const el = (id) => document.getElementById(id);
let entitlement = null;

export const billing = {
  // When accounts aren't configured the app is fully open (no paywall).
  get access() {
    if (!auth.configured) return true;
    return Boolean(entitlement && entitlement.access);
  },
  get entitlement() {
    return entitlement;
  },

  init() {
    document.querySelectorAll('[data-plan]').forEach((b) =>
      b.addEventListener('click', () => startCheckout(b.dataset.plan))
    );

    const params = new URLSearchParams(location.search);
    if (params.get('checkout') === 'success') {
      cleanUrl();
      // Pull the fresh subscription so access unlocks immediately (no webhook wait).
      fetch('/api/billing/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } })
        .catch(() => {})
        .finally(() => { this.refresh(); toast('Subscription active — thank you!'); });
    } else if (params.get('checkout') === 'cancel') {
      toast('Checkout canceled.');
      cleanUrl();
    }

    auth.onChange(() => this.refresh());
    this.refresh();
  },

  async refresh() {
    if (!auth.configured || !auth.user) { entitlement = null; renderBanner(); return; }
    try {
      const res = await fetch('/api/account', { headers: { Authorization: 'Bearer ' + auth.token } });
      entitlement = res.ok ? await res.json() : null;
    } catch {
      entitlement = null;
    }
    renderBanner();
  },

  // Returns true if the caller may use a pro feature; otherwise routes the user
  // to sign-in or subscribe and returns false.
  ensurePro() {
    if (!auth.configured) return true;
    if (!auth.user) {
      openModal('signin-modal', () => el('signin-email').focus());
      toast('Sign in to use pro features.');
      return false;
    }
    if (!this.access) {
      this.openSubscribe();
      return false;
    }
    return true;
  },

  openSubscribe() {
    if (entitlement && entitlement.billingConfigured === false) {
      toast('Billing is not configured on this server yet.');
      return;
    }
    openModal('subscribe-modal');
  },
};

async function startCheckout(plan) {
  el('subscribe-status').textContent = 'Redirecting to secure checkout…';
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
      body: JSON.stringify({ plan }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else el('subscribe-status').textContent = data.error || 'Could not start checkout.';
  } catch {
    el('subscribe-status').textContent = 'Network error.';
  }
}

export async function openPortal() {
  try {
    const res = await fetch('/api/billing/portal', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token } });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else toast(data.error || 'Could not open billing portal.');
  } catch {
    toast('Network error.');
  }
}

function renderBanner() {
  const banner = el('billing-banner');
  if (!banner) return;
  if (!auth.configured || !auth.user || !entitlement) {
    banner.classList.add('hidden');
    return;
  }
  const e = entitlement;
  banner.classList.remove('hidden');
  banner.classList.toggle('locked', !e.access);

  if (e.subscription && e.access) {
    banner.innerHTML = `<span>✓ Pro active${e.subscription.plan ? ' · ' + e.subscription.plan : ''}</span>
      <button id="banner-manage" class="btn btn-mini">Manage billing</button>`;
  } else if (e.trialActive) {
    banner.innerHTML = `<span>⏳ Free trial · ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'} left</span>
      <button id="banner-subscribe" class="btn btn-mini btn-primary">Subscribe</button>`;
  } else {
    banner.innerHTML = `<span>⚠ Trial ended — pro features locked</span>
      <button id="banner-subscribe" class="btn btn-mini btn-primary">Subscribe</button>`;
  }
  el('banner-subscribe')?.addEventListener('click', () => billing.openSubscribe());
  el('banner-manage')?.addEventListener('click', openPortal);
}

function cleanUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('checkout');
  history.replaceState({}, '', url);
}
