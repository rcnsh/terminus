import { Fill, MARK, Rich, html, render, store, useEffect, useInterval, useRef, useState, useStore } from '../assets/ui.js';
import { api, forgetAccountHere, hour12, t } from './dom.js';
import { Card, Message, Report } from './preview.js';
import { Toast, campusRefused, loadCampus, loadProfile, saves, walkSpeed } from './profile.js';
import { Livery } from './livery.js';

const parts = store(null);
let loading = null;
function loadParts() {
  loading ??= Promise.all([
    import('./settings.js'),
    import('./onboarding.js'),
    import('./settings-pages.js'),
    import('./search-box.js'),
    import('./search.js'),
  ]).then(([s, o]) => {
    parts.set({ Settings: s.Settings, Onboarding: o.Onboarding });
  });
  return loading;
}

const params = new URLSearchParams(location.search);
const NEXT = params.get('next') === '/app/' ? '/app/' : null;
const ADD = params.get('add') === '1';

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
      await api('/api/auth/login', {
        method: 'POST',
        body: { email: email.trim(), turnstile: turnstile.token.current, ...(NEXT ? { next: NEXT } : {}) },
      });
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
      location.reload();
    } catch (err) {
      setCodeError(err.message);
      setBusy(false);
      codeBox.current?.select();
    }
  };

  const noEmail = async () => {
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/anon/web', { method: 'POST', body: { turnstile: turnstile.token.current } });
      location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      turnstile.reset();
    }
  };

  return html`
    <section class="signin">
      <${Livery} mark=${false} />
      <div class="signin-step" hidden=${step !== 'login'}>
        <div class="signin-intro">
          <h1>${adding ? t('Add an email') : t('Sign in to terminus')}</h1>
          <p class="hint">
            ${
              adding
                ? t("We'll send you a code. Your settings are kept. If this email already has an account, you'll be switched to it.")
                : t("Enter your email and we'll send you a code. No password, and the same code creates an account if you're new.")
            }
          </p>
        </div>
        <div class="signin-form">
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
          ${
            !adding &&
            html`<p class="signin-alt">
              <${Fill}
                text=${t('No email? {0}', MARK)}
                parts=${[
                  html`<button type="button" class="link-btn" disabled=${busy} onClick=${noEmail}>${t('Use terminus in this browser only')}</button>`,
                ]}
              />
            </p>`
          }
          ${
            adding &&
            html`<button
            type="button"
            class="btn ghost wide"
            onClick=${() => {
              if (NEXT) return location.assign(NEXT);
              set({ adding: false });
            }}
          >${t('Cancel')}</button>`
          }
          <${Rich} as="p" class="hint small" text=${t('By continuing you agree to the <a href="/privacy">privacy policy</a>.')} />
        </div>
      </div>

      <div class="signin-step" id="sent-step" hidden=${step !== 'sent'}>
        <div class="signin-intro">
          <div class="sent-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          </div>
          <h1>${t('Check your inbox')}</h1>
          <p class="hint" id="sent-hint"><${Fill} text=${t('We sent a code to {0}. Type it here, or open the link in the same email on this device. Both work once, for 15 minutes.', MARK)} parts=${[html`<strong>${email}</strong>`]} /></p>
        </div>
        <div class="signin-form">
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
    </section>
  `;
}

const latest = store({ a: null, load: null });

export function Preview({ me }) {
  const { a } = useStore(latest);
  const setA = (x) => latest.set({ a: x, load });
  const [failed, setFailed] = useState(false);
  const saved = useStore(saves);
  const asked = useRef(0);
  const load = async () => {
    const n = ++asked.current;
    try {
      const answer = await api(`/api/me/next${hour12() ? '?h12=1' : ''}`);
      if (n !== asked.current) return;
      if (answer?.walkSpeedMs) walkSpeed.set(answer.walkSpeedMs);
      setA(answer);
      setFailed(false);
    } catch {
      if (n !== asked.current) return;
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
      ${
        a
          ? html`<${Card} a=${a} onAnswer=${setA} onChoice=${load} chips />`
          : failed
            ? html`<${Message} text=${t('Preview unavailable right now.')}><button type="button" class="link-btn" onClick=${load}>${t('Try again')}</button><//>`
            : html`<${Message} text="…" quiet />`
      }
      <${Report} answer=${a} anonymous=${me.anonymous === true} email=${me.email ?? null} onAddEmail=${startAdding} />
    </section>
  `;
}

function Peek() {
  const { a, load } = useStore(latest);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const key = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  if (!a) return null;
  return html`
    <div class=${open ? 'peek open' : 'peek'} onClick=${(e) => e.target === e.currentTarget && setOpen(false)}>
      ${open && html`<div class="peek-card"><${Card} a=${a} onAnswer=${(x) => latest.set({ a: x, load })} onChoice=${load} chips /></div>`}
      <button type="button" class="peek-bar" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <span class="peek-text"><span class="eyebrow">${t('Your widget right now')}</span><span class="peek-title">${a.card?.line ?? a.card?.title ?? a.label}</span></span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d=${open ? 'm6 9 6 6 6-6' : 'm6 15 6-6 6 6'} /></svg>
      </button>
    </div>
  `;
}

function Who() {
  const { view, me } = useStore(page);
  if (view !== 'settings' || !me) return null;
  return html`
    <span class="hint hide-sm">${me.email ?? t('No email')}</span>
    <a class="btn small accent open-app" href="/app/">${t('Open the app')}</a>
    ${
      me.anonymous === true
        ? html`<button type="button" class="btn small ghost" id="add-email" onClick=${startAdding}>${t('Add an email')}</button>`
        : html`<button type="button" class="btn small ghost" id="logout" onClick=${signOut}>${t('Sign out')}</button>`
    }
  `;
}

function AccountPage() {
  const { view, me, adding, error } = useStore(page);
  const p = useStore(parts);
  if (view === 'loading') return null;
  if (view === 'error') return html`<p class="hint">${t('Something went wrong. {0}', error)}</p>`;
  if (view === 'signin') return html`<${SignIn} adding=${false} />`;
  if (!p) return null;
  const { Onboarding, Settings } = p;
  if (view === 'onboarding') return html`<${Onboarding} onDone=${afterSetup} /><${Toast} />`;
  return html`
    ${adding && html`<${SignIn} adding=${true} />`}
    <div id="app" hidden=${adding}>
      <${Settings} me=${me} side=${html`<${Preview} me=${me} />`} Peek=${Peek} onAddEmail=${startAdding} onSignOut=${signOut} />
    </div>
    <${Toast} />
  `;
}

function afterSetup() {
  const { me } = page.get();
  if (ADD && me.anonymous === true) return set({ view: 'settings', adding: true });
  if (NEXT) return location.replace(NEXT);
  set({ view: 'settings' });
}

async function start() {
  let me;
  try {
    me = await api('/api/me');
  } catch (err) {
    if (err.status === 401) {
      forgetAccountHere();
      set({ view: 'signin' });
      const warm = () => loadParts().catch(() => {});
      if (document.readyState === 'complete') warm();
      else addEventListener('load', warm, { once: true });
      return;
    }
    throw err;
  }
  await Promise.all([loadProfile(), loadCampus(), loadParts()]);
  set({ me });
  if (me.onboarding === 'full') return set({ view: 'onboarding' });
  afterSetup();
}

render(html`<${AccountPage} />`, document.getElementById('root'));
render(html`<${Who} />`, document.getElementById('who'));
campusRefused.subscribe((refused) => {
  if (!refused) return;
  forgetAccountHere();
  set({ view: 'signin' });
});

start().catch((err) => set({ view: 'error', error: err.message }));
