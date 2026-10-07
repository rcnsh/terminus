// Destination search: the ranking and wording behind the search box
// (search-box.js), a short, ranked, grouped list under a text box. Plain
// functions, so the API's tests import them. This is the reference: the
// Android and Mac apps follow the same rules, written out with the cases
// they're held to in apps/api/test/fixtures/search.json.

import { t } from './dom.js';

// A service (in the Buses tab's search) before a stop that matches as well:
// "a" lists A1 and A2 before AS 5.
const KINDS = { timetable: 0, place: 1, class: 2, service: 3, stop: 4, landmark: 5, building: 6, room: 7 };
/** A kind this page doesn't know yet (a newer server's) still lists, after every known one. */
const kindRank = (kind) => KINDS[kind] ?? 8;
const GROUP = { timetable: t('In your timetable'), place: t('Your favourites'), class: t('Your classes'), service: t('Services'), stop: t('Stops'), landmark: t('Food & places'), building: t('Buildings'), room: t('Rooms') };
const MAX = 8;

/** A code as typed any way: lower case, without spaces, hyphens or underscores ("COM1-0203" is "com10203"). */
const norm = (s) => s.toLowerCase().replace(/[\s\-_]+/g, '');

/** 0 exact, 1 starts with, 2 a word starts with, 3 contains; -1 no match. */
export function score(d, query) {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const names = [d.code.toLowerCase(), d.label.toLowerCase(), ...(d.aliases ?? []).map((a) => a.toLowerCase())];
  // Only hyphens or underscores typed: nothing to match a code by.
  const nq = norm(q);
  const code = nq ? norm(d.code) : null;
  if (names.some((n) => n === q) || code === nq) return 0;
  if (names.some((n) => n.startsWith(q)) || (code !== null && code.startsWith(nq))) return 1;
  if (names.some((n) => n.split(/[\s()·,/&-]+/).some((w) => w && w.startsWith(q)))) return 2;
  if (names.some((n) => n.includes(q))) return 3;
  return -1;
}

/** The best few (MAX), most useful first. Rooms only once the query says which. Ties keep `dests`' order. */
export function rank(dests, query) {
  const q = query.trim();
  return dests
    .filter((d) => d.kind !== 'room' || q.length >= 2)
    .map((d) => ({ d, s: score(d, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || kindRank(a.d.kind) - kindRank(b.d.kind) || a.d.label.length - b.d.label.length)
    .slice(0, MAX)
    .map((x) => x.d);
}

const walkMin = (m, speedMs) => Math.max(1, Math.round(m / speedMs / 60));

/** What a result's group is called in the list. */
export const groupOf = (d) => GROUP[d.kind] ?? t('Other places');

/** The line under a result: where it takes you. `stopName(code)` names a stop. */
export function metaOf(d, stopName, speedMs = 1.3) {
  if (d.kind === 'timetable' || d.kind === 'service') return d.detail;
  if (d.kind === 'stop') return t('Bus stop');
  if (d.kind === 'place' || d.kind === 'class') return t('{0} stop', stopName(d.stopCode));
  // Served by more than one stop: the quicker one is used at the time.
  if (d.kind === 'landmark') return `${d.detail ? `${d.detail} · ` : ''}${t('{0} stop', d.stops.map(stopName).join(t(' or ')))}`;
  const code = d.label !== d.code ? `${d.code} · ` : '';
  return `${code}${t('{0} stop', stopName(d.stopCode))}${d.walkM != null ? t(', {0} min walk', walkMin(d.walkM, speedMs)) : ''}`;
}

/** The results for `query`: `pinned` first whenever they match, in their own group. */
export function results(query, { source, suggestions, pinned = () => [] }) {
  const q = query.trim();
  if (!q) return suggestions();
  const top = rank(pinned(), q);
  return [...top, ...rank(source(), q).filter((d) => !top.some((x) => x.code === d.code))].slice(0, MAX);
}

/** What a picked result puts in the box: a room or a code by its code, anything else by its name. */
export const pickedText = (d) => (d.kind === 'room' || d.label === d.code ? d.code : d.label);

/** The stop a picked result goes to: a place with several stops is kept whole, so the router can pick. */
export const pickedStop = (d) => (d.kind === 'landmark' ? d.code : d.stopCode);

/**
 * The Buses tab's search, from /campus `c`: every service, by its code
 * (with where it runs), then every stop by its long name, found by that, its
 * short name, its code and the nicknames /campus has for it ("library").
 */
export function busesTabIndex(c) {
  if (!c) return [];
  const byCode = new Map(c.stops.map((s) => [s.code, s]));
  // As people say it ("Yusof Ishak House"), not its sign's short name ("YIH").
  const longName = (code) => byCode.get(code)?.longName ?? byCode.get(code)?.name ?? code;
  const services = Object.entries(c.routes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([svc, r]) => {
      const first = longName(r.seq[0]);
      return { kind: 'service', code: svc, label: svc, detail: r.loop ? t('Loop from {0}', first) : t('{0} to {1}', first, longName(r.seq.at(-1))) };
    });
  const aliases = new Map((c.destinations ?? []).filter((d) => d.kind === 'stop').map((d) => [d.code, d.aliases ?? []]));
  const stops = c.stops.map((s) => ({ kind: 'stop', code: s.code, stopCode: s.code, label: s.longName ?? s.name, aliases: [s.name.toLowerCase(), ...(aliases.get(s.code) ?? [])] }));
  return [...services, ...stops];
}
