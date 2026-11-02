// The Stops tab: what's coming at any stop, and where a service's buses are
// along its line. Loaded the first time the tab is opened (app.js).
//
// Its home is the stops you've pinned, each with its first few rows
// (/api/arrivals), then every service. The stops around you are Nearby's
// job, on Now. A service tapped on a board opens its line (/api/line), and a
// stop on the line opens its board.
// Where you are in the tab is in the address (#buses, #buses/stop/YIH,
// #buses/line/D1/YIH), so Back and a reload keep it.
//
// Only the times the API gives are shown: `later` is every later bus the
// feed reported, and a line shows no times at stops other than yours.

import { Icon, focusSoon, html, store, useEffect, useMemo, useRef, useStore } from '/assets/ui.js';
import { clock, send, serverNow, signedOut, t } from '/account/dom.js';
import { campus, loadCampus, profile, reloadProfile, togglePin } from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { Celestial, Horizon } from '/account/sky.js';
import { busesTabIndex } from '/account/search.js';
import { Big, Chip, Crowd, Quality, Row, colorOf, stoppedWords, svcVars, thenText } from '/app/board.js';
import { PULL_FRESH_MS } from '/app/timing.js';

/** The page on screen refreshes this often (the API caches arrivals 15 s). */
const REFRESH_MS = 15_000;
/** A pinned stop's rows on the home; the rest are on its own page. */
const PINNED_ROWS = 3;
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

export async function loadLine(svc, stop) {
  const key = `${svc}/${stop ?? ''}`;
  // As for a board: a call that hung can end after a newer one, and mustn't
  // put back older buses, or an error over fresh ones.
  const asked = Date.now();
  const newer = () => line.get()?.key === key && line.get().at > asked;
  try {
    const data = await getJSON(`/api/line?svc=${encodeURIComponent(svc)}${stop ? `&stop=${encodeURIComponent(stop)}` : ''}`);
    if (lineKey() === key && !newer()) line.set({ key, data, at: Date.now(), got: serverNow(), asOf: asOfMs(data) });
  } catch (err) {
    if (err.message === 'signed out' || lineKey() !== key || newer()) return;
    const was = line.get()?.key === key ? line.get() : null;
    const error = err.status === 400 ? t('No line to show for {0}.', svc) : failedWords(Boolean(was?.data));
    line.set({ ...was, key, error });
  }
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
  return Promise.all(pins().map((code) => loadBoard(code)));
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
    return (r.kind === 'stop' ? [shownCode(r.code)] : pins()).map((code) => boards.get().get(code));
  };
  const fresh = (b) => b?.at && !b.error && Date.now() - b.at < PULL_FRESH_MS;
  // Nothing pinned: nothing on the home to fetch.
  if (shown().every(fresh)) return { state: 'fresh', inS: nextTimedAt ? Math.max(1, Math.ceil((nextTimedAt - Date.now()) / 1000)) : null };
  const asked = Date.now();
  await refreshNow();
  return shown().every((b) => b?.at >= asked && !b.error) ? 'updated' : 'failed';
}

/** A board just brought on screen: fetched unless it's fresh. */
function showBoard(code) {
  if (!code) return;
  const b = boards.get().get(shownCode(code));
  if (!b?.at || Date.now() - b.at > REFRESH_MS) loadBoard(shownCode(code));
}

export { togglePin };

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
const STAR = '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/>';
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
      ?.map((x) => ({ ...x, etaS: x.etaS - s, ...(x.quality === 'live' ? { quality: 'stale' } : {}) }))
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

/** The star that pins stop `code` (called `name`), filled while it's pinned. `cls` for a smaller one. */
function Star({ code, name, cls = '' }) {
  const p = useStore(profile);
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

/** How a service runs, as under its name on its line: "Loop from COM 3", "Kent Ridge MRT to UTown". */
const routeWords = (r) => (r.loop ? t('Loop from {0}', stopName(r.seq[0])) : t('{0} to {1}', stopName(r.seq[0]), stopName(r.seq.at(-1))));

/**
 * A pinned stop on the home: its name, which opens its page, and its star;
 * its first PINNED_ROWS rows, then the way to the rest on its page.
 */
function PinnedStop({ code }) {
  const all = useStore(boards);
  const now = useStore(tick);
  useStore(campus);
  // Its times when it comes on the home: pinned just now, or from the start.
  useEffect(() => showBoard(code), [code]);
  const b = all.get(code);
  const name = longName(b?.stop) ?? stopName(code);
  const rows = b?.board?.map((r) => aged(r, b.got, now)) ?? [];
  const more = rows.length - PINNED_ROWS;
  let body;
  if (!b?.board) body = html`<p class="hint bt-empty">${b?.error ?? t('Checking…')}</p>`;
  else if (!rows.length) body = html`<p class="hint bt-empty">${b.available ? t('No buses due') : t('No times right now')}</p>`;
  else
    body = html`
      <div class="card bt-board">
        ${rows.slice(0, PINNED_ROWS).map((r) => html`<${Row} key=${r.svc} r=${r} now=${now} chevron onPick=${(svc) => go(lineHash(svc, code))} />`)}
        ${more > 0 && html`<button type="button" class="bt-more" onClick=${() => openStop(code)}><span>${t('{0} more at this stop', more)}</span><${Icon} paths=${NEXT} class="bt-go" /></button>`}
      </div>
      ${b.error && html`<p class="bt-pin-error"><span class="bt-error">${b.error}</span></p>`}
    `;
  return html`
    <section class="bt-pin" aria-label=${name}>
      <div class="bt-pin-head">
        <button type="button" class="bt-pin-name" onClick=${() => openStop(code)}><span>${name}</span><${Icon} paths=${NEXT} /></button>
        <${Star} code=${code} name=${name} cls="small" />
      </div>
      ${body}
    </section>
  `;
}

/**
 * The home: your pinned stops, each with its first rows, then every
 * service, which opens its line. The stops around you are on Now (Nearby).
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
  else pins = pinned.map((code) => html`<${PinnedStop} key=${code} code=${code} />`);
  return html`
    <div class="bt-home">
      <${Sky}>
        <div class="bt-top"><div class="bt-title"><h2 class="bt-head" tabindex="-1">${t('Stops')}</h2></div></div>
      <//>
      <h3 class="bt-section eyebrow">${t('Pinned')}</h3>
      ${pins}
      <div class="bt-section"><h3 class="eyebrow">${t('Services')}</h3><span>${t('Tap one to see its whole line.')}</span></div>
      ${
        routes.length
          ? html`<div class="card bt-services">
              ${routes.map(
                ([svc, r]) => html`<button type="button" key=${svc} class="bt-service" onClick=${() => go(lineHash(svc, null))}>
                  <${Chip} svc=${svc} color=${r.color} cls="bt-chip" />
                  <span>${routeWords(r)}</span>
                  <${Icon} paths=${NEXT} class="bt-go" />
                </button>`,
              )}
            </div>`
          : html`<p class="hint bt-empty">${t('Checking…')}</p>`
      }
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

function BackBar({ label, parent }) {
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
      <${StopView} code=${code} above=${html`<${BackBar} label=${t('Stops')} parent="#buses" />`} kicker=${pinned ? html`<${Icon} paths=${STAR} class="bt-kicker-icon star" />${t('Pinned')}` : null} />
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

  const label = stop ? (longName(data?.stops.find((s) => s.code === stop)) ?? stopName(stop)) : t('Stops');
  const parent = stop ? stopHash(stop) : '#buses';
  const color = data?.color ?? colorOf(svc);
  const r = c?.routes[svc];
  const where = r && routeWords(r);
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
              <span class="bt-bus-info"><${Plate} b=${b} /><span>${t('Next: {0}', longName(data.stops[(i + 1) % n]))}</span></span>
            </li>`,
          )}
        `;
      })}
    </ol>
  `;
}

/** The tab. `visible`: it's on screen (refreshing stops otherwise). */
export function BusesTab({ visible }) {
  const r = useStore(route);

  useEffect(() => {
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!visible) return;
    route.set(parse(location.hash));
    // Fresh each time it's shown: the pins may have changed on another device.
    loadCampus().catch(() => {});
    reloadProfile()
      .catch(() => {})
      .then(() => {
        if (route.get().kind === 'home') for (const code of pins()) showBoard(code);
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

  if (r.kind === 'line') return html`<${LinePage} svc=${r.svc} stop=${r.stop} />`;
  if (r.kind === 'stop') return html`<${StopPage} code=${r.code} />`;
  // The search at the top of the sky, the home's own sky running on from it.
  return html`<div class="bt-sky-top"><${Find} /></div><${Home} />`;
}
