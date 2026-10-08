// The Buses tab: what's coming at a stop, and where a service's buses are
// along its line. Loaded the first time the tab is opened (app.js).
//
// Its home is a row of pages you swipe between: the stop nearest you
// (/me/nearby), then each stop you've pinned (/arrivals). A service tapped on
// a board opens its line (/line), and a stop on the line opens its board.
// Where you are in the tab is in the address (#buses, #buses/stop/YIH,
// #buses/line/D1/YIH), so Back and a reload keep it.
//
// Only the times the API gives are shown: `later` is every later bus the
// feed reported, and a line shows no times at stops other than yours.

import { Fill, Icon, MARK, focusSoon, html, reducedMotion, store, useEffect, useLayoutEffect, useMemo, useRef, useStore } from '/assets/ui.js';
import { clock, send, serverNow, signedOut, t } from '/account/dom.js';
import { campus, edit, limit, loadCampus, profile, reloadProfile, toast } from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { Celestial, Horizon } from '/account/sky.js';
import { busesTabIndex } from '/account/search.js';
import { Big, Chip, Crowd, Quality, Row, colorOf, stoppedWords, svcVars, thenText } from '/app/board.js';

/** The page on screen refreshes this often (the API caches arrivals 15 s). */
const REFRESH_MS = 15_000;
/** As many stops as the profile keeps pinned (its `limits`; 8 before it has loaded). */
const pinMax = () => limit('pinnedStops', 8);
/**
 * Times fetched longer ago than this have missed a refresh at least:
 * counted down here from when they came, and no longer shown as live.
 */
const OLD_MS = 2 * REFRESH_MS;
/** "Runs until" shows for a service ending within this long. */
const ENDS_SOON_MS = 2 * 3600_000;

/* ---------- what's on screen ---------- */

/** Where in the tab: its home, a stop's board, or a service's line. From the address. */
const route = store({ kind: 'home' });
/** The stop nearest you: { status: 'loading' | 'ready' | 'none', code, distM, fromHome }. */
export const nearest = store({ status: 'loading' });
/**
 * Each stop's board as last fetched, by code: { stop, board, available, at,
 * got, asOf, error }. `at` is when this browser fetched it (Date.now(), for
 * fetching again) and `got` the same on the server's clock, which the times
 * are counted from: the server has counted them down to its own now.
 * `asOf` is when the feed's answer is from (its clock, ms), older than `got`
 * when it served one it had kept; it's only for "Updated 5 s ago".
 */
export const boards = store(new Map());
/** The stops showing the board across the road, by the page's own stop. */
export const across = store(new Set());
/** Which of the home's pages is on screen. */
const active = store(0);
/** A stop to scroll the home to, once it's drawn (a search result that has a page). */
const wantPage = store(null);
/** The line on screen: { key, data, at, got, asOf } or { key, error }. */
const line = store(null);
/** Now on the server's clock (dom.js), every few seconds, for "Updated 5 s ago". */
const tick = store(serverNow());
/** Location can be asked for (it isn't blocked), for the nearest stop. */
const canAsk = store(false);

/** app.js's here(): where the phone is, asking first only when told to. */
let locate = async () => null;

/* ---------- fetching ---------- */

async function getJSON(path) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
  if (res.status === 401) await signedOut();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const stopOf = (code) => campus.get()?.stops.find((s) => s.code === code) ?? null;
/** A stop as people say it ("Yusof Ishak House"), not its sign's short name ("YIH"). */
const longName = (s) => s?.longName ?? s?.name;
const stopName = (code) => longName(stopOf(code)) ?? code;
const pins = () => profile.get()?.pinnedStops ?? [];
/** The stop across the road from `code`, from its board, else the campus's map. */
export const oppositeOf = (code) => boards.get().get(code)?.stop?.opposite ?? stopOf(code)?.opposite ?? null;
/** The stop whose board a page shows: its own, or the one across the road. */
export const shownCode = (code) => (across.get().has(code) && oppositeOf(code)) || code;

/** When answer `data` is from, on the server's clock: its `asOf`, else now. */
const asOfMs = (data) => Date.parse(data?.asOf ?? '') || serverNow();

function keep(code, entry) {
  boards.set((m) => new Map(m).set(code, entry));
}

/** One stop's board. A failure keeps the board already there, saying it couldn't update. */
export async function loadBoard(code) {
  // The public buses there too, when the account has them on.
  const pub = profile.get()?.publicBuses ? '&public=1' : '';
  // A call that hung (the phone asleep) can end after a newer one: it
  // mustn't put back older times, or an error over fresh ones.
  const asked = Date.now();
  const newer = () => boards.get().get(code)?.at > asked;
  try {
    // stopped=1: the services not running now are listed too, greyed.
    const data = await getJSON(`/arrivals?stop=${encodeURIComponent(code)}${pub}&stopped=1`);
    if (newer()) return;
    keep(code, { stop: { ...data.stop, opposite: data.stop.opposite ?? stopOf(code)?.opposite ?? null }, board: data.board, available: data.available !== false, at: Date.now(), got: serverNow(), asOf: asOfMs(data) });
  } catch (err) {
    if (err.message === 'signed out' || newer()) return;
    const was = boards.get().get(code);
    keep(code, { ...was, error: navigator.onLine ? t('No times right now') : t('Live times need a connection.') });
  }
}

/**
 * The stop nearest you, with its board and the one across the road (both
 * come with /me/nearby). Uses your location only when it's already allowed,
 * unless `ask`; without it, /me/nearby starts from your home.
 */
async function findNearest({ ask = false } = {}) {
  const state = await navigator.permissions?.query({ name: 'geolocation' }).then((p) => p.state).catch(() => null);
  canAsk.set(Boolean(navigator.geolocation) && state !== 'denied');
  const at = await locate({ ask });
  if (ask && !at) toast(t('Location is off for this site. Search for a stop instead.'), { error: true });
  try {
    const q = `?${new URLSearchParams({ ...at, stopped: '1' })}`;
    const data = await getJSON(`/me/nearby${q}`);
    const first = data.stops?.[0];
    if (!first) return nearest.set({ status: 'none' });
    const asOf = asOfMs(data);
    const got = serverNow();
    for (const s of data.stops) keep(s.stop.code, { stop: { ...s.stop, opposite: s.opposite ?? null, oppositeAcross: s.oppositeAcross, oppositeName: s.oppositeName }, board: s.board, available: s.available, at: Date.now(), got, asOf });
    nearest.set({ status: 'ready', code: first.stop.code, distM: first.distM, fromHome: !at });
  } catch (err) {
    if (err.message === 'signed out') return;
    // 400: no location and no home. Offline: what was found before stays.
    if (err.status === 400 || nearest.get().status === 'loading') nearest.set({ status: 'none' });
  }
}

async function loadLine(svc, stop) {
  const key = `${svc}/${stop ?? ''}`;
  try {
    const data = await getJSON(`/line?svc=${encodeURIComponent(svc)}${stop ? `&stop=${encodeURIComponent(stop)}` : ''}`);
    if (lineKey() === key) line.set({ key, data, at: Date.now(), got: serverNow(), asOf: asOfMs(data) });
  } catch (err) {
    if (err.message === 'signed out' || lineKey() !== key) return;
    const was = line.get()?.key === key ? line.get() : null;
    const error = err.status === 400 ? t('No line to show for {0}.', svc) : navigator.onLine ? t('No times right now') : t('Live times need a connection.');
    line.set({ ...was, key, error });
  }
}
const lineKey = () => {
  const r = route.get();
  return r.kind === 'line' ? `${r.svc}/${r.stop ?? ''}` : null;
};

/* ---------- the home's pages ---------- */

/** Page 1 is the nearest stop (or finding it), then each pinned stop not already there. */
export function pagesOf(n, pinned) {
  const list = [n.status === 'ready' ? { kind: 'nearest', code: n.code } : { kind: n.status === 'loading' ? 'loading' : 'find' }];
  for (const code of pinned) if (code !== n.code) list.push({ kind: 'pinned', code });
  return list;
}
const homePages = () => pagesOf(nearest.get(), pins());

/** A timed refresh still on its way: the next one waits for it, rather than piling up on a slow connection. */
let pending = null;

/**
 * The board on screen, fetched again: the page shown, the stop's own page, or
 * the line. [back]: the tab shown again, which asks even with a call on its
 * way, as that call may have hung while the phone slept.
 */
function refresh({ back = false } = {}) {
  if (pending && !back) return;
  const mine = refreshNow()?.finally(() => {
    if (pending === mine) pending = null;
  });
  pending = mine;
}
function refreshNow() {
  const r = route.get();
  if (r.kind === 'line') return loadLine(r.svc, r.stop);
  const code = r.kind === 'stop' ? r.code : homePages()[active.get()]?.code;
  return code ? loadBoard(shownCode(code)) : null;
}

/** A board just brought on screen: fetched unless it's fresh. */
function showBoard(code) {
  if (!code) return;
  const b = boards.get().get(shownCode(code));
  if (!b?.at || Date.now() - b.at > REFRESH_MS) loadBoard(shownCode(code));
}

export async function togglePin(code) {
  if (!profile.get()) await reloadProfile().catch(() => {});
  if (!profile.get()) return toast(t("Couldn't pin that. Check your connection."), { error: true });
  if (pins().includes(code)) {
    edit((p) => {
      p.pinnedStops = (p.pinnedStops ?? []).filter((c) => c !== code);
    });
  } else if (pins().length >= pinMax()) {
    toast(t('You can pin up to {0} stops.', pinMax()), { error: true });
  } else {
    edit((p) => {
      p.pinnedStops = [...(p.pinnedStops ?? []), code];
    });
  }
}

/* ---------- moving around the tab ---------- */

export function parse(hash) {
  const [, kind, a, b] = hash.split('/').map(decodeURIComponent);
  if (kind === 'stop' && a) return { kind: 'stop', code: a };
  if (kind === 'line' && a) return { kind: 'line', svc: a, stop: b || null };
  return { kind: 'home' };
}

/** The addresses gone forward from in the tab, so its Back goes back rather than forward again. */
const trail = [];
function go(hash) {
  trail.push(location.hash);
  location.hash = hash;
}
function back(parent) {
  if (trail.length) {
    trail.pop();
    history.back();
  } else {
    location.hash = parent;
  }
}
function onHash() {
  if (!location.hash.startsWith('#buses')) return;
  // The browser's own Back, to where the tab came from.
  if (trail.at(-1) === location.hash) trail.pop();
  const next = parse(location.hash);
  if (JSON.stringify(next) === JSON.stringify(route.get())) return;
  route.set(next);
  window.scrollTo(0, 0);
  // What was focused (a row, Back) has gone with the page: its heading takes
  // it. On the home, the heading of the page it's back on (Home puts the
  // pager there before this runs), without scrolling the pager to it.
  if (location.hash.startsWith('#buses') && document.activeElement !== document.body) focusSoon(() => headOnScreen(next), { preventScroll: true });
  if (next.kind === 'stop') showBoard(next.code);
  else if (next.kind === 'line') loadLine(next.svc, next.stop);
}

/** The heading of what the tab shows: the home's page on screen, else the stop's or line's. */
function headOnScreen(r) {
  if (r.kind === 'home') {
    const pages = document.querySelectorAll('#tab-buses .bt-pages > .bt-page');
    const page = pages[Math.min(active.get(), pages.length - 1)];
    if (page) return page.querySelector('.bt-head');
  }
  return document.querySelector('#tab-buses .bt-head');
}

/** A stop picked: its page on the home if it has one, else its own. */
function openStop(code) {
  if (homePages().some((p) => p.code === code)) {
    wantPage.set(code);
    if (route.get().kind !== 'home') go('#buses');
  } else {
    go(`#buses/stop/${encodeURIComponent(code)}`);
  }
}
export const lineHash = (svc, stop) => `#buses/line/${encodeURIComponent(svc)}${stop ? `/${encodeURIComponent(stop)}` : ''}`;
export const stopParent = (code) => (homePages().some((p) => p.code === code) ? '#buses' : `#buses/stop/${encodeURIComponent(code)}`);

/* ---------- drawing ---------- */

const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>';
const STAR = '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>';
const ARROW = '<path d="M20.5 3.5 3.5 10.6l7 2.9 2.9 7z"/>';
const BACK = '<path d="m15 5-7 7 7 7"/>';
const NEXT = '<path d="m9 6 6 6-6 6"/>';
const BUS = '<rect x="5" y="3.5" width="14" height="13.5" rx="3"/><path d="M5 10.5h14M8 17v2.5M16 17v2.5"/>';
const PIN = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>';

/**
 * Row `r` from an answer this browser got at `got`, as it stands at `now`
 * (both on the server's clock). The server counts its times down to when it
 * answered, so they're counted from `got`, never from the feed's `asOf`
 * (that would take the same seconds off twice). Once the answer is OLD_MS
 * old (refreshes failing), its times are counted down, a bus long due has
 * no time, and a live time says "Last known": nothing old passes for live.
 */
export function aged(r, got, now) {
  const s = (now - got) / 1000;
  if (r?.etaS == null || !(s * 1000 > OLD_MS)) return r;
  const left = r.etaS - s;
  return {
    ...r,
    old: true,
    // Worded here from etaS (Big's own way), not the server's words from then.
    eta: null,
    etaS: left > -60 ? Math.max(0, left) : null,
    quality: r.quality === 'live' ? 'stale' : r.quality,
    laterText: null,
    later: r.later?.map((x) => ({ ...x, etaS: x.etaS - s })).filter((x) => x.etaS > 0),
  };
}

/** "Updated 5 s ago": from the server's `asOf`, as old as the times are, not when this browser fetched them. */
function Updated({ asOf }) {
  const now = useStore(tick);
  if (!asOf) return null;
  const s = Math.max(0, Math.round((now - asOf) / 1000));
  return html`<span class="bt-updated">${s < 5 ? t('Updated just now') : s < 60 ? t('Updated {0} s ago', s) : t('Updated {0} min ago', Math.floor(s / 60))}</span>`;
}

/** How old the times are, and under it why they couldn't be updated, if they couldn't. */
function Status({ asOf, error }) {
  return html`${error && html`<span class="bt-error">${error}</span>`}<${Updated} asOf=${asOf} />`;
}

/** A stop's board, then the services ending soon, and when it was updated. */
function Board({ code }) {
  const all = useStore(boards);
  const now = useStore(tick);
  const b = all.get(code);
  if (!b?.board) return html`<p class="hint bt-empty">${b?.error ?? t('Checking…')}</p>`;
  const ending = b.board.filter((r) => r.endsAt && Date.parse(r.endsAt) > now && Date.parse(r.endsAt) - now <= ENDS_SOON_MS);
  return html`
    ${b.board.length
      ? html`<div class="card bt-board">${b.board.map((r) => html`<${Row} key=${r.svc} r=${aged(r, b.got, now)} now=${now} onPick=${(svc) => go(lineHash(svc, code))} />`)}</div>`
      : html`<p class="hint bt-empty">${b.available ? t('No buses due') : t('No times right now')}</p>`}
    <div class="bt-foot">
      <div class="bt-ends">${ending.map((r) => html`<div key=${r.svc}><${Chip} svc=${r.svc} color=${r.color} cls="small" /> ${t('Runs until {0}', clock(r.endsAt))}</div>`)}</div>
      <div class="bt-status"><${Status} asOf=${b.asOf} error=${b.error} /></div>
    </div>
    ${b.board.some((r) => !r.paid) && html`<p class="bt-hint">${t('Tap a service to see its whole line.')}</p>`}
  `;
}

/**
 * The sky at the top of a page, as Settings has it (account/sky.js): the
 * hour's colours, the moon and stars at night, ending on the low hills.
 * What's in it takes the sky's ink (app.css, .sky-head). Each page has its
 * own, so it swipes with the page.
 */
const Sky = ({ children }) => html`<div class="bt-sky"><div class="sky-head"><${Celestial} band />${children}</div><${Horizon} on=${null} low /></div>`;

/** The dots under a page's name: where it is in the row. The nearest stop's is an arrow. */
function Dots({ index, count, nearestFirst, onDot }) {
  if (count < 2) return null;
  return html`
    <div class="bt-dots">
      ${Array.from({ length: count }, (_, j) =>
        html`<button type="button" key=${j} class=${j === index ? 'on' : ''} aria-label=${t('Page {0} of {1}', j + 1, count)} aria-current=${j === index ? 'true' : undefined} onClick=${() => onDot(j)}>
          ${j === 0 && nearestFirst && j !== index ? html`<${Icon} paths=${ARROW} />` : html`<i></i>`}
        </button>`,
      )}
    </div>
  `;
}

/**
 * A stop: what the page is (nearest, pinned), its name with a star to pin
 * it, This side | Across the road when it has a twin (both stops by
 * name when the twin is only nearby), and its board.
 */
function StopView({ code, kicker, dots, peek, above = null }) {
  const p = useStore(profile);
  const all = useStore(boards);
  const side = useStore(across);
  useStore(campus);
  const own = all.get(code)?.stop;
  const opposite = own?.opposite ?? stopOf(code)?.opposite ?? null;
  // Its twin is across the road, or (PGP and its Foyer) just nearby: then both are named.
  // Always the page's own stop's words, whichever side is showing. Old answers without it were across.
  const twinAcross = own?.oppositeAcross !== false;
  const twinName = own?.oppositeName ?? stopName(opposite);
  const shown = (side.has(code) && opposite) || code;
  const name = longName(all.get(shown)?.stop) ?? stopName(shown);
  const pinned = (p?.pinnedStops ?? []).includes(shown);
  const setSide = (other) => {
    across.set((s) => {
      const next = new Set(s);
      if (other) next.add(code);
      else next.delete(code);
      return next;
    });
    showBoard(code);
  };
  return html`
    <${Sky}>
    ${above}
    <div class="bt-top">
      <div class="bt-title">
        ${kicker && html`<p class="bt-kicker">${kicker}</p>`}
        <h2 class="bt-head" tabindex="-1">${name}</h2>
        ${shown !== name && html`<p class="bt-code">${shown}</p>`}
      </div>
      <button type="button" class=${pinned ? 'bt-star on' : 'bt-star'} aria-pressed=${String(pinned)} aria-label=${pinned ? t('Unpin {0}', name) : t('Pin {0}', name)} onClick=${() => togglePin(shown)}>
        <${Icon} paths=${STAR} />
      </button>
    </div>
    ${dots}
    <//>
    ${opposite &&
    html`<div class="segmented full bt-sides" role="radiogroup" aria-label=${twinAcross ? t('Side of the road') : t('Which stop')}>
      <label><input type="radio" name=${`side-${code}`} checked=${shown === code} onChange=${() => setSide(false)} /><span>${twinAcross ? t('This side') : (longName(own) ?? stopName(code))}</span></label>
      <label><input type="radio" name=${`side-${code}`} checked=${shown !== code} onChange=${() => setSide(true)} /><span>${twinAcross ? t('Across the road') : twinName}</span></label>
    </div>`}
    <${Board} code=${shown} />
    ${peek}
  `;
}

/** No nearest stop: no location and no home. Search, or allow location. */
function FindPage({ dots }) {
  const ask = useStore(canAsk);
  return html`
    <div class="bt-find">
      <h2 class="bt-head" tabindex="-1">${t('Find the stop nearest you')}</h2>
      <p class="hint">${t('Or search for a stop above, and pin it with the star to keep it here.')}</p>
      ${ask && html`<button type="button" class="btn small ghost" onClick=${() => findNearest({ ask: true })}><${Icon} paths=${ARROW} class="bt-btn-icon" />${t('Use my location')}</button>`}
      ${dots}
    </div>
  `;
}

/** The pages you swipe between: the nearest stop, then each pinned one. */
function Home() {
  const n = useStore(nearest);
  const p = useStore(profile);
  const index = useStore(active);
  const want = useStore(wantPage);
  const ask = useStore(canAsk);
  useStore(campus);
  const pages = pagesOf(n, p?.pinnedStops ?? []);
  const row = useRef(null);
  const at = Math.min(index, pages.length - 1);

  const scrollTo = (j, smooth = true) => {
    const el = row.current;
    if (el) el.scrollTo({ left: j * el.clientWidth, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  };
  // A dot or "Swipe for" pressed: the page it brings in has the focus, at its
  // stop's name (the button pressed is on the page going out of view).
  const turnTo = (j) => {
    scrollTo(j);
    const head = row.current?.children[j]?.querySelector('.bt-head');
    head?.focus({ preventScroll: true });
  };
  // Back on the home: the page it was on. A page unpinned: the one before it.
  useLayoutEffect(() => {
    if (index !== at) active.set(at);
    scrollTo(at, false);
  }, [pages.length]);
  useEffect(() => {
    if (!want) return;
    const j = pages.findIndex((x) => x.code === want);
    wantPage.set(null);
    if (j >= 0) scrollTo(j);
  }, [want]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    const j = Math.round(el.scrollLeft / el.clientWidth);
    if (j === active.get() || j < 0 || j >= pages.length) return;
    active.set(j);
    showBoard(pages[j].code);
  };

  return html`
    <div class="bt-pages" ref=${row} onScroll=${onScroll}>
      ${pages.map((pg, j) => {
        const dots = html`<${Dots} index=${j} count=${pages.length} nearestFirst=${pages[0].kind === 'nearest'} onDot=${turnTo} />`;
        const nextPage = pages[j + 1];
        const peek = nextPage?.code && html`<${Peek} code=${nextPage.code} onClick=${() => turnTo(j + 1)} />`;
        if (pg.kind === 'loading') return html`<section class="bt-page" key="loading"><${Sky}><p class="hint bt-empty">${t('Checking…')}</p>${dots}<//>${peek}</section>`;
        if (pg.kind === 'find') return html`<section class="bt-page" key="find"><${Sky}><${FindPage} dots=${dots} /><//>${peek}</section>`;
        let kicker;
        if (pg.kind === 'pinned') kicker = html`<${Icon} paths=${STAR} class="bt-kicker-icon star" />${t('Pinned')}`;
        else if (n.fromHome) {
          kicker = html`${t('Your home stop')}${ask && html` · <button type="button" class="link-btn" onClick=${() => findNearest({ ask: true })}>${t('Use my location')}</button>`}`;
        } else {
          kicker = html`<${Icon} paths=${ARROW} class="bt-kicker-icon" />${n.distM >= 1000 ? t('Nearest stop · {0} km', (n.distM / 1000).toFixed(1)) : t('Nearest stop · {0} m', n.distM)}`;
        }
        return html`<section class="bt-page" key=${`${pg.kind}-${pg.code}`}><${StopView} code=${pg.code} kicker=${kicker} dots=${dots} peek=${peek} /></section>`;
      })}
    </div>
  `;
}

/** "Swipe for Central Library", with its services, under a page with another after it. */
function Peek({ code, onClick }) {
  const s = stopOf(code);
  return html`
    <button type="button" class="bt-peek" onClick=${onClick}>
      <span><${Fill} text=${t('Swipe for {0}', MARK)} parts=${[html`<b>${longName(s) ?? code}</b>`]} /></span>
      <span class="bt-peek-chips">${(s?.services ?? []).map((svc) => html`<${Chip} key=${svc} svc=${svc} cls="small" />`)}<${Icon} paths=${NEXT} /></span>
    </button>
  `;
}

/** Search a stop or a service: a stop opens its board, a service its line. */
function Find() {
  const c = useStore(campus);
  const box = useRef(null);
  // Every service then every stop (search.js), the services also what it offers before anything is typed.
  const dests = useMemo(() => busesTabIndex(c), [c]);
  const services = useMemo(() => dests.filter((d) => d.kind === 'service'), [dests]);
  return html`
    <div class="bt-search">
      <${Icon} paths=${SEARCH} class="bt-search-icon" />
      <${SearchBox}
        type="search"
        placeholder=${t('Search a stop or service')}
        aria-label=${t('Search a stop or service')}
        enterkeyhint="go"
        ctl=${box}
        source=${() => dests}
        suggestions=${() => services}
        stopName=${stopName}
        empty=${t('No stop or service by that name')}
        onPick=${(d) => {
          box.current?.clear();
          box.current?.input?.blur();
          if (d.kind === 'service') go(lineHash(d.code, null));
          else openStop(d.code);
        }}
      />
    </div>
  `;
}

function BackBar({ label, parent }) {
  return html`
    <nav class="bt-nav" aria-label=${t('Back')}>
      <button type="button" class="bt-back" aria-label=${t('Back to {0}', label)} onClick=${() => back(parent)}><${Icon} paths=${BACK} /><span>${label}</span></button>
    </nav>
  `;
}

/** A stop's board on a page of its own: from the search or a line. */
function StopPage({ code }) {
  const p = useStore(profile);
  useStore(campus);
  const pinned = (p?.pinnedStops ?? []).includes(code);
  return html`
    <section class="bt-page alone">
      <${StopView} code=${code} above=${html`<${BackBar} label=${t('Buses')} parent="#buses" />`} kicker=${pinned ? html`<${Icon} paths=${STAR} class="bt-kicker-icon star" />${t('Pinned')}` : null} />
    </section>
  `;
}

/** A bus drawn on the line, with its plate and how full it is; `between`, on the line between two stops. Said in words too. */
const BusMark = ({ between = false }) =>
  html`<span class="bt-bus" aria-hidden="true"><${Icon} paths=${BUS} /></span><span class="sr-only">${between ? t('Bus between stops') : t('Bus here')}</span>`;
const Plate = ({ b }) => html`${b.plate && html`<span class="bt-plate">${b.plate}</span>`}<${Crowd} crowd=${b.crowd} />`;

/** Your stop's time on the line, from its board row: nothing worked out here. */
function YourTime({ r }) {
  if (!r) return null;
  if (r.running === false) return html`<span class="bt-yours"><span class="bt-big none">${stoppedWords(r.stopped, r.resumesAt, tick.get())[0]}</span></span>`;
  return html`
    <span class="bt-yours">
      <${Big} r=${r} />
      <span class="bt-meta"><${Quality} r=${r} />${thenText(r) && html`<span class="bt-then">${thenText(r)}</span>`}</span>
    </span>
  `;
}

/**
 * A service's whole line: its stops in order on a line in its colour, its
 * buses at a stop or between two, and the stop you came from with its time.
 */
function LinePage({ svc, stop }) {
  const l = useStore(line);
  const c = useStore(campus);
  const now = useStore(tick);
  const key = `${svc}/${stop ?? ''}`;
  const mine = l?.key === key ? l : null;
  const data = mine?.data;
  const scrolled = useRef(null);
  // Your stop in view the first time the line comes, not on every refresh.
  useEffect(() => {
    if (!data || scrolled.current === key) return;
    scrolled.current = key;
    document.querySelector('.bt-stop.mine')?.scrollIntoView({ block: 'center' });
  }, [key, Boolean(data)]);

  const label = stop ? (longName(data?.stops.find((s) => s.code === stop)) ?? stopName(stop)) : t('Buses');
  const parent = stop ? stopParent(stop) : '#buses';
  const color = data?.color ?? colorOf(svc);
  const r = c?.routes[svc];
  const where = r && (r.loop ? t('Loop from {0}', stopName(r.seq[0])) : t('{0} to {1}', stopName(r.seq[0]), stopName(r.seq.at(-1))));
  const head = html`
    <${Sky}>
      <${BackBar} label=${label} parent=${parent} />
      <div class="bt-line-title">
        <${Chip} svc=${svc} color=${color} cls="bt-chip big" />
        <div><h2 class="bt-head" tabindex="-1">${svc}</h2>${where && html`<p class="hint">${where}</p>`}</div>
      </div>
    <//>
  `;
  if (!data) return html`${head}<p class="hint bt-empty">${mine?.error ?? t('Checking…')}</p>`;

  const n = data.stops.length;
  // Not running: its stops, no buses, and why.
  const stopped = data.running === false;
  const buses = data.available && !stopped ? data.buses : [];
  const running = buses.length === 0 ? t('No buses running') : buses.length === 1 ? t('1 bus running') : t('{0} buses running', buses.length);
  const ends = data.endsAt && Date.parse(data.endsAt) > now ? t('Runs until {0}', clock(data.endsAt)) : null;
  const yours = data.stop?.index ?? -1;
  return html`
    ${head}
    ${stopped
      ? html`<p class="bt-stopped-note">${stoppedWords(data.stopped, data.resumesAt, now).filter(Boolean).map((w, i) => html`<span key=${i}>${w}</span>`)}</p>`
      : html`<p class="bt-summary">${[data.available ? running : null, ends].filter(Boolean).join(' · ')}</p>`}
    ${!data.available && !stopped && html`<p class="bt-note">${t('Bus positions are unavailable right now.')}</p>`}
    <div class="bt-line-label"><span class="eyebrow">${t('{0} stops', n)}</span><span class="bt-status"><${Status} asOf=${mine.asOf} error=${mine.error} /></span></div>
    <ol class="bt-route" style=${svcVars(color)}>
      ${data.stops.map((s, i) => {
        const here = buses.filter((b) => b.at === i);
        const between = buses.filter((b) => b.at == null && b.after === i);
        const isMine = i === yours;
        return html`
          <li key=${`s${i}`} class=${`bt-stop${isMine ? ' mine' : ''}${here.length ? ' has-bus' : ''}`}>
            <button type="button" onClick=${() => openStop(s.code)}>
              ${here.length ? html`<${BusMark} />` : html`<span class="bt-node" aria-hidden="true"></span>`}
              <span class="bt-stop-text">
                <span class="bt-stop-name">${longName(s)}</span>
                ${isMine && html`<span class="bt-mine-tag"><${Icon} paths=${PIN} />${t('Your stop')}</span>`}
                ${here.map((b) => html`<span class="bt-bus-info" key=${b.id}><${Plate} b=${b} /></span>`)}
                ${s.services?.length > 0 && html`<span class="bt-others">${s.services.map((x) => html`<${Chip} key=${x} svc=${x} cls="tiny" />`)}</span>`}
              </span>
              ${isMine && html`<${YourTime} r=${aged(data.stop.row, mine.got, now)} />`}
            </button>
          </li>
          ${between.map(
            (b) => html`<li key=${b.id} class="bt-gap">
              <${BusMark} between />
              <span class="bt-bus-info"><${Plate} b=${b} /><span>${t('Next: {0}', longName(data.stops[(i + 1) % n]))}</span></span>
            </li>`,
          )}
        `;
      })}
    </ol>
  `;
}

/**
 * The tab. `visible`: it's on screen (refreshing stops otherwise). `here`:
 * app.js's way to the phone's location.
 */
export function BusesTab({ visible, here }) {
  locate = here;
  const r = useStore(route);

  useEffect(() => {
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!visible) return;
    route.set(parse(location.hash));
    // Fresh each time it's shown: the pins may have changed on another device, and you may have moved.
    loadCampus().catch(() => {});
    reloadProfile().catch(() => {});
    findNearest();
    const now = route.get();
    if (now.kind === 'stop') showBoard(now.code);
    else if (now.kind === 'line') loadLine(now.svc, now.stop);
    const timer = setInterval(() => document.visibilityState === 'visible' && refresh(), REFRESH_MS);
    const clockTimer = setInterval(() => tick.set(serverNow()), 5_000);
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      tick.set(serverNow());
      refresh({ back: true });
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [visible]);

  if (r.kind === 'line') return html`<${LinePage} svc=${r.svc} stop=${r.stop} />`;
  if (r.kind === 'stop') return html`<${StopPage} code=${r.code} />`;
  // The search at the top of the sky, each page's own sky running on from it.
  return html`<div class="bt-sky-top"><${Find} /></div><${Home} />`;
}
