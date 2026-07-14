// Cookie/privacy notice. The app uses only strictly-necessary storage, so this is
// an informational notice (no non-essential cookies to gate); the dismissal is
// remembered so it isn't shown again.

const KEY = 'dz-cookie-ack';

function initConsent() {
  const banner = document.getElementById('cookie-banner');
  if (!banner) return;
  let ack = null;
  try { ack = localStorage.getItem(KEY); } catch {}
  if (ack) return;

  banner.classList.remove('hidden');
  banner.querySelector('[data-ack]')?.addEventListener('click', () => {
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch {}
    banner.classList.add('hidden');
  });
}

initConsent();
