// Destination search: the ranking and wording behind the search box
// (search-box.js), a short, ranked, grouped list under a text box. Plain
// functions, so the API's tests import them, and the Android and Mac apps
// copy their rules.

import { t } from './dom.js';

const KINDS = { timetable: 0, place: 1, class: 2, stop: 3, landmark: 4, building: 5, room: 6 };
const GROUP = { timetable: t('In your timetable'), place: t('Your favourites'), class: t('Your classes'), stop: t('Stops'), landmark: t('Food & places'), building: t('Buildings'), room: t('Rooms') };
const MAX = 8;

const norm = (s) => s.toLowerCase().replace(/[\s\-_]+/g, '');

/** 0 exact, 1 starts with, 2 a word starts with, 3 contains; -1 no match. */
export function score(d, query) {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const names = [d.code.toLowerCase(), d.label.toLowerCase(), ...(d.aliases ?? [])];
  const nq = norm(q);
  if (names.some((n) => n === q) || norm(d.code) === nq) return 0;
  if (names.some((n) => n.startsWith(q)) || norm(d.code).startsWith(nq)) return 1;
  if (names.some((n) => n.split(/[\s()·,/&-]+/).some((w) => w && w.startsWith(q)))) return 2;
  if (names.some((n) => n.includes(q))) return 3;
  return -1;
}

/** The best few, most useful first. Rooms only once the query says which. */
export function rank(dests, query) {
  const q = query.trim();
  return dests
    .filter((d) => d.kind !== 'room' || q.length >= 2)
    .map((d) => ({ d, s: score(d, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || KINDS[a.d.kind] - KINDS[b.d.kind] || a.d.label.length - b.d.label.length)
    .slice(0, MAX)
    .map((x) => x.d);
}

const walkMin = (m) => Math.max(1, Math.round(m / 1.3 / 60));

/** What a result's group is called in the list. */
export const groupOf = (d) => GROUP[d.kind];

/** The line under a result: where it takes you. `stopName(code)` names a stop. */
export function metaOf(d, stopName) {
  if (d.kind === 'timetable') return d.detail;
  if (d.kind === 'stop') return t('Bus stop');
  if (d.kind === 'place' || d.kind === 'class') return t('{0} stop', stopName(d.stopCode));
  // Served by more than one stop: the quicker one is used at the time.
  if (d.kind === 'landmark') return `${d.detail ? `${d.detail} · ` : ''}${t('{0} stop', d.stops.map(stopName).join(t(' or ')))}`;
  const code = d.label !== d.code ? `${d.code} · ` : '';
  return `${code}${t('{0} stop', stopName(d.stopCode))}${d.walkM != null ? t(', {0} min walk', walkMin(d.walkM)) : ''}`;
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
