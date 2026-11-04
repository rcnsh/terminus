// The Stops tab: what's coming at any stop, and where a service's buses are
// along its line. Loaded the first time the tab is opened (app.js).
//
// Its home is the stops you've pinned, one at a time as Nearby's sign
// (/api/me/stops), picked by name or swiped, then every service with how
// many of its buses are out (/api/lines). The stops around you are Nearby's
// job, on Now. A service tapped on a board opens its line (/api/line), and a
// stop on the line opens its board.
// Where you are in the tab is in the address (#buses, #buses/stop/YIH,
// #buses/line/D1/YIH), so Back and a reload keep it.
//
// Only the times the API gives are shown: `later` is every later bus the
// feed reported, and a line shows no times at stops other than yours.

import { Icon, focusSoon, html, reducedMotion, store, useEffect, useMemo, useRef, useStore } from '/assets/ui.js';
import { clock, hour12, send, serverNow, signedOut, t } from '/account/dom.js';
import { campus, loadCampus, profile, reloadProfile, togglePin } from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { Celestial, Horizon } from '/account/sky.js';
import { busesTabIndex } from '/account/search.js';
import { NEXT, STAR, Big, Chip, Crowd, Quality, Row, colorOf, stoppedWords, svcVars, thenText } from '/app/board.js';
import { StopSign, anyGuess } from '/app/sign.js';
import { PULL_FRESH_MS } from '/app/timing.js';

/** The page on screen refreshes this often (the API caches arrivals 15 s). */
const REFRESH_MS = 15_000;
/** The lines' counts of buses out are asked for no more often than this: each ask reads every service from NUS. */
const LINES_MS = 60_000;
/**
 * Times fetched longer ago than this have missed a refresh at least:
 * counted down here from when they came, and no longer shown as live.
 */
const OLD_MS = 2 * REFRESH_MS;
/** "Runs until" shows for a service ending within this long. */
const ENDS_SOON_MS = 2 * 3600_000;

/** Where in the tab: its home, a stop's board, or a service's line. From the address. */
export const route = store({ kind: 'home' });
/**
 * Each stop's board as last fetched, by code: { stop, board, available, at,
 * got, asOf, error }. `at` is when this browser fetched it (Date.now(), for
 * fetching again) and `got` the same on the server's clock, which the times
 * are counted from: the server has counted them down to its own now.
 * `asOf` is when the feed's answer is from (its clock, ms), older than `got`
 * when it served one it had kept; it's only for "Updated 5 s ago".
 */
export const boards = store(new Map());
/**
 * Each pinned stop as Nearby shows it, by code: { s, at, got, error }, `s`
 * one stop of /api/me/stops, `at` and `got` as for a board. `gone`: the
 * server doesn't know the stop.
 */
export const signs = store(new Map());
/** The pinned stop on screen on the home (its code, or ADD for the last page), kept while the app runs. Null: the first. */
export const chosen = store(null);
/** The pager's last page: how to pin another stop. */
export const ADD = '+';
/** How many of each service's buses are out: /api/lines's `lines`, null until it has answered. */
export const outs = store(null);
/** The stops showing the board across the road, by the page's own stop. */
export const across = store(new Set());
/** The line on screen: { key, data, at, got, asOf } or { key, error }. */
export const line = store(null);
/** Now on the server's clock (dom.js), every few seconds, for "Updated 5 s ago". */
const tick = store(serverNow());
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
/**
 * The pins as the home last drew them. Kept here, not in the home, so a stop
 * unpinned on its own page still finds its place when the home comes back.
 */
let pinsShown = [];
/**
 * Where on the home's pager `pick` is (chosen): a pinned stop's place, the
 * last page for ADD, else the first. A stop unpinned since the home drew
 * `was`: the one now in its place, else the one before it.
 */
export function pageOf(pinned, pick, was = pinsShown) {
  if (pick === ADD) return pinned.length;
  const i = pinned.indexOf(pick);
  if (i >= 0 || pick == null) return Math.max(0, i);
  return Math.min(Math.max(0, was.indexOf(pick)), Math.max(0, pinned.length - 1));
}
/**
 * The pinned stops fetched for the page on screen: its stop and the ones
 * either side of it, so a swipe shows times at once.
 */
export function signWindow(pinned = pins(), pick = chosen.get()) {
  const i = pageOf(pinned, pick);
  return [pinned[i - 1], pinned[i], pinned[i + 1]].filter(Boolean);
}
/** Where you are, for the walk to each pinned stop: the API's lat, lon and acc, or null. Set by the tab (app.js), never asking. */
let locate = async () => null;
/** The stop across the road from `code`, from its board, else the campus's map. */
export const oppositeOf = (code) => boards.get().get(code)?.stop?.opposite ?? stopOf(code)?.opposite ?? null;
/** The stop whose board a page shows: its own, or the one across the road. */
export const shownCode = (code) => (across.get().has(code) && oppositeOf(code)) || code;

/** When answer `data` is from, on the server's clock: its `asOf`, else now. */
const asOfMs = (data) => Date.parse(data?.asOf ?? '') || serverNow();

function keep(code, entry) {
  boards.set((m) => new Map(m).set(code, entry));
}

/**
 * Why times couldn't be fetched. With an answer already on screen (`shown`),
 * that it couldn't be updated: "No times right now" under last known times
 * would contradict them.
 */
export const failedWords = (shown, online = navigator.onLine) =>
  !online ? t('Live times need a connection.') : shown ? t("Couldn't update. Trying again soon.") : t('No times right now');

/** One stop's board. A failure keeps the board already there, saying it couldn't update. */
/** The stops whose board is being fetched, so a second ask for one waits on the first rather than asking again. */
const fetching = new Set();

export async function loadBoard(code) {
  // The public buses there too, when the account has them on.
  const pub = profile.get()?.publicBuses ? '&public=1' : '';
  // A call that hung (the phone asleep) can end after a newer one: it
  // mustn't put back older times, or an error over fresh ones.
  const asked = Date.now();
  const newer = () => boards.get().get(code)?.at > asked;
  try {
    // stopped=1: the services not running now are listed too, greyed.
    const data = await getJSON(`/api/arrivals?stop=${encodeURIComponent(code)}${pub}&stopped=1`);
    if (newer()) return;
    keep(code, {
      stop: { ...data.stop, opposite: data.stop.opposite ?? stopOf(code)?.opposite ?? null },
      board: data.board,
      available: data.available !== false,
      at: Date.now(),
      got: serverNow(),
      asOf: asOfMs(data),
    });
  } catch (err) {
    if (err.message === 'signed out' || newer()) return;
    const was = boards.get().get(code);
    keep(code, { ...was, error: failedWords(Boolean(was?.board)) });
  }
}

/** Pinned stops `codes`, as Nearby shows them. A failure keeps what's there, saying it couldn't update. */
export async function loadSigns(codes) {
  if (!codes.length) return;
  // As for a board: a call that hung can end after a newer one.
  const asked = Date.now();
  const newer = (code) => signs.get().get(code)?.at > asked;
  try {
    const fix = await locate().catch(() => null);
    const q = new URLSearchParams({ codes: codes.join(','), ...fix });
    if (hour12()) q.set('h12', '1');
    const data = await getJSON(`/api/me/stops?${q}`);
    const got = serverNow();
    signs.set((m) => {
      const next = new Map(m);
      for (const code of codes) {
        if (newer(code)) continue;
        const s = data.stops.find((x) => x.stop.code === code);
        next.set(code, s ? { s, at: Date.now(), got } : { gone: true, at: Date.now(), got });
      }
      return next;
    });
  } catch (err) {
    if (err.message === 'signed out') return;
    signs.set((m) => {
      const next = new Map(m);
      for (const code of codes) {
        if (newer(code)) continue;
        const was = m.get(code);
        next.set(code, { ...was, error: failedWords(Boolean(was?.s)) });
      }
      return next;
    });
  }
}

/** The pinned stops being fetched, so a swipe back and forth doesn't ask for one twice at once. */
const signsFetching = new Set();
/** The page on screen and its neighbours, those not fetched in the last REFRESH_MS. */
function freshenSigns() {
  const want = signWindow().filter((code) => !signsFetching.has(code) && !(Date.now() - (signs.get().get(code)?.at ?? 0) < REFRESH_MS));
  if (!want.length) return;
  for (const code of want) signsFetching.add(code);
  loadSigns(want).finally(() => {
    for (const code of want) signsFetching.delete(code);
  });
}

/** When /api/lines was last asked (Date.now()), however the tab came and went: never sooner than LINES_MS after. */
let linesAt = 0;
/** Counts taken from a service's own page (/api/line's `out`), by service: { at (when it came, on the server's clock), out }. */
const pageOuts = new Map();
/** When the list's counts were made (its asOf). */
let listAt = 0;
/** How many of each service's buses are out, unless asked within LINES_MS. A failure keeps the counts there. */
export async function loadOuts() {
  if (Date.now() - linesAt < LINES_MS) return;
  linesAt = Date.now();
  try {
    const data = await getJSON('/api/lines');
    const lines = { ...data.lines };
    // A page opened since this list was counted knows better: the list shows what that page did.
    listAt = asOfMs(data);
    for (const [svc, p] of pageOuts) if (p.at > listAt) lines[svc] = p.out;
    outs.set(lines);
  } catch {
    // Counts that can't be brought up to date aren't shown: nothing, as for a feed that didn't answer.
    outs.set(null);
  }
}

export async function loadLine(svc, stop) {
  const key = `${svc}/${stop ?? ''}`;
  // As for a board: a call that hung can end after a newer one, and mustn't
  // put back older buses, or an error over fresh ones.
  const asked = Date.now();
  const newer = () => line.get()?.key === key && line.get().at > asked;
  try {
    const data = await getJSON(`/api/line?svc=${encodeURIComponent(svc)}${stop ? `&stop=${encodeURIComponent(stop)}` : ''}`);
    if (lineKey() === key && !newer()) line.set({ key, data, at: Date.now(), got: serverNow(), asOf: asOfMs(data) });
    takeOut(svc, data);
  } catch (err) {
    if (err.message === 'signed out' || lineKey() !== key || newer()) return;
    const was = line.get()?.key === key ? line.get() : null;
    const error = err.status === 400 ? t('No line to show for {0}.', svc) : failedWords(Boolean(was?.data));
    line.set({ ...was, key, error });
  }
}
/**
 * The list of lines shows the count a service's page just got, not its own older one: the two never disagree on going back. Dated by
 * when it came, not the page's asOf, which an old stop row can pull back.
 */
function takeOut(svc, data) {
  if (!data?.out) return;
  const at = serverNow();
  pageOuts.set(svc, { at, out: data.out });
  if (outs.get() && at > listAt) outs.set({ ...outs.get(), [svc]: data.out });
}
const lineKey = () => {
  const r = route.get();
  return r.kind === 'line' ? `${r.svc}/${r.stop ?? ''}` : null;
};

/** A timed refresh still on its way: the next one waits for it, rather than piling up on a slow connection. */
let pending = null;
/** When the next timed refresh runs (Date.now()), for a pull that brought nothing new to say; 0 while the tab is hidden. */
let nextTimedAt = 0;

/**
 * What's on screen, fetched again: the pinned stops' boards, the stop's own
 * page, or the line. [back]: the tab shown again, which asks even with a call on its
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
  if (r.kind === 'stop') return loadBoard(shownCode(r.code));
  return loadSigns(signWindow());
}

/**
 * Pulled down to refresh (pull.js): what's on screen fetched again, unless
 * its times came under PULL_FRESH_MS ago. How it went: 'updated', 'failed',
 * or { state: 'fresh', inS }: nothing asked, and the timed refresh brings
 * new times in `inS` seconds (null if none is due), so "Updated 9 s ago"
 * still counting doesn't read as the pull having failed.
 */
export async function pullRefresh() {
  const r = route.get();
  const shown = () => {
    if (r.kind === 'line') return [line.get()?.key === lineKey() ? line.get() : null];
    if (r.kind === 'stop') return [boards.get().get(shownCode(r.code))];
    // The home: the pinned stop on screen, none on the last page.
    const code = pins()[pageOf(pins(), chosen.get())];
    return code ? [signs.get().get(code)] : [];
  };
  const fresh = (b) => b?.at && !b.error && Date.now() - b.at < PULL_FRESH_MS;
  // Nothing pinned (or the last page): nothing on the home to fetch, and nothing that will change.
  if (!shown().length) return { state: 'fresh', inS: null };
  if (shown().every(fresh)) return { state: 'fresh', inS: nextTimedAt ? Math.max(1, Math.ceil((nextTimedAt - Date.now()) / 1000)) : null };
  const asked = Date.now();
  await refreshNow();
  return shown().every((b) => b?.at >= asked && !b.error) ? 'updated' : 'failed';
}

/** Stop `code`'s own board, fetched unless it's fresh or already on its way. */
function freshen(code) {
  const b = boards.get().get(code);
  if (fetching.has(code)) return;
  if (!b?.at || Date.now() - b.at > REFRESH_MS) {
    fetching.add(code);
    loadBoard(code).finally(() => fetching.delete(code));
  }
}
/** A stop's page just brought on screen: the side of the road it shows, fetched unless it's fresh. */
function showBoard(code) {
  if (code) freshen(shownCode(code));
}

export function parse(hash) {
  // A stray % (an address typed or edited by hand) is kept as it is rather than throwing.
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const [, kind, a, b] = hash.split('/').map(decode);
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
  // What was focused (a row, Back) has gone with the page: its heading takes it.
  if (document.activeElement !== document.body) focusSoon(headOnScreen, { preventScroll: true });
  if (next.kind === 'stop') showBoard(next.code);
  else if (next.kind === 'line') loadLine(next.svc, next.stop);
}

/** The heading of what the tab shows: the home's title, the stop's or the line's. */
const headOnScreen = () => document.querySelector('#tab-buses .bt-head');

export const stopHash = (code) => `#buses/stop/${encodeURIComponent(code)}`;
export const lineHash = (svc, stop) => `#buses/line/${encodeURIComponent(svc)}${stop ? `/${encodeURIComponent(stop)}` : ''}`;
/** A stop picked: its own page. */
const openStop = (code) => go(stopHash(code));

const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>';
const BACK = '<path d="m15 5-7 7 7 7"/>';
const BUS = '<rect x="5" y="3.5" width="14" height="13.5" rx="3"/><path d="M5 10.5h14M8 17v2.5M16 17v2.5"/>';
const PIN = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>';

/**
 * Row `r` from an answer this browser got at `got`, as it stands at `now`
 * (both on the server's clock). The server counts its times down to when it
 * answered, so they're counted from `got`, never from the feed's `asOf`
 * (that would take the same seconds off twice). Once the answer is OLD_MS
 * old (refreshes failing), its times are counted down, a bus long due has
 * no time, and a live time says "Last known" (and "~", as a timetabled one
 * keeps): nothing old passes for live.
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
    later: r.later
      ?.map((x) => ({ ...x, etaS: x.etaS - s, eta: null, ...(x.quality === 'live' ? { quality: 'stale' } : {}) }))
      .filter((x) => x.etaS > 0),
  };
}

/**
 * "Updated 5 s ago": from the server's `asOf`, as old as the times are, not
 * when this browser fetched them. `live`: a row above has a live time, so
 * "Live" first says once what the dot by it means (board.js LiveDot).
 */
function Updated({ asOf, live = false }) {
  const now = useStore(tick);
  if (!asOf) return null;
  const s = Math.max(0, Math.round((now - asOf) / 1000));
  return html`<span class="bt-updated">${live && html`<span class="bt-live"><span class="dot" aria-hidden="true"></span>${t('Live')}</span> · `}${s < 5 ? t('Updated just now') : s < 60 ? t('Updated {0} s ago', s) : t('Updated {0} min ago', Math.floor(s / 60))}</span>`;
}

/** How old the times are, and under it why they couldn't be updated, if they couldn't. */
function Status({ asOf, error, live }) {
  return html`${error && html`<span class="bt-error">${error}</span>`}<${Updated} asOf=${asOf} live=${live} />`;
}

/** A stop's board, then the services ending soon, and when it was updated. */
function Board({ code }) {
  const all = useStore(boards);
  const now = useStore(tick);
  const b = all.get(code);
  if (!b?.board) return html`<p class="hint bt-empty">${b?.error ?? t('Checking…')}</p>`;
  const ending = b.board.filter((r) => r.endsAt && Date.parse(r.endsAt) > now && Date.parse(r.endsAt) - now <= ENDS_SOON_MS);
  const rows = b.board.map((r) => aged(r, b.got, now));
  const live = rows.some((r) => r.running !== false && r.quality === 'live' && r.etaS != null);
  return html`
    ${
      rows.length
        ? html`<div class="card bt-board">${rows.map((r) => html`<${Row} key=${r.svc} r=${r} now=${now} chevron onPick=${(svc) => go(lineHash(svc, code))} />`)}</div>`
        : html`<p class="hint bt-empty">${b.available ? t('No buses due') : t('No times right now')}</p>`
    }
    <div class="bt-foot">
      <div class="bt-ends">${ending.map((r) => html`<div key=${r.svc}><${Chip} svc=${r.svc} color=${r.color} cls="small" /> ${t('Runs until {0}', clock(r.endsAt))}</div>`)}</div>
      <div class="bt-status"><${Status} asOf=${b.asOf} error=${b.error} live=${live} /></div>
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
const Sky = ({ children }) =>
  html`<div class="bt-sky"><div class="sky-head"><${Celestial} band />${children}</div><${Horizon} on=${null} low /></div>`;

/** The star that pins stop `code` (called `name`), filled while it's pinned. `cls` for a smaller one. Absent until the pins are known. */
function Star({ code, name, cls = '' }) {
  const p = useStore(profile);
  if (!p) return null;
  const pinned = (p?.pinnedStops ?? []).includes(code);
  return html`
    <button type="button" class=${`bt-star${pinned ? ' on' : ''} ${cls}`} aria-pressed=${String(pinned)} aria-label=${pinned ? t('Unpin {0}', name) : t('Pin {0}', name)} onClick=${() => togglePin(code)}>
      <${Icon} paths=${STAR} />
    </button>
  `;
}

/**
 * A stop: whether it's pinned, its name with a star to pin
 * it, This side | Across the road when it has an opposite stop (both stops by
 * name when the opposite stop is only nearby), and its board.
 */
function StopView({ code, kicker, above = null }) {
  const all = useStore(boards);
  const side = useStore(across);
  useStore(campus);
  const own = all.get(code)?.stop;
  const opposite = own?.opposite ?? stopOf(code)?.opposite ?? null;
  // Its opposite stop is across the road, or (PGP and its Foyer) just nearby: then both are named.
  // Always the page's own stop's words, whichever side is showing; across when null from an older server.
  const twinAcross = own?.oppositeAcross !== false;
  const twinName = own?.oppositeName ?? stopName(opposite);
  const shown = (side.has(code) && opposite) || code;
  const name = longName(all.get(shown)?.stop) ?? stopName(shown);
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
      <${Star} code=${shown} name=${name} />
    </div>
    <//>
    ${
      opposite &&
      html`<div class="segmented full bt-sides" role="radiogroup" aria-label=${twinAcross ? t('Side of the road') : t('Which stop')}>
      <label><input type="radio" name=${`side-${code}`} checked=${shown === code} onChange=${() => setSide(false)} /><span>${twinAcross ? t('This side') : (longName(own) ?? stopName(code))}</span></label>
      <label><input type="radio" name=${`side-${code}`} checked=${shown !== code} onChange=${() => setSide(true)} /><span>${twinAcross ? t('Across the road') : twinName}</span></label>
    </div>`
    }
    <${Board} code=${shown} />
  `;
}

/** How a service runs, as under its name on its line: "Loop from COM 3", "Kent Ridge MRT to UTown". The server's `name`, else worked out here for an older campus. */
const routeWords = (r) =>
  r.name ?? (r.loop ? t('Loop from {0}', stopName(r.seq[0])) : t('{0} to {1}', stopName(r.seq[0]), stopName(r.seq.at(-1))));

/** A pinned stop's short name, as on its plate ("UTown"), for its segment. */
const plateName = (code) => signs.get().get(code)?.s?.stop.name ?? stopOf(code)?.name ?? code;

/** Stop `s`'s times as they stand at `now`, counted from `got` (aged): nothing old passes for live. */
const agedSign = (s, got, now) => ({ ...s, board: s.board.map((r) => aged(r, got, now)) });

/**
 * One pinned stop's page: its sign as Nearby shows it, and under it why it
 * couldn't update, or what a "~" means when one is showing. Before its
 * times come, its plate with "Checking…".
 */
function PinPage({ code, entry, pinned, now }) {
  const s = entry?.s
    ? agedSign(entry.s, entry.got, now)
    : { stop: { code, name: plateName(code) }, walkS: null, available: true, board: [] };
  const note = entry?.s ? null : entry?.gone ? t('No times right now') : (entry?.error ?? t('Checking…'));
  return html`
    <div class="bt-pager-page" role="group" aria-label=${s.stop.name}>
      <div class="nearby">
        <${StopSign} s=${s} pinned=${pinned} note=${note} onStop=${openStop} onLine=${(svc, at) => go(lineHash(svc, at))} />
        ${entry?.s && entry.error && html`<p class="bt-pin-error"><span class="bt-error">${entry.error}</span></p>`}
        ${!note && anyGuess([s]) && html`<p class="nb-foot">${t('~ is a guess from the timetable, not a live time.')}</p>`}
      </div>
    </div>
  `;
}

/**
 * The pinned stops: their names as one segmented control, as a stop's
 * page picks its side of the road, over a pager of their signs, one page
 * each and a last one saying how to pin another. Swiping picks the name,
 * and a name picked swipes there. The pager is as tall as its tallest page
 * so far, so nothing under it jumps while swiping.
 */
function PinnedStops({ pinned }) {
  const pick = useStore(chosen);
  const all = useStore(signs);
  const now = useStore(tick);
  useStore(campus);
  const pager = useRef(null);
  const segs = useRef(null);
  // The page came from a swipe: the pager is there already.
  const swiped = useRef(false);
  const moved = useRef(false);
  // A stop unpinned (its star, here or on its page): pageOf finds the page that took its place.
  const gone = pick != null && pick !== ADD && !pinned.includes(pick);
  const index = pageOf(pinned, pick);
  const at = useRef(index);
  at.current = index;
  // Swiped: once the pager settles, the page it rests on is the one picked.
  const settle = useRef(0);
  /** Where page `i` starts in the pager: its width and the gap between pages, each. */
  const leftOf = (el, i) => i * (el.children[1] ? el.children[1].offsetLeft - el.children[0].offsetLeft : el.clientWidth);
  /** A name picked: a swipe's settling that hasn't fired yet would put the old page back. */
  const choose = (code) => {
    clearTimeout(settle.current);
    chosen.set(code);
  };

  useEffect(() => {
    pinsShown = pinned;
    if (gone) chosen.set(pinned[index]);
  }, [pinned.join()]);

  // The page picked: the pager there (at once the first time), its name in view, its times fetched.
  useEffect(() => {
    const el = pager.current;
    if (el && !swiped.current) {
      const left = leftOf(el, index);
      if (Math.abs(el.scrollLeft - left) > 1) el.scrollTo({ left, behavior: moved.current && !reducedMotion() ? 'smooth' : 'instant' });
    }
    swiped.current = false;
    moved.current = true;
    const box = segs.current;
    const seg = box?.children[index];
    if (seg) {
      if (seg.offsetLeft < box.scrollLeft) box.scrollLeft = seg.offsetLeft;
      else if (seg.offsetLeft + seg.offsetWidth > box.scrollLeft + box.clientWidth)
        box.scrollLeft = seg.offsetLeft + seg.offsetWidth - box.clientWidth;
    }
    freshenSigns();
  }, [index, pinned.join()]);

  // As tall as the tallest page so far; measured again when the width changes (a phone turned).
  useEffect(() => {
    const el = pager.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let tallest = 0;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // A new width (a phone turned, the tab shown again): the page picked kept in place.
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        tallest = 0;
        el.style.minHeight = '';
        el.scrollLeft = leftOf(el, at.current);
      }
      if (el.offsetHeight > tallest) {
        tallest = el.offsetHeight;
        el.style.minHeight = `${tallest}px`;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const el = pager.current;
      if (!el?.clientWidth) return;
      const i = Math.round(el.scrollLeft / leftOf(el, 1));
      if (i === at.current) return;
      swiped.current = true;
      chosen.set(i < pinned.length ? pinned[i] : ADD);
    }, 120);
  };

  return html`
    <div class="segmented full bt-pins" role="radiogroup" aria-label=${t('Pinned')} ref=${segs}>
      ${pinned.map(
        (code, i) =>
          html`<label key=${code}><input type="radio" name="pinned-stop" checked=${i === index} onChange=${() => choose(code)} /><span>${plateName(code)}</span></label>`,
      )}
    </div>
    <div class="bt-pager" ref=${pager} onScroll=${onScroll}>
      ${pinned.map((code) => html`<${PinPage} key=${code} code=${code} entry=${all.get(code)} pinned=${pinned} now=${now} />`)}
      <div class="bt-pager-page" role="group" aria-label=${t('Pin another stop')}>
        <div class="bt-add">
          <${Icon} paths=${STAR} />
          <b>${t('Pin another stop')}</b>
          <span>${t('Tap the star on a stop in Nearby or on its page to keep it here.')}</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Every service, each opening its line: its badge, how it runs and the
 * stops it passes (the server's words), and how many of its buses are out.
 * Every badge is as wide as the widest, so the names line up.
 */
function Lines({ routes }) {
  const counts = useStore(outs);
  return html`
    <div class="card bt-services">
      ${routes.map(([svc, r]) => {
        const name = routeWords(r);
        const via = r.via ?? null;
        // Null: the feed didn't answer for it, so nothing is said. A count from a
        // kept feed answer (stale) is said without the dot that marks live.
        const n = counts?.[svc] ?? null;
        return html`<button
          type="button"
          key=${svc}
          class="bt-service"
          aria-label=${[t('Bus {0}', svc), name, via, n?.outText].filter(Boolean).join(t(', '))}
          onClick=${() => go(lineHash(svc, null))}
        >
          <span class="bt-service-chip"><${Chip} svc=${svc} color=${r.color} cls="bt-chip" /></span>
          <span class="bt-service-text"><span class="bt-service-name">${name}</span>${via && html`<span class="bt-service-via">${via}</span>`}</span>
          <span class="bt-out">${n?.out > 0 && !n.stale && html`<span class="dot"></span>`}${n?.outText}</span>
          <${Icon} paths=${NEXT} class="bt-go" />
        </button>`;
      })}
    </div>
  `;
}

/**
 * The home: your pinned stops, one at a time as Nearby shows them, then
 * every service, which opens its line. The stops around you are on Now (Nearby).
 */
function Home() {
  const p = useStore(profile);
  const c = useStore(campus);
  const pinned = p?.pinnedStops ?? [];
  const routes = Object.entries(c?.routes ?? {});
  let pins;
  if (!p) pins = html`<p class="hint bt-empty">${t('Checking…')}</p>`;
  else if (!pinned.length)
    pins = html`<p class="bt-no-pins"><${Icon} paths=${STAR} />${t("Tap the star on any stop to keep it here: in Nearby, on the stop's page, or after searching for it.")}</p>`;
  else pins = html`<${PinnedStops} pinned=${pinned} />`;
  return html`
    <div class="bt-home">
      <${Sky}>
        <div class="bt-top"><div class="bt-title"><h2 class="bt-head" tabindex="-1">${t('Stops')}</h2></div></div>
      <//>
      <h3 class="bt-section eyebrow">${t('Pinned')}</h3>
      ${pins}
      <div class="bt-section"><h3 class="eyebrow">${t('Services')}</h3><span>${t('Tap one to see its whole line.')}</span></div>
      ${routes.length ? html`<${Lines} routes=${routes} />` : html`<p class="hint bt-empty">${t('Checking…')}</p>`}
    </div>
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
          go(d.kind === 'service' ? lineHash(d.code, null) : stopHash(d.code));
        }}
      />
    </div>
  `;
}

/** What a page at address `hash` in the tab is called on a Back button: the home, a stop, a service. */
function placeName(hash) {
  const r = parse(hash);
  return r.kind === 'stop' ? stopName(r.code) : r.kind === 'line' ? r.svc : t('Stops');
}

/** Back, named for where it goes: the page before in the tab, else `parent`. */
function BackBar({ parent }) {
  const label = placeName(trail.at(-1) ?? parent);
  return html`
    <nav class="bt-nav" aria-label=${t('Back')}>
      <button type="button" class="bt-back" aria-label=${t('Back to {0}', label)} onClick=${() => back(parent)}><${Icon} paths=${BACK} /><span>${label}</span></button>
    </nav>
  `;
}

/** A stop's board on a page of its own: from the home, the search, a line or Nearby. */
function StopPage({ code }) {
  const p = useStore(profile);
  useStore(campus);
  const pinned = (p?.pinnedStops ?? []).includes(code);
  return html`
    <section class="bt-page alone">
      <${StopView} code=${code} above=${html`<${BackBar} parent="#buses" />`} kicker=${pinned ? html`<${Icon} paths=${STAR} class="bt-kicker-icon star" />${t('Pinned')}` : null} />
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
  if (r.running === false)
    return html`<span class="bt-yours"><span class="bt-big none">${stoppedWords(r.stopped, r.resumesAt, tick.get())[0]}</span></span>`;
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

  const color = data?.color ?? colorOf(svc);
  const r = c?.routes[svc];
  const where = r && routeWords(r);
  const head = html`
    <${Sky}>
      <${BackBar} parent="#buses" />
      <div class="bt-line-title">
        <${Chip} svc=${svc} color=${color} cls="bt-chip big" />
        <div><h2 class="bt-head" tabindex="-1">${svc}</h2>${where && html`<p class="hint">${where}</p>`}</div>
      </div>
    <//>
  `;
  if (!data) return html`${head}<p class="hint bt-empty">${mine?.error ?? t('Checking…')}</p>`;

  // A loop's first stop is listed again at its end: one stop, two rows.
  const n = new Set(data.stops.map((s) => s.code)).size;
  // Not running: its stops, no buses, and why.
  const stopped = data.running === false;
  const buses = data.available && !stopped ? data.buses : [];
  const running =
    buses.length === 0 ? t('No buses running') : buses.length === 1 ? t('1 bus running') : t('{0} buses running', buses.length);
  const ends = data.endsAt && Date.parse(data.endsAt) > now ? t('Runs until {0}', clock(data.endsAt)) : null;
  const yours = data.stop?.index ?? -1;
  return html`
    ${head}
    ${
      stopped
        ? html`<p class="bt-stopped-note">${stoppedWords(data.stopped, data.resumesAt, now)
            .filter(Boolean)
            .map((w, i) => html`<span key=${i}>${w}</span>`)}</p>`
        : html`<p class="bt-summary">${[data.available ? running : null, ends].filter(Boolean).join(' · ')}</p>`
    }
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
              <span class="bt-bus-info"><${Plate} b=${b} /><span>${t('Next: {0}', longName(data.stops[i + 1] ?? data.stops[0]))}</span></span>
            </li>`,
          )}
        `;
      })}
    </ol>
  `;
}

/**
 * The tab. `visible`: it's on screen (refreshing stops otherwise).
 * `locate`: where you are, for the walk to each pinned stop (app.js), never asking.
 */
export function BusesTab({ visible, locate: where = null }) {
  const r = useStore(route);
  if (where) locate = where;
  const home = visible && r.kind === 'home';

  useEffect(() => {
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!visible) return;
    // Come in from another tab (Nearby's links, the tab bar): Back goes up
    // the tab, to the home, not back through what was before.
    trail.length = 0;
    route.set(parse(location.hash));
    // Fresh each time it's shown: the pins may have changed on another device.
    loadCampus().catch(() => {});
    reloadProfile()
      .catch(() => {})
      .then(() => {
        if (route.get().kind === 'home') freshenSigns();
      });
    const now = route.get();
    if (now.kind === 'stop') showBoard(now.code);
    else if (now.kind === 'line') loadLine(now.svc, now.stop);
    nextTimedAt = Date.now() + REFRESH_MS;
    const timer = setInterval(() => {
      nextTimedAt = Date.now() + REFRESH_MS;
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
    const clockTimer = setInterval(() => tick.set(serverNow()), 5_000);
    const back = () => {
      if (document.visibilityState !== 'visible') return;
      tick.set(serverNow());
      refresh({ back: true });
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      nextTimedAt = 0;
      clearInterval(timer);
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [visible]);

  // The lines' counts while the home is on screen and the app in front: at once, then each LINES_MS
  // (loadOuts keeps to that; checked more often so a timer firing early doesn't skip a round).
  useEffect(() => {
    if (!home) return;
    const ask = () => document.visibilityState === 'visible' && loadOuts();
    ask();
    const timer = setInterval(ask, 5_000);
    document.addEventListener('visibilitychange', ask);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [home]);

  if (r.kind === 'line') return html`<${LinePage} svc=${r.svc} stop=${r.stop} />`;
  if (r.kind === 'stop') return html`<${StopPage} code=${r.code} />`;
  // The search at the top of the sky, the home's own sky running on from it.
  return html`<div class="bt-sky-top"><${Find} /></div><${Home} />`;
}
