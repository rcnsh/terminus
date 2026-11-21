import {
  Icon,
  focusSoon,
  html,
  reducedMotion,
  useEffect,
  useHash,
  useLayoutEffect,
  useMedia,
  useRef,
  useState,
  useStore,
} from '../assets/ui.js';
import { api, forgetAccountHere, t } from './dom.js';
import { edit, lists, profile, reloadProfile, stopName } from './profile.js';
import {
  About,
  Account,
  Appearance,
  Devices,
  Feedback,
  Favourites,
  Language,
  Page,
  Timetable,
  Trips,
  deviceCount,
  importDone,
  importOffer,
  theme,
} from './settings-pages.js';
import { cardStyle, styleName } from './journey.js';
import { Band } from './sky.js';

const GROUPS = [['trips', 'timetable', 'favourites', 'notifications'], ['language', 'appearance', 'devices'], ['feedback']];
const ICONS = {
  trips: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  timetable: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  favourites: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  notifications: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/>',
  language:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>',
  appearance: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor"/>',
  devices: '<rect x="3" y="5" width="12.5" height="10" rx="1.5"/><path d="M6 19h6.5"/><rect x="17.5" y="9" width="4" height="10" rx="1"/>',
  feedback: '<path d="M4.5 5.5h15v10h-8l-4 3.5v-3.5h-3z"/>',
};
const CHEVRON = '<path d="m9 6 6 6-6 6" />';
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
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  await forgetAccountHere();
  location.reload();
}

const addEmailFromApp = () => location.assign('/account/?add=1&next=/app/');

export function offerImport(link) {
  importOffer.set(link);
}

const paceName = (p) => ({ slow: t('Slow'), normal: t('Normal'), fast: t('Fast') })[p.walkPace ?? 'normal'] ?? t('Normal');

function summaries({ p, me, notifyOn, devices, imported }) {
  const pace = paceName(p);
  const home = p.home?.stops?.[0];
  const classes = p.trips.length + p.manual.length;
  return {
    trips: home ? `${stopName(home)} · ${t('{0} pace', pace)}` : t('Choose your stop'),
    timetable:
      me.needsReimport && !imported
        ? t('Re-import needed')
        : classes === 0
          ? t('Import from NUSMods')
          : classes === 1
            ? t('1 class')
            : t('{0} classes', classes),
    favourites: p.places.map((x) => x.label).join(', ') || t('None yet'),
    notifications: notifyOn ? t('On for this device') : t('Off'),
    devices: me.anonymous
      ? t('Add an email to use other devices')
      : devices === null
        ? ''
        : devices === 1
          ? t('1 device')
          : t('{0} devices', devices),
    language: [
      { en: 'English', zh: '中文' }[window.i18n?.pref()] ?? t('Follow this browser'),
      { 12: t('12-hour'), 24: t('24-hour') }[p.clock],
    ]
      .filter(Boolean)
      .join(' · '),
    account: me.email ?? t('No email'),
    feedback: t("Tell us what's wrong, or what you'd like"),
    appearance: `${{ auto: t('Auto'), light: t('Light'), dark: t('Dark') }[theme.get()] ?? t('Auto')} · ${styleName(cardStyle.get())}`,
  };
}

export function Settings({
  me,
  inApp = false,
  Notify = null,
  notifyOn = false,
  side = null,
  Peek = null,
  sky = false,
  onAddEmail = addEmailFromApp,
  onSignOut = signOut,
}) {
  const p = useStore(profile);
  const devices = useStore(deviceCount);
  const imported = useStore(importDone) > 0;
  const offer = useStore(importOffer);
  useStore(theme);
  useStore(cardStyle);
  const wide = useMedia('(min-width: 800px)');
  const roomy = useMedia('(min-width: 1100px)');
  const rail = Boolean(side) && roomy;
  const hash = useHash();
  const listHash = inApp ? '#settings' : '';
  const pageHash = inApp ? '#settings/' : '#';
  const groups = GROUPS.map((g) => g.filter((x) => x !== 'notifications' || Notify));
  const pages = ['account', ...groups.flat(), ...FOOT];

  useEffect(() => {
    const mine = window.i18n?.followAccount(profile.get().lang ?? 'auto');
    if (mine) edit((x) => (x.lang = mine));
  }, []);

  const named = hash.startsWith(pageHash) ? hash.slice(pageHash.length) : '';
  const inAddress = pages.includes(named) ? named : null;
  const elsewhere = Boolean(listHash) && !hash.startsWith(listHash);
  const want = inAddress ?? (wide ? 'trips' : null);

  const away = useRef(false);
  away.current = elsewhere;
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'visible' || away.current) return;
      reloadProfile().catch(() => {});
      lists.set((n) => n + 1);
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);

  const root = useRef(null);
  const side_ = useRef(null);
  const nodes = useRef({}).current;
  const rows = useRef({}).current;
  const [view, setView] = useState({ shown: want, leaving: null });
  const listScroll = useRef(0);
  const pushed = useRef(false);
  const sliding = useRef([]);
  const swipedTo = useRef(0);

  useEffect(() => {
    if (elsewhere || want === view.shown) return;
    for (const a of sliding.current) a.finish();
    sliding.current = [];
    const prev = view.shown;
    const from = window.scrollY;
    if (wide) {
      setView({ shown: want, leaving: null });
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
    const outFrames = reduce
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { transform: start, opacity: 1 },
          { transform: gone, opacity: forward ? 0 : 1 },
        ];
    const inFrames = reduce
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { transform: forward ? 'translateX(100%)' : 'translateX(-25%)', opacity: forward ? 1 : 0 },
          { transform: 'none', opacity: 1 },
        ];
    const a = out.animate(outFrames, timing);
    const b = into.animate(inFrames, timing);
    sliding.current = [a, b];
    a.finished.catch(() => {}).finally(() => setView((v) => (v.leaving === l ? { ...v, leaving: null } : v)));
    if (view.shown) document.getElementById(`page-${view.shown}`)?.focus({ preventScroll: true });
    else rows[l.prev]?.focus({ preventScroll: true });
  }, [view]);

  const openPage = (x) => {
    pushed.current = true;
    location.hash = pageHash + x;
  };

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

  useEffect(() => {
    if (offer && view.shown !== 'timetable') openPage('timetable');
  }, [offer]);

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
        page.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], {
          duration: reducedMotion() ? 0 : 200,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        });
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
  const skyHere = sky;
  useEffect(() => {
    document.body.classList.toggle('set-sky', skyHere);
    return () => document.body.classList.remove('set-sky');
  }, [skyHere]);
  const sum = summaries({ p, me, notifyOn, devices, imported });
  const todo = {
    trips: !p.home?.stops?.length,
    timetable: (me.needsReimport && !imported) || p.trips.length + p.manual.length === 0,
  };
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
    <div class=${['settings', shown !== null && 'page-open', rail && 'has-rail'].filter(Boolean).join(' ')} ref=${root}>
      <div class=${onSide ? 'settings-side leaving' : 'settings-side'} style=${onSide ? { top: `${leaving.shift}px` } : undefined} ref=${side_}>
        ${!rail && side}
        ${
          skyHere
            ? html`<${Band}><h1 class="settings-title">${t('Settings')}</h1><//>`
            : html`<h1 class="settings-title">${t('Settings')}</h1>`
        }
        <nav class="settings-groups" aria-label=${t('Settings')}>
          ${account}
          ${groups.map(
            (g, i) => html`<div class="set-group" key=${i}>
              ${g.map(
                (id) => html`<button
                  type="button"
                  class="settings-row set-item"
                  data-page=${id}
                  key=${id}
                  ref=${(n) => (rows[id] = n)}
                  aria-current=${shown === id ? 'page' : undefined}
                  onClick=${() => (shown === id ? null : openPage(id))}
                >
                  <span class="set-ico" aria-hidden="true"><${Icon} paths=${ICONS[id]} /></span>
                  <span class="row-text">
                    <span class="row-title">${TITLES[id]}</span>
                    <span class=${id === 'notifications' && !notifyOn ? 'row-sum off' : todo[id] ? 'row-sum todo' : 'row-sum'}>${sum[id]}</span>
                  </span>
                  <${Icon} paths=${CHEVRON} class="chev" />
                </button>`,
              )}
            </div>`,
          )}
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
      ${rail && html`<aside class="settings-rail">${side}</aside>`}
      ${Peek && !wide && shown && html`<${Peek} key=${shown} />`}
    </div>
  `;
}
