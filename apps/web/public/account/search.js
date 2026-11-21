import { t } from './dom.js';

const KINDS = { timetable: 0, place: 1, class: 2, service: 3, stop: 4, landmark: 5, building: 6, room: 7 };
const kindRank = (kind) => KINDS[kind] ?? 8;
const GROUP = {
  timetable: t('In your timetable'),
  place: t('Your favourites'),
  class: t('Your classes'),
  service: t('Services'),
  stop: t('Stops'),
  landmark: t('Food & places'),
  building: t('Buildings'),
  room: t('Rooms'),
};
const MAX = 8;

const norm = (s) => s.toLowerCase().replace(/[\s\-_]+/g, '');

export function score(d, query) {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const names = [d.code.toLowerCase(), d.label.toLowerCase(), ...(d.aliases ?? []).map((a) => a.toLowerCase())];
  const nq = norm(q);
  const code = nq ? norm(d.code) : null;
  if (names.some((n) => n === q) || code === nq) return 0;
  if (names.some((n) => n.startsWith(q)) || (code !== null && code.startsWith(nq))) return 1;
  if (names.some((n) => n.split(/[\s()·,/&-]+/).some((w) => w && w.startsWith(q)))) return 2;
  if (names.some((n) => n.includes(q))) return 3;
  return -1;
}

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

export const groupOf = (d) => GROUP[d.kind] ?? t('Other places');
export const groupKey = (d) => (Object.hasOwn(GROUP, d.kind) ? d.kind : '?');

export function metaOf(d, stopName, speedMs = 1.3) {
  if (d.kind === 'timetable' || d.kind === 'service') return d.detail;
  if (d.kind === 'stop') return t('Bus stop');
  if (d.kind === 'place' || d.kind === 'class') return t('{0} stop', stopName(d.stopCode));
  if (d.kind === 'landmark') return `${d.detail ? `${d.detail} · ` : ''}${t('{0} stop', d.stops.map(stopName).join(t(' or ')))}`;
  const code = d.label !== d.code ? `${d.code} · ` : '';
  return `${code}${t('{0} stop', stopName(d.stopCode))}${d.walkM != null ? t(', {0} min walk', walkMin(d.walkM, speedMs)) : ''}`;
}

export function grouped(list) {
  const groups = new Map();
  for (const d of list) {
    const k = groupKey(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  return [...groups.values()].flat();
}

export const samePlace = (pin, d) =>
  pin.code === d.code && (pin.kind === d.kind || (pin.kind === 'timetable' && (d.kind === 'stop' || d.kind === 'landmark')));

export function results(query, { source, suggestions, pinned = () => [] }) {
  const q = query.trim();
  if (!q) return suggestions();
  const top = rank(pinned(), q);
  return [...top, ...rank(source(), q).filter((d) => !top.some((x) => samePlace(x, d)))].slice(0, MAX);
}

export const pickedText = (d) => (d.kind === 'room' || d.label === d.code ? d.code : d.label);

export const pickedStop = (d) => (d.kind === 'landmark' ? d.code : d.stopCode);

export function busesTabIndex(c) {
  if (!c) return [];
  const byCode = new Map(c.stops.map((s) => [s.code, s]));
  const longName = (code) => byCode.get(code)?.longName ?? byCode.get(code)?.name ?? code;
  const services = Object.entries(c.routes)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([svc, r]) => {
      const first = longName(r.seq[0]);
      return {
        kind: 'service',
        code: svc,
        label: svc,
        detail: r.loop ? t('Loop from {0}', first) : t('{0} to {1}', first, longName(r.seq.at(-1))),
      };
    });
  const aliases = new Map((c.destinations ?? []).filter((d) => d.kind === 'stop').map((d) => [d.code, d.aliases ?? []]));
  const stops = c.stops.map((s) => ({
    kind: 'stop',
    code: s.code,
    stopCode: s.code,
    label: s.longName ?? s.name,
    aliases: [s.name.toLowerCase(), ...(aliases.get(s.code) ?? [])],
  }));
  return [...services, ...stops];
}
