// Account page: signing in, first-time setup, then settings (settings.js).
// Same origin as the API, so the session cookie just works.

import { runOnboarding } from './onboarding.js';
import { $, api, el, t } from './dom.js';
import { renderPreview, wireReport } from './preview.js';
import { mountSettings, offerImport, onboardingCtx, render, renderLists } from './settings.js';

/* ---------- sign in ---------- */

let turnstileToken = null;
/** Using terminus without an email (this browser's account). */
let anonymous = false;

async function setupTurnstile() {
  const { turnstileSiteKey } = await api('/auth/config').catch(() => ({}));
  if (!turnstileSiteKey) return;
  await new Promise((resolve, reject) => {
    const s = el('script', { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', onload: resolve, onerror: reject });
    document.head.append(s);
  });
  window.turnstile.render('#turnstile-box', {
    sitekey: turnstileSiteKey,
    callback: (t) => (turnstileToken = t),
    'expired-callback': () => (turnstileToken = null),
  });
}

async function sendLink(email) {
  // From the web app: the emailed link brings them back to it too.
  return api('/auth/login', { method: 'POST', body: { email, turnstile: turnstileToken, ...(NEXT ? { next: NEXT } : {}) } });
}

function resetTurnstile() {
  turnstileToken = null;
  if (typeof window.turnstile?.reset === 'function') window.turnstile.reset('#turnstile-box');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-msg');
  const btn = e.target.querySelector('button');
  const email = $('#login-email').value.trim();
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = t('Sending…');
  try {
    await sendLink(email);
    $('#sent-to').textContent = email;
    $('#code-input').value = '';
    $('#code-msg').textContent = '';
    $('#login-step').hidden = true;
    $('#sent-step').hidden = false;
    $('#code-input').focus();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
    btn.textContent = anonymous ? t('Email me a code') : t('Email me a sign-in code');
    resetTurnstile();
  }
});

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#code-msg');
  const btn = e.target.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  try {
    await api('/auth/code', { method: 'POST', body: { email: $('#sent-to').textContent, code: $('#code-input').value } });
    // The session cookie is set; start over as signed in.
    location.reload();
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
    $('#code-input').select();
  }
});

// The sixth letter or digit, typed or pasted, sends the code.
$('#code-input').addEventListener('input', (e) => {
  const clean = e.target.value.replace(/[^a-z0-9]/gi, '');
  if (clean.length === 6 && !$('#code-form button').disabled) $('#code-form').requestSubmit();
});

$('#different').addEventListener('click', () => {
  $('#sent-step').hidden = true;
  $('#login-step').hidden = false;
  $('#login-email').select();
});

// Resending needs a fresh Turnstile pass, so it goes back to the form.
$('#resend').addEventListener('click', () => {
  $('#sent-step').hidden = true;
  $('#login-step').hidden = false;
  $('#login-msg').textContent = t('Complete the check below, then send again.');
});

// Without an email: the same account an app starts with, kept by this browser.
$('#no-email').addEventListener('click', async (e) => {
  const err = $('#login-msg');
  err.textContent = '';
  e.target.disabled = true;
  try {
    await api('/auth/anon/web', { method: 'POST', body: { turnstile: turnstileToken } });
    // The session cookie is set; start over, which sets up first.
    location.reload();
  } catch (e2) {
    err.textContent = e2.message;
    e.target.disabled = false;
    resetTurnstile();
  }
});

// Adding an email to it later: the sign-in card, which keeps this setup
// when the email is new (or switches to the email's account if it has one).
$('#add-email').addEventListener('click', async () => {
  $('#login-step h1').textContent = t('Add an email');
  $('#login-step .hint').textContent = t("We'll send you a code. Your settings are kept. If this email already has an account, you'll be switched to it.");
  $('#login-form button').textContent = t('Email me a code');
  $('#no-email-box').hidden = true;
  $('#cancel-add').hidden = false;
  $('#app').hidden = true;
  $('#signin').hidden = false;
  window.scrollTo(0, 0);
  if (!turnstileToken && !document.querySelector('#turnstile-box iframe')) await setupTurnstile().catch(() => {});
  $('#login-email').focus();
});

$('#cancel-add').addEventListener('click', () => {
  // Came from the web app to add it: back there.
  if (NEXT) return location.assign(NEXT);
  $('#signin').hidden = true;
  $('#app').hidden = false;
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ---------- start ---------- */

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

async function start() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    if (err.status === 401) {
      $('#signin').hidden = false;
      await setupTurnstile().catch(() => {});
      return;
    }
    throw err;
  }
  $('#email').textContent = me.email ?? t('No email');
  anonymous = me.anonymous === true;
  if (anonymous) {
    // Signing out would leave no way back in, so it's Add an email instead.
    $('#logout').hidden = true;
    $('#add-email').hidden = false;
  }

  await mountSettings($('#app'), { me, onChange: renderPreview, onAddEmail: () => $('#add-email').click(), onSignOut: () => $('#logout').click() });

  // First sign-in: set up before the settings appear, and before the
  // header's buttons, which would only distract from it.
  if (me.onboarding === 'full') {
    await runOnboarding(onboardingCtx);
    render();
  }
  $('#who').hidden = false;

  // From the web app to add an email: straight to the sign-in card.
  if (ADD && anonymous) {
    $('#add-email').click();
    return;
  }
  // Signed in from the web app: back to it (after first-time setup, above).
  if (NEXT && !sharedLink()) {
    location.replace(NEXT);
    return;
  }

  $('#app').hidden = false;
  const shared = sharedLink();
  if (shared) {
    history.replaceState(null, '', location.pathname);
    offerImport(shared);
  }
  wireReport();
  await Promise.all([renderLists(), renderPreview()]);
  setInterval(() => document.visibilityState === 'visible' && renderPreview(), 60_000);
}

start().catch((err) => {
  document.querySelector('main').append(el('p', { class: 'hint', textContent: t('Something went wrong. {0}', err.message) }));
});
