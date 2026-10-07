// Settings: the signed-in part of the account page (/account/), and the web
// app's Settings tab (/app/#settings). Your account, your day as a route
// down a card (home stop, classes, hours, pace), each stop a row, then the
// rest as tiles, each opening its page (settings-pages.js): one at a time
// on a phone, sliding in from the side; side by side on a wide screen. The
// address names the page (#trips, or #settings/trips in the web app), so
// Back and a reload keep it.

import { Icon, focusSoon, html, reducedMotion, useEffect, useHash, useLayoutEffect, useMedia, useRef, useState, useStore } from '../assets/ui.js';
import { api, clockOpts, forgetAccountHere, locale, spaced, t } from './dom.js';
import { edit, profile, stopName } from './profile.js';
import { About, Account, Appearance, Devices, Feedback, Favourites, Language, Page, Timetable, Trips, deviceCount, importDone, importOffer, theme } from './settings-pages.js';
import { cardStyle, styleName } from './journey.js';
import { Celestial, Horizon } from './sky.js';

/** The pages shown as tiles, two to a row, with their icons. */
const TILES = ['favourites', 'notifications', 'language', 'appearance', 'devices', 'feedback'];
const ICONS = {
  favourites: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  notifications: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  language: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  appearance: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  devices: '<rect x="3" y="5" width="12.5" height="10" rx="1.5"/><path d="M6 19h6.5"/><rect x="17.5" y="9" width="4" height="10" rx="1"/>',
  feedback: '<path d="M4.5 5.5h15v10h-8l-4 3.5v-3.5h-3z"/>',
};
const CHEVRON = '<path d="m9 6 6 6-6 6" />';
/** Pages opened from the links under the tiles. */
const FOOT = ['about'];
const TITLES = {
  trips: t('Your trips'),
  timetable: t('Timetable'),
  favourites: t('Favourites'),
  notifications: t('Notifications'),
  devices: t('Devices'),
  language: t('Language and time'),
  appearance: t('Appearance'),
  account: t('Account'),
  about: t('About'),
  feedback: t('Send feedback'),
};

async function signOut() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  await forgetAccountHere();
  location.reload();
}

/** The account page's sign-in card, then back to the web app. */
const addEmailFromApp = () => location.assign('/account/?add=1&next=/app/');

/** A NUSMods link shared to the app: Timetable, with it in the box, for the person to import. */
export function offerImport(link) {
  importOffer.set(link);
}

/** Minutes past midnight as a time of day, in the clock the person chose. */
const hm = (min) => spaced(new Date(2000, 0, 1, Math.floor(min / 60), min % 60).toLocaleTimeString(locale() ?? [], clockOpts()));

/** The walking pace chosen, in words: Normal until one is. */
const paceName = (p) => ({ slow: t('Slow'), normal: t('Normal'), fast: t('Fast') })[p.walkPace ?? 'normal'] ?? t('Normal');

/** What each group has set: a line under its name in the list. */
function summaries({ p, me, notifyOn, devices, imported }) {
  const pace = paceName(p);
  const home = p.home?.stops?.[0];
  const classes = p.trips.length + p.manual.length;
  return {
    trips: `${home ? stopName(home) : t('No home stop yet')} · ${t('{0} pace', pace)}`,
    timetable: me.needsReimport && !imported ? t('Re-import needed') : classes === 0 ? t('No classes yet') : classes === 1 ? t('1 class') : t('{0} classes', classes),
    favourites: p.places.map((x) => x.label).join(', ') || t('None yet'),
    notifications: notifyOn ? t('On for this device') : t('Off'),
    devices: me.anonymous ? t('Add an email to use other devices') : devices === null ? '' : devices === 1 ? t('1 device') : t('{0} devices', devices),
    language: [{ en: 'English', zh: '中文' }[window.i18n?.pref()] ?? t('Follow this browser'), { 12: t('12-hour'), 24: t('24-hour') }[p.clock]].filter(Boolean).join(' · '),
    account: me.email ?? t('No email'),
    feedback: t("Tell us what's wrong, or what you'd like"),
    appearance: `${{ auto: t('Auto'), light: t('Light'), dark: t('Dark') }[theme.get()] ?? t('Auto')} · ${styleName(cardStyle.get())}`,
  };
}

/**
 * Settings for the signed-in account `me` (from /me), once the profile and
 * /campus are loaded (profile.js). `inApp`: in the web app, which shows the
 * answer on Now, has no header (so Sign out is in Account), and keeps its tab
 * in the address. `Notify` (a component) is the app's "Notify me when to
 * leave", for Notifications, and `notifyOn` whether it's on. `side` goes above
 * the list (the account page's preview). `onAddEmail` and `onSignOut` are
 * Account's buttons; by default, the web app's. `sky`: the list's title and
 * each page's in a slim band of Now's sky, ending on the low hills (sky.js),
 * on a phone; the web app's.
 */
export function Settings({ me, inApp = false, Notify = null, notifyOn = false, side = null, sky = false, onAddEmail = addEmailFromApp, onSignOut = signOut }) {
  const p = useStore(profile);
  const devices = useStore(deviceCount);
  const imported = useStore(importDone) > 0;
  const offer = useStore(importOffer);
  useStore(theme);
  useStore(cardStyle);
  const wide = useMedia('(min-width: 900px)');
  const hash = useHash();
  const listHash = inApp ? '#settings' : '';
  const pageHash = inApp ? '#settings/' : '#';
  const tiles = TILES.filter((x) => x !== 'notifications' || Notify);
  const pages = ['account', 'trips', 'timetable', ...tiles, ...FOOT];

  // The account's language (phase 10): one chosen on another device is used
  // here; one chosen here before the account had one goes to the account.
  useEffect(() => {
    const mine = window.i18n?.followAccount(profile.get().lang ?? 'auto');
    if (mine) edit((x) => (x.lang = mine));
  }, []);

  /** The page the address names, if it's one shown here. */
  const named = hash.startsWith(pageHash) ? hash.slice(pageHash.length) : '';
  const inAddress = pages.includes(named) ? named : null;
  // Somewhere else in the web app (Now, Map): Settings stays as it is.
  const elsewhere = Boolean(listHash) && !hash.startsWith(listHash);
  const want = inAddress ?? (wide ? 'trips' : null);

  const root = useRef(null);
  const side_ = useRef(null);
  const nodes = useRef({}).current;
  const rows = useRef({}).current;
  /** The page on screen (null: the list), and the view sliding away. */
  const [view, setView] = useState({ shown: want, leaving: null });
  /** Where the list was scrolled to, for coming back to it. */
  const listScroll = useRef(0);
  /** Opened from the list here, so Back is the browser's. */
  const pushed = useRef(false);
  /** Slides under way, finished at once by the next change. */
  const sliding = useRef([]);
  /** How far a swipe back had moved the page when it was let go, in px. */
  const swipedTo = useRef(0);

  // The address changed: the page it names (or the list) takes over, sliding
  // on a phone while Settings is on screen.
  useEffect(() => {
    if (elsewhere || want === view.shown) return;
    for (const a of sliding.current) a.finish();
    sliding.current = [];
    const prev = view.shown;
    const from = window.scrollY;
    if (wide) {
      setView({ shown: want, leaving: null });
      // Side by side the list stays, but the focus goes to the page opened, as on a phone.
      if (want) focusSoon(() => document.getElementById(`page-${want}`));
      return;
    }
    if (want) listScroll.current = from;
    const to = want ? 0 : listScroll.current;
    const onScreen = !root.current?.closest('[hidden]') && document.visibilityState === 'visible';
    const leaving = onScreen ? { node: want ? 'side' : prev, forward: Boolean(want), shift: to - from, to, prev } : null;
    setView({ shown: want, leaving });
    if (!leaving) window.scrollTo(0, to);
  }, [want, elsewhere, wide]);

  // The old view slides away under the new one; `shift` keeps it where it was on screen.
  useLayoutEffect(() => {
    const l = view.leaving;
    if (!l || l.started) return;
    l.started = true;
    window.scrollTo(0, l.to);
    const out = l.node === 'side' ? side_.current : nodes[l.node];
    const into = view.shown ? nodes[view.shown] : side_.current;
    if (!out || !into) return setView((v) => ({ ...v, leaving: null }));
    const reduce = reducedMotion();
    const timing = { duration: reduce ? 150 : 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
    const forward = l.forward;
    const gone = forward ? 'translateX(-25%)' : 'translateX(100%)';
    const start = !forward && swipedTo.current ? `translateX(${swipedTo.current}px)` : 'none';
    swipedTo.current = 0;
    const outFrames = reduce ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: start, opacity: 1 }, { transform: gone, opacity: forward ? 0 : 1 }];
    const inFrames = reduce ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: forward ? 'translateX(100%)' : 'translateX(-25%)', opacity: forward ? 1 : 0 }, { transform: 'none', opacity: 1 }];
    const a = out.animate(outFrames, timing);
    const b = into.animate(inFrames, timing);
    sliding.current = [a, b];
    a.finished
      .catch(() => {})
      .finally(() => setView((v) => (v.leaving === l ? { ...v, leaving: null } : v)));
    // Focus follows: the page's heading, or the row it was opened from.
    if (view.shown) document.getElementById(`page-${view.shown}`)?.focus({ preventScroll: true });
    else rows[l.prev]?.focus({ preventScroll: true });
  }, [view]);

  const openPage = (x) => {
    pushed.current = true;
    location.hash = pageHash + x;
  };

  // Back to the list: the browser's Back when the page was opened here, so history stays in step.
  const closePage = () => {
    if (pushed.current) {
      pushed.current = false;
      history.back();
    } else if (listHash) {
      location.hash = listHash;
    } else {
      history.pushState(null, '', location.pathname + location.search);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  };

  // A NUSMods link shared to the app: its page, where the box has it.
  useEffect(() => {
    if (offer && view.shown !== 'timetable') openPage('timetable');
  }, [offer]);

  // Swiping from the left edge goes back, in the installed app on an iPhone:
  // it has no browser swipe of its own. The page follows the finger.
  useEffect(() => {
    if (navigator.standalone !== true || !root.current) return;
    const box = root.current;
    let start = null;
    const down = (e) => {
      const page = view.shown && !wide ? nodes[view.shown] : null;
      const tch = e.touches[0];
      start = page && e.touches.length === 1 && tch.clientX < 24 ? { x: tch.clientX, y: tch.clientY, page, dx: 0 } : null;
    };
    const move = (e) => {
      if (!start) return;
      const tch = e.touches[0];
      const dx = Math.max(0, tch.clientX - start.x);
      if (start.dx === 0 && Math.abs(tch.clientY - start.y) > dx) {
        start = null;
        return;
      }
      start.dx = dx;
      start.page.style.transform = `translateX(${dx}px)`;
    };
    const up = () => {
      if (!start) return;
      const { page, dx } = start;
      start = null;
      page.style.transform = '';
      if (dx > window.innerWidth / 3) {
        swipedTo.current = dx;
        closePage();
      } else if (dx > 0) {
        page.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: reducedMotion() ? 0 : 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
      }
    };
    box.addEventListener('touchstart', down, { passive: true });
    box.addEventListener('touchmove', move, { passive: true });
    box.addEventListener('touchend', up);
    box.addEventListener('touchcancel', up);
    return () => {
      box.removeEventListener('touchstart', down);
      box.removeEventListener('touchmove', move);
      box.removeEventListener('touchend', up);
      box.removeEventListener('touchcancel', up);
    };
  }, [view.shown, wide]);

  const shown = view.shown;
  const leaving = view.leaving;
  // A band of the sky at the top of the list and of each page, under it all
  // plain. set-sky tells Now's sky (sky.js) to colour the browser's bar for it.
  const skyHere = sky && !wide;
  useEffect(() => {
    document.body.classList.toggle('set-sky', skyHere);
    return () => document.body.classList.remove('set-sky');
  }, [skyHere]);
  const sum = summaries({ p, me, notifyOn, devices, imported });
  // Nothing imported, or a link for a semester that's over: Timetable asks, in the accent.
  const reimport = me.needsReimport && !imported;
  const noClasses = p.trips.length + p.manual.length === 0;
  const page = (id, body) => html`
    <${Page} id=${id} title=${TITLES[id]} nodes=${nodes} onBack=${closePage} shown=${shown === id} leaving=${leaving?.node === id ? leaving : null} sky=${skyHere}>${body}<//>
  `;
  const onSide = leaving?.node === 'side';
  const account = html`
    <button
      type="button"
      class="settings-row set-account"
      data-page="account"
      ref=${(n) => (rows.account = n)}
      aria-current=${shown === 'account' ? 'page' : undefined}
      onClick=${() => (shown === 'account' ? null : openPage('account'))}
    >
      ${me.email ? html`<span class="avatar" aria-hidden="true">${me.email.slice(0, 1).toUpperCase()}</span>` : html`<img class="avatar" src="/assets/mark.svg" alt="" />`}
      <span class="row-text"><span class="row-title">${sum.account}</span><span class=${me.anonymous ? 'row-sum add' : 'row-sum'}>${sum.devices}</span></span>
      <${Icon} paths=${CHEVRON} class="chev" />
    </button>
  `;

  return html`
    <div class=${shown !== null ? 'settings page-open' : 'settings'} ref=${root}>
      <div class=${onSide ? 'settings-side leaving' : 'settings-side'} style=${onSide ? { top: `${leaving.shift}px` } : undefined} ref=${side_}>
        ${side}
        ${skyHere
          ? html`<div class="page-band"><div class="sky-head"><${Celestial} band /><h1 class="settings-title">${t('Settings')}</h1></div><${Horizon} on=${null} low /></div>`
          : html`<h1 class="settings-title">${t('Settings')}</h1>`}
        <nav class="settings-groups" aria-label=${t('Settings')}>
          ${account}
          <section class="set-day" aria-labelledby="set-day-title">
            <h2 class="eyebrow" id="set-day-title">${t('Your day')}</h2>
            <div class="day-route">
              ${[
                ['trips', t('Home stop'), stopName(p.home?.stops?.[0] ?? '') || t('Choose your stop'), !p.home?.stops?.length],
                ['timetable', t('Timetable'), noClasses && !reimport ? t('Import from NUSMods') : sum.timetable, noClasses || reimport],
                ['trips', t('Show buses between'), `${hm(p.dayStartMin ?? 360)} – ${hm(p.dayEndMin ?? 1080)}`, false],
                ['trips', t('Walking pace'), paceName(p), false],
              ].map(
                ([id, label, value, todo], i) => html`<button
                  type="button"
                  class="settings-row day-stop"
                  key=${i}
                  ref=${i < 2 ? (n) => (rows[id] = n) : undefined}
                  aria-current=${shown === id ? 'page' : undefined}
                  onClick=${() => (shown === id ? null : openPage(id))}
                ><span class="day-dot" aria-hidden="true"></span><span class="row-text"><span class="row-sum">${label}</span><strong class=${todo ? 'todo' : undefined}>${value}</strong></span><${Icon} paths=${CHEVRON} class="chev" /></button>`,
              )}
            </div>
          </section>
          <div class="set-tiles">
            ${tiles.map(
              (id) => html`<button
                type="button"
                class="set-tile"
                data-page=${id}
                key=${id}
                ref=${(n) => (rows[id] = n)}
                aria-current=${shown === id ? 'page' : undefined}
                onClick=${() => (shown === id ? null : openPage(id))}
              >
                <${Icon} paths=${ICONS[id]} />
                <span class="row-title">${TITLES[id]}</span>
                <span class=${id === 'notifications' && !notifyOn ? 'row-sum off' : 'row-sum'}>${sum[id]}</span>
              </button>`,
            )}
          </div>
          <p class="settings-foot">
            ${FOOT.map(
              (id) => html`<a
                href=${pageHash + id}
                key=${id}
                ref=${(n) => (rows[id] = n)}
                aria-current=${shown === id ? 'page' : undefined}
                onClick=${(e) => {
                  e.preventDefault();
                  if (shown !== id) openPage(id);
                }}
              >${TITLES[id]}</a>`,
            )}
            <a href="/privacy">${t('Privacy')}</a>
            <a href="/status">${t('Status')}</a>
          </p>
        </nav>
      </div>
      <div class="settings-pages">
        ${page('trips', html`<${Trips} />`)}
        ${page('timetable', html`<${Timetable} me=${me} />`)}
        ${page('favourites', html`<${Favourites} />`)}
        ${Notify && page('notifications', html`<${Notify} />`)}
        ${page('devices', html`<${Devices} me=${me} />`)}
        ${page('language', html`<${Language} />`)}
        ${page('appearance', html`<${Appearance} />`)}
        ${page('account', html`<${Account} me=${me} inApp=${inApp} onAddEmail=${onAddEmail} onSignOut=${onSignOut} />`)}
        ${page('about', html`<${About} />`)}
        ${page('feedback', html`<${Feedback} me=${me} onAddEmail=${onAddEmail} />`)}
      </div>
    </div>
  `;
}
