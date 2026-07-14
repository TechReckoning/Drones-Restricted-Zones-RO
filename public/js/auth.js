// Supabase magic-link authentication + header/auth UI wiring.
//
// Degrades gracefully: if the server reports Supabase isn't configured, the
// account UI is hidden and the rest of the app works unchanged.

let sb = null;
let session = null;
let configured = false;
const changeListeners = [];

const el = (id) => document.getElementById(id);

export const auth = {
  get configured() { return configured; },
  get user() { return (session && session.user) || null; },
  get token() { return (session && session.access_token) || null; },
  onChange(fn) { changeListeners.push(fn); },

  async signIn(email) {
    return sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  },
  async signOut() {
    if (sb) await sb.auth.signOut();
  },

  async init() {
    let cfg;
    try {
      cfg = await (await fetch('/api/config')).json();
    } catch {
      cfg = { configured: false };
    }
    configured = Boolean(cfg.configured) && Boolean(window.supabase);
    wireUi();

    if (!configured) {
      renderLoggedOut();
      const btn = el('auth-btn');
      if (btn) {
        btn.textContent = 'Sign in';
        btn.title = 'Accounts are not configured on this server yet';
      }
      emit();
      return;
    }

    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, detectSessionInUrl: true, autoRefreshToken: true },
    });
    const { data } = await sb.auth.getSession();
    session = data.session;
    sb.auth.onAuthStateChange((_event, s) => {
      session = s;
      render();
      emit();
    });
    render();
    emit();
  },
};

function emit() {
  changeListeners.forEach((fn) => {
    try { fn(auth.user); } catch (e) { console.error(e); }
  });
}

function render() {
  auth.user ? renderLoggedIn() : renderLoggedOut();
}

function renderLoggedIn() {
  el('user-email').textContent = auth.user.email || 'Signed in';
  el('user-email').classList.remove('hidden');
  el('history-btn').classList.remove('hidden');
  el('auth-btn').textContent = 'Sign out';
}

function renderLoggedOut() {
  el('user-email').classList.add('hidden');
  el('history-btn').classList.add('hidden');
  el('auth-btn').textContent = 'Sign in';
}

let uiWired = false;
function wireUi() {
  if (uiWired) return;
  uiWired = true;

  el('auth-btn').addEventListener('click', () => {
    if (!configured) {
      toast('Accounts are not configured on this server yet.');
      return;
    }
    if (auth.user) auth.signOut();
    else openModal('signin-modal', () => el('signin-email').focus());
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  document.querySelectorAll('.modal-overlay').forEach((o) =>
    o.addEventListener('click', (e) => { if (e.target === o) closeModals(); })
  );
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  el('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('signin-email').value.trim();
    if (!email) return;
    el('signin-status').textContent = 'Sending…';
    const { error } = await auth.signIn(email);
    el('signin-status').textContent = error
      ? `Error: ${error.message}`
      : '✓ Check your email for the sign-in link.';
  });
}

export function openModal(id, after) {
  el(id).classList.remove('hidden');
  if (after) after();
}
export function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.add('hidden'));
}

let toastTimer = null;
export function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
