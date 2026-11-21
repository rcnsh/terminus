import {
  Bar,
  Icon,
  Skeleton,
  focusSoon,
  html,
  reducedMotion,
  store,
  useEffect,
  useMedia,
  useMemo,
  useRef,
  useStore,
  widthOf,
} from '/assets/ui.js';
import { clock, hour12, send, serverNow, signedOut, t } from '/account/dom.js';
import { campus, loadCampus, profile, reloadProfile, togglePin } from '/account/profile.js';
import { SearchBox } from '/account/search-box.js';
import { Band, Celestial, Horizon } from '/account/sky.js';
import { busesTabIndex, groupKey, groupOf, grouped, results } from '/account/search.js';
import {
  NEXT,
  STAR,
  Big,
  Chip,
  Crowd,
  Quality,
  Row,
  ServicesSkeleton,
  WaitingRows,
  colorOf,
  stoppedWords,
  svcVars,
  thenText,
} from '/app/board.js';
import { NoPins, PinnedSkeleton, StopSign, anyGuess } from '/app/sign.js';
import { PULL_FRESH_MS } from '/app/timing.js';

const REFRESH_MS = 15_000;
const LINES_MS = 60_000;
const OLD_MS = 2 * REFRESH_MS;
const ENDS_SOON_MS = 2 * 3600_000;

export const route = store({ kind: 'home' });
export const boards = store(new Map());
export const signs = store(new Map());
export const chosen = store(null);
export const ADD = '+';
export const outs = store(null);
export const across = store(new Set());
export const line = store(null);
const tick = store(serverNow());
async function getJSON(path) {
  const res = await send(path, { credentials: 'same-origin', headers: { 'accept-language': window.i18n?.header ?? 'en' } });
  if (res.status === 401) await signedOut();
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const stopOf = (code) => campus.get()?.stops.find((s) => s.code === code) ?? null;
const longName = (s) => s?.longName ?? s?.name;
const stopName = (code) => longName(stopOf(code)) ?? code;
const pins = () => profile.get()?.pinnedStops ?? [];
let pinsShown = [];
export function pageOf(pinned, pick, was = pinsShown) {
  if (pick === ADD) return pinned.length;
  const i = pinned.indexOf(pick);
  if (i >= 0 || pick == null) return Math.max(0, i);
  return Math.min(Math.max(0, was.indexOf(pick)), Math.max(0, pinned.length - 1));
}
export function signWindow(pinned = pins(), pick = chosen.get()) {
  const i = pageOf(pinned, pick);
  return [pinned[i - 1], pinned[i], pinned[i + 1]].filter(Boolean);
}
let locate = async () => null;
export const oppositeOf = (code) => boards.get().get(code)?.stop?.opposite ?? stopOf(code)?.opposite ?? null;
export const shownCode = (code) => (across.get().has(code) && oppositeOf(code)) || code;

const asOfMs = (data) => Date.parse(data?.asOf ?? '') || serverNow();

function keep(code, entry) {
  boards.set((m) => new Map(m).set(code, entry));
}

export const failedWords = (shown, online = navigator.onLine) =>
  !online ? t('Live times need a connection.') : shown ? t("Couldn't update. Trying again soon.") : t('No times right now');

const fetching = new Set();

export async function loadBoard(code) {
  const pub = profile.get()?.publicBuses ? '&public=1' : '';
  const asked = Date.now();
  const newer = () => boards.get().get(code)?.at > asked;
  try {
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

export async function loadSigns(codes) {
  if (!codes.length) return;
  const asked = Date.now();
  const newer = (code) => signs.get().get(code)?.at > asked;
  try {
    const fix = await locate().catch(() => null);
    const q = new URLSearchParams({ codes: codes.join(','), ...fix });
    if (hour12()) q.set('h12', '1');
    q.set('stopped', '1');
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

const signsFetching = new Set();
function freshenSigns() {
  const want = signsToAsk().filter((code) => !signsFetching.has(code) && !(Date.now() - (signs.get().get(code)?.at ?? 0) < REFRESH_MS));
  if (!want.length) return;
  for (const code of want) signsFetching.add(code);
  loadSigns(want).finally(() => {
    for (const code of want) signsFetching.delete(code);
  });
}

let linesAt = 0;
const pageOuts = new Map();
let listAt = 0;
export async function loadOuts() {
  if (Date.now() - linesAt < LINES_MS) return;
  linesAt = Date.now();
  try {
    const data = await getJSON('/api/lines');
    const lines = { ...data.lines };
    listAt = asOfMs(data);
    for (const [svc, p] of pageOuts) if (p.at > listAt) lines[svc] = p.out;
    outs.set(lines);
  } catch {
    outs.set(null);
  }
}

export async function loadLine(svc, stop) {
  const key = `${svc}/${stop ?? ''}`;
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

let pending = null;
let nextTimedAt = 0;

function refresh({ back = false } = {}) {
  if (pending && !back) return;
  const mine = refreshNow()?.finally(() => {
    if (pending === mine) pending = null;
  });
  pending = mine;
}
function refreshNow() {
  const r = route.get();
  const page = r.kind === 'line' ? loadLine(r.svc, r.stop) : r.kind === 'stop' ? loadBoard(shownCode(r.code)) : null;
  if (!page) return loadSigns(signWindow());
  return split ? Promise.all([page, loadSigns(signsToAsk())]) : page;
}

export function signsToAsk() {
  const r = route.get();
  const open = split && r.kind === 'stop' ? shownCode(r.code) : null;
  return signWindow().filter((code) => code !== open || !signs.get().get(code)?.s);
}

export async function pullRefresh() {
  const r = route.get();
  const shown = () => {
    if (r.kind === 'line') return [line.get()?.key === lineKey() ? line.get() : null];
    if (r.kind === 'stop') return [boards.get().get(shownCode(r.code))];
    const code = pins()[pageOf(pins(), chosen.get())];
    return code ? [signs.get().get(code)] : [];
  };
  const fresh = (b) => b?.at && !b.error && Date.now() - b.at < PULL_FRESH_MS;
  if (!shown().length) return { state: 'fresh', inS: null };
  if (shown().every(fresh)) return { state: 'fresh', inS: nextTimedAt ? Math.max(1, Math.ceil((nextTimedAt - Date.now()) / 1000)) : null };
  const asked = Date.now();
  await refreshNow();
  return shown().every((b) => b?.at >= asked && !b.error) ? 'updated' : 'failed';
}

function freshen(code) {
  const b = boards.get().get(code);
  if (fetching.has(code)) return;
  if (!b?.at || Date.now() - b.at > REFRESH_MS) {
    fetching.add(code);
    loadBoard(code).finally(() => fetching.delete(code));
  }
}
function showBoard(code) {
  if (code) freshen(shownCode(code));
}

export function parse(hash) {
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

const trail = [];
function go(hash) {
  trail.push(location.hash);
  location.hash = hash;
}
let split = false;
function openFromHome(hash) {
  if (!split) return go(hash);
  if (location.hash === hash) return;
  trail.length = 0;
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
  if (trail.at(-1) === location.hash) trail.pop();
  const next = parse(location.hash);
  const was = route.get();
  if (JSON.stringify(next) === JSON.stringify(was)) return;
  const kept = split && was.kind === 'stop' && pins().includes(was.code) ? signWithBoard(was.code) : null;
  if (kept) signs.set((m) => new Map(m).set(was.code, kept));
  route.set(next);
  window.scrollTo(0, 0);
  if (document.activeElement !== document.body) focusSoon(headOnScreen, { preventScroll: true });
  if (next.kind === 'stop') showBoard(next.code);
  else if (next.kind === 'line') loadLine(next.svc, next.stop);
}

const headOnScreen = () => document.querySelector('#tab-buses .bt-detail .bt-head') ?? document.querySelector('#tab-buses .bt-head');

export const stopHash = (code) => `#buses/stop/${encodeURIComponent(code)}`;
export const lineHash = (svc, stop) => `#buses/line/${encodeURIComponent(svc)}${stop ? `/${encodeURIComponent(stop)}` : ''}`;
const openStop = (code) => go(stopHash(code));

const SEARCH = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>';
const BACK = '<path d="m15 5-7 7 7 7"/>';
const CLEAR = '<path d="M6 6l12 12M18 6 6 18"/>';
const BUS = '<rect x="5" y="3.5" width="14" height="13.5" rx="3"/><path d="M5 10.5h14M8 17v2.5M16 17v2.5"/>';
const PIN = '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>';

export function aged(r, got, now) {
  const s = (now - got) / 1000;
  if (r?.etaS == null || !(s * 1000 > OLD_MS)) return r;
  const left = r.etaS - s;
  return {
    ...r,
    old: true,
    eta: null,
    etaS: left > -60 ? Math.max(0, left) : null,
    quality: r.quality === 'live' ? 'stale' : r.quality,
    laterText: null,
    later: r.later
      ?.map((x) => ({ ...x, etaS: x.etaS - s, eta: null, ...(x.quality === 'live' ? { quality: 'stale' } : {}) }))
      .filter((x) => x.etaS > 0),
  };
}

function Updated({ asOf, live = false }) {
  const now = useStore(tick);
  if (!asOf) return null;
  const s = Math.max(0, Math.round((now - asOf) / 1000));
  return html`<span class="bt-updated">${live && html`<span class="bt-live"><span class="dot" aria-hidden="true"></span>${t('Live')}</span> · `}${s < 5 ? t('Updated just now') : s < 60 ? t('Updated {0} s ago', s) : t('Updated {0} min ago', Math.floor(s / 60))}</span>`;
}

function Status({ asOf, error, live }) {
  return html`${error && html`<span class="bt-error">${error}</span>`}<${Updated} asOf=${asOf} live=${live} />`;
}

function Board({ code }) {
  const all = useStore(boards);
  const now = useStore(tick);
  const b = all.get(code);
  if (b?.error && !b.board) return html`<p class="hint bt-empty">${b.error}</p>`;
  if (!b?.board) {
    return html`
      <${Skeleton} said=${t('Checking…')} quiet>
        <div class="card bt-board"><${WaitingRows} services=${stopOf(code)?.services} chevron /></div>
        <div class="bt-foot"><div class="bt-ends"></div><div class="bt-status"><span class="bt-updated"><${Bar} w="7rem" /></span></div></div>
      <//>
    `;
  }
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
  `;
}

const Sky = ({ children }) =>
  html`<div class="bt-sky"><div class="sky-head"><${Celestial} band />${children}</div><${Horizon} on=${null} low /></div>`;

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

function StopView({ code, kicker, above = null }) {
  const all = useStore(boards);
  const side = useStore(across);
  useStore(campus);
  const own = all.get(code)?.stop;
  const opposite = own?.opposite ?? stopOf(code)?.opposite ?? null;
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

const routeWords = (r) =>
  r.name ?? (r.loop ? t('Loop from {0}', stopName(r.seq[0])) : t('{0} to {1}', stopName(r.seq[0]), stopName(r.seq.at(-1))));

const plateName = (code) => signs.get().get(code)?.s?.stop.name ?? stopOf(code)?.name ?? code;

const agedSign = (s, got, now) => ({ ...s, board: s.board.map((r) => aged(r, got, now)) });

export function withBoard(s, got, board) {
  const gone = Math.trunc((board.got - got) / 1000);
  const on = (x) => ({ ...x, etaS: x.etaS == null ? null : x.etaS - gone, eta: null });
  const guesses = (row) =>
    (row.later ?? [])
      .filter((x) => x.quality === 'scheduled' && x.etaS != null)
      .map(on)
      .filter((x) => x.etaS > 0);
  const left = board.board.filter((b) => !b.paid);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const matched = s.board.map(() => null);
  const take = (test) =>
    s.board.forEach((row, n) => {
      if (matched[n]) return;
      const i = left.findIndex((b) => test(row, b));
      if (i >= 0) matched[n] = left.splice(i, 1)[0];
    });
  take((row, b) => b.svc === row.svc && same(b.towards, row.towards));
  take((row, b) => b.svc === row.svc);
  const rows = s.board.map((row, n) => {
    const b = matched[n];
    if (!b) {
      if (row.etaS == null || gone <= 0) return row;
      const at = on(row);
      return {
        ...at,
        etaS: at.etaS > -60 ? Math.max(0, at.etaS) : null,
        quality: row.quality === 'live' ? 'stale' : row.quality,
        later: guesses(row),
        laterText: null,
      };
    }
    const later = b.later ?? [];
    const shown = (b.etaS != null ? 1 : 0) + later.length;
    const after = [row, ...(row.later ?? [])]
      .filter((x) => x.etaS != null)
      .map(on)
      .filter((x) => x.etaS > 0)
      .slice(shown)
      .filter((x) => x.quality === 'scheduled');
    return {
      ...row,
      etaS: b.etaS,
      eta: b.eta,
      quality: b.quality,
      crowd: b.crowd,
      running: b.running,
      stopped: b.stopped,
      resumesAt: b.resumesAt,
      later: [...later, ...after].slice(0, Math.max(later.length, (row.later?.length ?? 0) + (b.etaS != null ? 0 : 1))),
      laterText: null,
    };
  });
  return { ...s, board: rows, available: board.available };
}

function signWithBoard(code) {
  const own = signs.get().get(code);
  const board = boards.get().get(code);
  if (!own?.s || !board?.board || !(board.at > own.at) || shownCode(code) !== code) return null;
  return { s: withBoard(own.s, own.got, board), at: board.at, got: board.got, error: board.error };
}

function PinPage({ code, entry: own, pinned, now, open }) {
  useStore(boards);
  const entry = (open && signWithBoard(code)) || own;
  const s = entry?.s
    ? agedSign(entry.s, entry.got, now)
    : { stop: { code, name: plateName(code) }, walkS: null, available: true, board: [] };
  const note = entry?.s ? null : entry?.gone ? t('No times right now') : (entry?.error ?? null);
  const waiting = !entry?.s && !note;
  return html`
    <div
      class=${open ? 'bt-pager-page open' : 'bt-pager-page'}
      role="group"
      aria-label=${s.stop.name}
      aria-current=${open ? 'true' : undefined}
      data-answered=${entry?.s ? '' : undefined}
    >
      <div class="nearby">
        <${StopSign}
          s=${s}
          pinned=${pinned}
          note=${note}
          waiting=${waiting}
          services=${stopOf(code)?.services}
          onStop=${(at) => openFromHome(stopHash(at))}
          onLine=${(svc, at) => openFromHome(lineHash(svc, at))}
        />
        ${entry?.s && entry.error && html`<p class="bt-pin-error"><span class="bt-error">${entry.error}</span></p>`}
        ${!note && anyGuess([s]) && html`<p class="nb-foot">${t('~ is a guess from the timetable, not a live time.')}</p>`}
      </div>
    </div>
  `;
}

function PinnedStops({ pinned }) {
  const pick = useStore(chosen);
  const r = useStore(route);
  const all = useStore(signs);
  const now = useStore(tick);
  useStore(campus);
  const pager = useRef(null);
  const segs = useRef(null);
  const swiped = useRef(false);
  const moved = useRef(false);
  const gone = pick != null && pick !== ADD && !pinned.includes(pick);
  const openPin = split && r.kind === 'stop' && pinned.includes(r.code) ? r.code : null;
  useEffect(() => {
    if (openPin && chosen.get() !== openPin) chosen.set(openPin);
  }, [openPin]);
  const index = pageOf(pinned, openPin ?? pick);
  const at = useRef(index);
  at.current = index;
  const settle = useRef(0);
  const leftOf = (el, i) => i * (el.children[1] ? el.children[1].offsetLeft - el.children[0].offsetLeft : el.clientWidth);
  const choose = (code) => {
    clearTimeout(settle.current);
    chosen.set(code);
  };

  useEffect(() => {
    pinsShown = pinned;
    if (gone) chosen.set(pinned[index]);
  }, [pinned.join()]);

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

  const fit = () => {
    const el = pager.current;
    if (!el) return;
    const x = el.scrollLeft / (leftOf(el, 1) || 1);
    const shown = [Math.floor(x), Math.ceil(x)].map((n) => el.children[n]?.offsetHeight ?? 0);
    el.style.height = `${Math.max(...shown)}px`;
  };
  useEffect(fit);
  useEffect(() => {
    const el = pager.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        el.style.height = '';
        el.scrollLeft = leftOf(el, at.current);
      }
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    fit();
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
      ${pinned.map((code) => html`<${PinPage} key=${code} code=${code} entry=${all.get(code)} pinned=${pinned} now=${now} open=${r.kind === 'stop' && r.code === code} />`)}
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

function Lines({ routes }) {
  const counts = useStore(outs);
  const open = useStore(route);
  return html`
    <div class="card bt-services">
      ${routes.map(([svc, r]) => {
        const name = routeWords(r);
        const via = r.via ?? null;
        const n = counts?.[svc] ?? null;
        return html`<button
          type="button"
          key=${svc}
          class="bt-service"
          aria-label=${[t('Bus {0}', svc), name, via, n?.outText].filter(Boolean).join(t(', '))}
          aria-current=${open.kind === 'line' && open.svc === svc ? 'true' : undefined}
          onClick=${() => openFromHome(lineHash(svc, null))}
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

const HomeSky = () => html`<${Band}><h2 class="tab-title bt-head" tabindex="-1">${t('Stops')}</h2><//>`;

function Home() {
  const p = useStore(profile);
  const c = useStore(campus);
  const pinned = p?.pinnedStops ?? [];
  const routes = Object.entries(c?.routes ?? {});
  let pins;
  if (!p) pins = html`<${PinnedSkeleton} />`;
  else if (!pinned.length) pins = html`<${NoPins} />`;
  else pins = html`<${PinnedStops} pinned=${pinned} />`;
  return html`
    <div class="bt-home">
      <h3 class="bt-section eyebrow">${t('Pinned')}</h3>
      ${pins}
      <div class="bt-section"><h3 class="eyebrow">${t('Services')}</h3><span>${t('Tap one to see its whole line.')}</span></div>
      ${routes.length ? html`<${Lines} routes=${routes} />` : html`<${Skeleton} said=${t('Checking…')} quiet><${ServicesSkeleton} /><//>`}
    </div>
  `;
}

function Find() {
  const c = useStore(campus);
  const box = useRef(null);
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
          openFromHome(d.kind === 'service' ? lineHash(d.code, null) : stopHash(d.code));
        }}
      />
    </div>
  `;
}

export const findText = store('');

function FindWide() {
  const q = useStore(findText);
  const box = useRef(null);
  return html`
    <div class="bt-search">
      <${Icon} paths=${SEARCH} class="bt-search-icon" />
      <input
        type="search"
        ref=${box}
        value=${q}
        placeholder=${t('Search a stop or service')}
        aria-label=${t('Search a stop or service')}
        aria-controls="bt-results"
        autocomplete="off"
        enterkeyhint="search"
        onInput=${(e) => findText.set(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Escape') findText.set('');
          if (e.key === 'Enter') document.querySelector('#bt-results .bt-result')?.click();
        }}
      />
      ${
        q &&
        html`<button
          type="button"
          class="bt-search-clear"
          aria-label=${t('Clear search')}
          onClick=${() => {
            findText.set('');
            box.current?.focus();
          }}
        ><${Icon} paths=${CLEAR} /></button>`
      }
    </div>
  `;
}

function Results() {
  const q = useStore(findText);
  const c = useStore(campus);
  const open = useStore(route);
  const dests = useMemo(() => busesTabIndex(c), [c]);
  const found = grouped(results(q, { source: () => dests }));
  const groups = [];
  for (const d of found) {
    if (groups.at(-1)?.kind !== groupKey(d)) groups.push({ kind: groupKey(d), name: groupOf(d), rows: [] });
    groups.at(-1).rows.push(d);
  }
  const chosenNow = (d) =>
    d.kind === 'service' ? open.kind === 'line' && open.svc === d.code : open.kind === 'stop' && open.code === d.code;
  const row = (d) => {
    const pick = () => openFromHome(d.kind === 'service' ? lineHash(d.code, null) : stopHash(d.code));
    const current = chosenNow(d) ? 'true' : undefined;
    if (d.kind === 'service') {
      return html`<button type="button" key=${`s-${d.code}`} class="bt-service bt-result" aria-current=${current} onClick=${pick}>
        <span class="bt-service-chip"><${Chip} svc=${d.code} color=${c?.routes[d.code]?.color} cls="bt-chip" /></span>
        <span class="bt-service-text"><span class="bt-service-name">${d.detail}</span></span>
        <span class="bt-out"></span>
        <${Icon} paths=${NEXT} class="bt-go" />
      </button>`;
    }
    const services = stopOf(d.code)?.services ?? [];
    return html`<button type="button" key=${`p-${d.code}`} class="bt-result bt-result-stop" aria-current=${current} onClick=${pick}>
      <span class="bt-result-text">
        <span class="bt-result-name">${d.label}</span>
        <span class="bt-result-meta"><span class="bt-result-code">${d.code}</span>${services.map((x) => html`<${Chip} key=${x} svc=${x} cls="tiny" />`)}</span>
      </span>
      <${Icon} paths=${NEXT} class="bt-go" />
    </button>`;
  };
  return html`
    <div class="bt-home" id="bt-results">
      <p class="sr-only" role="status">${found.length === 0 ? '' : found.length === 1 ? t('1 result') : t('{0} results', found.length)}</p>
      ${
        groups.length
          ? groups.map(
              (g) => html`<section key=${g.kind} aria-label=${g.name}>
                <h3 class="bt-section eyebrow">${g.name}</h3>
                <div class=${g.kind === 'service' ? 'card bt-services' : 'card bt-results'}>${g.rows.map(row)}</div>
              </section>`,
            )
          : html`<p class="hint bt-empty">${t('No stop or service by that name')}</p>`
      }
    </div>
  `;
}

function placeName(hash) {
  const r = parse(hash);
  return r.kind === 'stop' ? stopName(r.code) : r.kind === 'line' ? r.svc : t('Stops');
}

function BackBar({ parent }) {
  if (split && parse(trail.at(-1) ?? parent).kind === 'home') return null;
  const label = placeName(trail.at(-1) ?? parent);
  return html`
    <nav class="bt-nav" aria-label=${t('Back')}>
      <button type="button" class="bt-back" aria-label=${t('Back to {0}', label)} onClick=${() => back(parent)}><${Icon} paths=${BACK} /><span>${label}</span></button>
    </nav>
  `;
}

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

const BusMark = ({ between = false }) =>
  html`<span class="bt-bus" aria-hidden="true"><${Icon} paths=${BUS} /></span><span class="sr-only">${between ? t('Bus between stops') : t('Bus here')}</span>`;
const Plate = ({ b }) => html`${b.plate && html`<span class="bt-plate">${b.plate}</span>`}<${Crowd} crowd=${b.crowd} />`;

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

export function campusLine(svc, r, stopsOf = stopOf) {
  const seq = r.loop && r.seq.length > 1 ? [...r.seq, r.seq[0]] : r.seq;
  return seq.map((code) => {
    const s = stopsOf(code);
    return {
      code,
      name: s?.name ?? code,
      longName: s?.longName ?? s?.name ?? code,
      services: (s?.services ?? []).filter((x) => x !== svc),
    };
  });
}

const YourTimeWaiting = () => html`
  <span class="bt-yours" aria-hidden="true"
    ><span class="bt-big"><${Bar} w="3.2rem" h="0.62em" /></span><span class="bt-meta"><${Bar} w="4.5rem" /></span
  ></span>
`;

function LineSkeleton({ color }) {
  return html`
    <${Skeleton} said=${t('Checking…')} quiet>
      <p class="bt-summary"><${Bar} w="40%" /></p>
      <div class="bt-line-label"><span class="eyebrow"><${Bar} w="4rem" /></span><span class="bt-status"><${Bar} w="6rem" /></span></div>
      <ol class="bt-route" style=${`--svc:color-mix(in srgb, ${color} 30%, var(--bg))`}>
        ${Array.from(
          { length: 6 },
          (_, i) => html`<li class="bt-stop" key=${i}>
            <div class="sk-stop">
              <span class="bt-node"></span>
              <span class="bt-stop-text"><span class="bt-stop-name"><${Bar} w=${widthOf(['72%', '30%', '24%', '36%', '42%', '64%'], i)} /></span></span>
            </div>
          </li>`,
        )}
      </ol>
    <//>
  `;
}

function LinePage({ svc, stop }) {
  const l = useStore(line);
  const c = useStore(campus);
  const now = useStore(tick);
  const key = `${svc}/${stop ?? ''}`;
  const mine = l?.key === key ? l : null;
  const data = mine?.data;
  const scrolled = useRef(null);
  const color = data?.color ?? colorOf(svc);
  const r = c?.routes[svc];
  const known = r?.seq?.length > 0;
  const drawn = Boolean(data) || known;
  useEffect(() => {
    if (!drawn || scrolled.current === key) return;
    scrolled.current = key;
    document.querySelector('.bt-stop.mine')?.scrollIntoView({ block: 'center' });
  }, [key, drawn]);
  const arrived = useRef(null);
  useEffect(() => {
    if (!data || arrived.current === key) return;
    arrived.current = key;
    if (data.running === false && stop) window.scrollTo({ top: 0 });
  }, [key, Boolean(data)]);
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
  if (mine?.error && !data) return html`${head}<p class="hint bt-empty">${mine.error}</p>`;
  if (!data && !known) return html`${head}<${LineSkeleton} color=${color} />`;
  const stops = data?.stops ?? campusLine(svc, r);

  const n = new Set(stops.map((s) => s.code)).size;
  const stopped = data?.running === false;
  const buses = data?.available && !stopped ? data.buses : [];
  const running =
    buses.length === 0 ? t('No buses running') : buses.length === 1 ? t('1 bus running') : t('{0} buses running', buses.length);
  const ends = data?.endsAt && Date.parse(data.endsAt) > now ? t('Runs until {0}', clock(data.endsAt)) : null;
  const yours = data ? (data.stop?.index ?? -1) : stop ? stops.findIndex((s) => s.code === stop) : -1;
  return html`
    ${head}
    ${
      !data
        ? html`<p class="bt-summary" aria-hidden="true"><${Bar} w="40%" /></p>`
        : stopped
          ? html`<p class="bt-stopped-note">${stoppedWords(data.stopped, data.resumesAt, now)
              .filter(Boolean)
              .map((w, i) => html`<span key=${i}>${w}</span>`)}</p>`
          : html`<p class="bt-summary">${[data.available ? running : null, ends].filter(Boolean).join(' · ')}</p>`
    }
    ${data && !data.available && !stopped && html`<p class="bt-note">${t('Bus positions are unavailable right now.')}</p>`}
    <div class="bt-line-label">
      <span class="eyebrow">${t('{0} stops', n)}</span>
      <span class="bt-status">${data ? html`<${Status} asOf=${mine.asOf} error=${mine.error} />` : html`<span aria-hidden="true"><${Bar} w="6rem" /></span>`}</span>
    </div>
    <ol class="bt-route" style=${svcVars(color)}>
      ${stops.map((s, i) => {
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
              ${isMine && (data ? html`<${YourTime} r=${aged(data.stop.row, mine.got, now)} />` : html`<${YourTimeWaiting} />`)}
            </button>
          </li>
          ${between.map(
            (b) => html`<li key=${b.id} class="bt-gap">
              <${BusMark} between />
              <span class="bt-bus-info"><${Plate} b=${b} /><span>${t('Next: {0}', longName(stops[i + 1] ?? stops[0]))}</span></span>
            </li>`,
          )}
        `;
      })}
    </ol>
  `;
}

function TabStatus({ r }) {
  const p = useStore(profile);
  const c = useStore(campus);
  const all = useStore(boards);
  const pins = useStore(signs);
  const pick = useStore(chosen);
  const l = useStore(line);
  useStore(across);
  const coming = (x) => !x?.error && !x?.gone;
  let pending;
  if (r.kind === 'line') {
    const mine = l?.key === `${r.svc}/${r.stop ?? ''}` ? l : null;
    pending = !mine?.data && coming(mine);
  } else if (r.kind === 'stop') {
    const b = all.get(shownCode(r.code));
    pending = !b?.board && coming(b);
  } else {
    const pinned = p?.pinnedStops ?? [];
    const shown = pinned[pageOf(pinned, pick)];
    const entry = shown && pins.get(shown);
    pending = !p || !Object.keys(c?.routes ?? {}).length || Boolean(shown && !entry?.s && coming(entry));
  }
  return html`<p class="sr-only" role="status">${pending ? t('Checking…') : ''}</p>`;
}

export function BusesTab({ visible, locate: where = null }) {
  const r = useStore(route);
  if (where) locate = where;
  const wide = useMedia('(min-width: 800px)');
  split = wide;
  const typed = useStore(findText);
  useEffect(() => {
    if (wide && visible) freshenSigns();
  }, [wide]);
  const home = visible && (r.kind === 'home' || wide);

  useEffect(() => {
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!visible) return;
    trail.length = 0;
    route.set(parse(location.hash));
    loadCampus().catch(() => {});
    reloadProfile()
      .catch(() => {})
      .then(() => {
        if (route.get().kind === 'home' || split) freshenSigns();
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

  const status = html`<${TabStatus} r=${r} />`;
  const page =
    r.kind === 'line' ? html`<${LinePage} svc=${r.svc} stop=${r.stop} />` : r.kind === 'stop' ? html`<${StopPage} code=${r.code} />` : null;
  if (!wide) return html`${status}${page ?? html`<${HomeSky} /><div class="bt-find"><${Find} /></div><${Home} />`}`;
  const homePane = html`<${HomeSky} /><div class="bt-find"><${FindWide} /></div>${typed.trim() ? html`<${Results} />` : html`<${Home} />`}`;
  return html`
    ${status}
    <div class="bt-split">
      <div class="bt-list">${homePane}</div>
      <div class="bt-detail">${page ?? html`<${Sky} /><p class="bt-choose">${t('Choose a stop or a service.')}</p>`}</div>
    </div>
  `;
}
