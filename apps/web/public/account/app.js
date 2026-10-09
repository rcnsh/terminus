// The account page: signing in, first-time setup (onboarding.js), then
// Settings (settings.js) with "Your widget right now" beside it. Same origin
// as the API, so the session cookie just works. Setup and Settings load once
// someone is signed in: the sign-in card doesn't wait for them.

import { Fill, MARK, Rich, html, render, store, useEffect, useInterval, useRef, useState, useStore } from '../assets/ui.js';
import { api, forgetAccountHere, hour12, t } from './dom.js';
import { Card, Message, Report } from './preview.js';
import { Toast, loadCampus, loadProfile, saves, walkSpeed } from './profile.js';
import { Livery } from './livery.js';

/** Settings and first-time setup ({ Settings, offerImport, Onboarding }), once loaded. */
const parts = store(null);
let loading = null;
function loadParts() {
  // With what those two import that the page hasn't loaded yet, asked for
  // alongside: otherwise each level is found only once the one above arrives.
  loading ??= Promise.all([import('./settings.js'), import('./onboarding.js'), import('./settings-pages.js'), import('./search-box.js'), import('./search.js')]).then(([s, o]) => {
    parts.set({ Settings: s.Settings, offerImport: s.offerImport, Onboarding: o.Onboarding });
  });
  return loading;
}

const params = new URLSearchParams(location.search);
/** Where to go after signing in: only the web app, never an arbitrary URL. */
const NEXT = params.get('next') === '/app/' ? '/app/' : null;
/** Sent from the web app's Settings to add an email. */
const ADD = params.get('add') === '1';

/** A NUSMods link shared to the installed web app (manifest share_target). */
function sharedLink() {
  const text = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');
  return text.match(/https:\/\/nusmods\.com\/timetable\/\S+/)?.[0] ?? null;
}

/**
 * What the page shows: `loading`, `signin`, `onboarding`, `settings` or
 * `error`; `me` once signed in (from /me); `adding` while an anonymous
 * account adds an email (the sign-in card, over Settings).
 */
const page = store({ view: 'loading', me: null, adding: false, error: null });
const set = (patch) => page.set((s) => ({ ...s, ...patch }));

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  await forgetAccountHere();
  location.reload();
}

const startAdding = () => {
  set({ adding: true });
  window.scrollTo(0, 0);
};

/* ---------- signing in ---------- */

/** Cloudflare Turnstile, when the server has a site key. The widget is invisible, so its box takes no room. */
function useTurnstile(box) {
  const token = useRef(null);
  const widget = useRef(null);
  const [present, setPresent] = useState(false);
  useEffect(() => {
    let gone = false;
    (async () => {
      const { turnstileSiteKey } = await api('/api/auth/config').catch(() => ({}));
      if (!turnstileSiteKey || gone) return;
      if (!window.turnstile) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          s.onload = resolve;
          s.onerror = reject;
          document.head.append(s);
        }).catch(() => {});
      }
      if (gone || !window.turnstile || !box.current) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: turnstileSiteKey,
        // The server accepts a pass only for this action (TURNSTILE_ACTION).
        action: 'signin',
        callback: (v) => (token.current = v),
        'expired-callback': () => (token.current = null),
      });
      setPresent(true);
    })();
    return () => {
      gone = true;
    };
  }, []);
  const reset = () => {
    token.current = null;
    if (widget.current != null) window.turnstile?.reset(widget.current);
  };
  return { token, reset, present };
}

function SignIn({ adding }) {
  const box = useRef(null);
  const turnstile = useTurnstile(box);
  const [step, setStep] = useState('login');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeBox = useRef(null);
  const emailBox = useRef(null);
  const sendLabel = adding ? t('Email me a code') : t('Email me a sign-in code');

  useEffect(() => {
    (step === 'sent' ? codeBox : emailBox).current?.focus();
  }, [step]);

  const send = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // From the web app: the emailed link brings them back to it too.
      await api('/api/auth/login', { method: 'POST', body: { email: email.trim(), turnstile: turnstile.token.current, ...(NEXT ? { next: NEXT } : {}) } });
      setCode('');
      setCodeError('');
      setStep('sent');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      turnstile.reset();
    }
  };

  const verify = async (value = code) => {
    setCodeError('');
    setBusy(true);
    try {
      await api('/api/auth/code', { method: 'POST', body: { email: email.trim(), code: value } });
      // The session cookie is set; start over as signed in.
      location.reload();
    } catch (err) {
      setCodeError(err.message);
      setBusy(false);
      codeBox.current?.select();
    }
  };

  // Without an email: the same account an app starts with, kept by this browser.
  const noEmail = async () => {
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/anon/web', { method: 'POST', body: { turnstile: turnstile.token.current } });
      // The session cookie is set; start over, which sets up first.
      location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      turnstile.reset();
    }
  };

  return html`
    <section class="signin">
      <div class="card signin-card">
        <div hidden=${step !== 'login'}>
          ${adding ? html`<img class="signin-mark" src="/assets/mark.svg" alt="" />` : html`<${Livery} />`}
          <h1>${adding ? t('Add an email') : t('Sign in to terminus')}</h1>
          <p class="hint">
            ${adding
              ? t("We'll send you a code. Your settings are kept. If this email already has an account, you'll be switched to it.")
              : t("Enter your email and we'll send you a code. No password, and the same code creates an account if you're new.")}
          </p>
          <form onSubmit=${send}>
            <label for="login-email">${t('Email')}</label>
            <input
              id="login-email"
              ref=${emailBox}
              type="email"
              autocomplete="email"
              placeholder="you@u.nus.edu"
              required
              aria-invalid=${error ? 'true' : undefined}
              aria-describedby="login-error"
              value=${email}
              onInput=${(e) => setEmail(e.currentTarget.value)}
            />
            <div class="turnstile" ref=${box}></div>
            <button type="submit" class="btn accent wide" disabled=${busy}>${busy ? t('Sending…') : sendLabel}</button>
          </form>
          <p class="form-error" id="login-error" role="alert">${error}</p>
          ${!adding &&
          html`<div>
            <p class="signin-or"><span>${t('or')}</span></p>
            <button type="button" class="btn ghost wide" disabled=${busy} onClick=${noEmail}>${t('Use terminus without an email')}</button>
            <p class="hint small">${t("Your setup stays in this browser. Add an email any time to use it on your other devices, or to keep it if this browser's data is cleared.")}</p>
          </div>`}
          ${adding &&
          html`<button
            type="button"
            class="btn ghost wide"
            onClick=${() => {
              // Came from the web app to add it: back there.
              if (NEXT) return location.assign(NEXT);
              set({ adding: false });
            }}
          >${t('Cancel')}</button>`}
        </div>

        <div id="sent-step" hidden=${step !== 'sent'}>
          <div class="sent-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          </div>
          <h1>${t('Check your inbox')}</h1>
          <p class="hint" id="sent-hint"><${Fill} text=${t('We sent a code to {0}. Type it here, or open the link in the same email on this device. Both work once, for 15 minutes.', MARK)} parts=${[html`<strong>${email}</strong>`]} /></p>
          <form
            onSubmit=${(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <label for="code-input">${t('Code')}</label>
            <input
              id="code-input"
              ref=${codeBox}
              class="code-input"
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="7"
              placeholder="K7QX4M"
              required
              aria-invalid=${codeError ? 'true' : undefined}
              aria-describedby="code-error sent-hint code-auto"
              value=${code}
              onInput=${(e) => {
                const v = e.currentTarget.value;
                setCode(v);
                // The sixth letter or digit, typed or pasted, sends the code.
                if (v.replace(/[^a-z0-9]/gi, '').length === 6 && !busy) verify(v);
              }}
            />
            <p class="hint small" id="code-auto">${t('It signs you in as soon as the sixth character is typed.')}</p>
            <button type="submit" class="btn accent wide" disabled=${busy}>${t('Sign in')}</button>
          </form>
          <p class="form-error" id="code-error" role="alert">${codeError}</p>
          <p class="hint small">
            <${Fill}
              text=${t('No email after a minute? Check spam, or {0}.', MARK)}
              parts=${[
                html`<button
                  type="button"
                  class="link-btn"
                  onClick=${() => {
                    // Resending needs a fresh Turnstile pass, so it goes back to the form,
                    // saying so only when there's a check to do.
                    setStep('login');
                    setError(turnstile.present ? t('Complete the check below, then send again.') : '');
                  }}
                >${t('send another')}</button>`,
              ]}
            />
          </p>
          <button
            type="button"
            class="btn ghost wide"
            onClick=${() => {
              setStep('login');
              requestAnimationFrame(() => emailBox.current?.select());
            }}
          >${t('Use a different email')}</button>
        </div>
      </div>
      <${Rich} as="p" class="hint center" text=${t('By continuing you agree to the <a href="/privacy">privacy policy</a>.')} />
    </section>
  `;
}

/* ---------- signed in ---------- */

/** "Your widget right now": /me/next as the widget shows it, so changes in Settings show up. */
function Preview({ me }) {
  const [a, setA] = useState(null);
  const [failed, setFailed] = useState(false);
  const saved = useStore(saves);
  const load = async () => {
    try {
      const answer = await api(`/api/me/next${hour12() ? '?h12=1' : ''}`);
      if (answer?.walkSpeedMs) walkSpeed.set(answer.walkSpeedMs);
      setA(answer);
      setFailed(false);
    } catch {
      setA(null);
      setFailed(true);
    }
  };
  useEffect(() => {
    load();
  }, [saved]);
  useInterval(() => document.visibilityState === 'visible' && load(), 60_000);
  return html`
    <section class="side-preview">
      <p class="eyebrow">${t('Your widget right now')}</p>
      ${a
        ? html`<${Card} a=${a} onAnswer=${setA} onChoice=${load} chips />`
        : failed
          ? html`<${Message} text=${t('Preview unavailable right now.')}><button type="button" class="link-btn" onClick=${load}>${t('Try again')}</button><//>`
          : html`<${Message} text="…" quiet />`}
      <${Report} answer=${a} anonymous=${me.anonymous === true} email=${me.email ?? null} onAddEmail=${startAdding} />
    </section>
  `;
}

/** The header's right side: who's signed in, the app, and Sign out or Add an email. */
function Who() {
  const { view, me } = useStore(page);
  if (view !== 'settings' || !me) return null;
  return html`
    <span class="hint hide-sm">${me.email ?? t('No email')}</span>
    <a class="btn small accent open-app" href="/app/">${t('Open the app')}</a>
    ${me.anonymous === true
      ? html`<button type="button" class="btn small ghost" id="add-email" onClick=${startAdding}>${t('Add an email')}</button>`
      : html`<button type="button" class="btn small ghost" id="logout" onClick=${signOut}>${t('Sign out')}</button>`}
  `;
}

function AccountPage() {
  const { view, me, adding, error } = useStore(page);
  const p = useStore(parts);
  if (view === 'loading') return null;
  if (view === 'error') return html`<p class="hint">${t('Something went wrong. {0}', error)}</p>`;
  if (view === 'signin') return html`<${SignIn} adding=${false} />`;
  // Signed in, the parts are loaded before the view changes (start).
  if (!p) return null;
  const { Onboarding, Settings } = p;
  // The toast too: setup says there when it couldn't be saved.
  if (view === 'onboarding') return html`<${Onboarding} onDone=${afterSetup} /><${Toast} />`;
  return html`
    ${adding && html`<${SignIn} adding=${true} />`}
    <div id="app" hidden=${adding}>
      <${Settings} me=${me} side=${html`<${Preview} me=${me} />`} onAddEmail=${startAdding} onSignOut=${signOut} />
    </div>
    <${Toast} />
  `;
}

/** After first-time setup (or straight after sign-in): where the person was going. */
function afterSetup() {
  const { me } = page.get();
  // From the web app to add an email: straight to the sign-in card.
  if (ADD && me.anonymous === true) return set({ view: 'settings', adding: true });
  const shared = sharedLink();
  // Signed in from the web app: back to it.
  if (NEXT && !shared) return location.replace(NEXT);
  set({ view: 'settings' });
  if (shared) {
    history.replaceState(null, '', location.pathname);
    parts.get().offerImport(shared);
  }
}

async function start() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) {
      // Signed out, or deleted, elsewhere: what this browser kept of it goes.
      forgetAccountHere();
      set({ view: 'signin' });
      // Ready by the time they've signed in, without holding up the card.
      if (document.readyState === 'complete') loadParts();
      else addEventListener('load', () => loadParts(), { once: true });
      return;
    }
    throw err;
  }
  await Promise.all([loadProfile(), loadCampus(), loadParts()]);
  set({ me });
  // First sign-in: set up before Settings appears, and before the header's
  // buttons, which would only distract from it.
  if (me.onboarding === 'full') return set({ view: 'onboarding' });
  afterSetup();
}

render(html`<${AccountPage} />`, document.getElementById('root'));
render(html`<${Who} />`, document.getElementById('who'));
start().catch((err) => set({ view: 'error', error: err.message }));
