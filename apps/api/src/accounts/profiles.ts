import type { Graph } from '../types.ts';
import { loadProfileJson } from './accounts.ts';
import { CLOCK_PREFS, DEFAULT_PROFILE, PROFILE_LIMITS, type Profile, parseProfile } from '../timetable/profile.ts';
import { indexGraph } from '../answer/resolve.ts';
import { landmark } from '../answer/landmarks.ts';
import { GRAPH_PUBLIC } from '../answer/graph.ts';
import { LANG_PREFS, useProfileLang } from '../i18n.ts';

export async function getProfile(db: D1Database, userId: string, graph: Graph, raw?: unknown): Promise<Profile> {
  if (raw === undefined) raw = await loadProfileJson(db, userId);
  if (!raw) return structuredClone(DEFAULT_PROFILE);
  const idx = indexGraph(graph);
  const r = parseProfile(
    raw,
    (c) => idx.byCode.has(c),
    (c) => idx.byCode.has(c) || landmark(c) !== null,
    pinnable(graph),
  );
  if (r.ok) {
    useProfileLang(r.profile.lang);
    return r.profile;
  }
  const p = raw as Profile;
  useProfileLang(LANG_PREFS.includes(p.lang) ? p.lang : 'auto');
  return salvageProfile(p, (c) => idx.byCode.has(c) || landmark(c) !== null, pinnable(graph));
}

export function pinnable(graph: Graph): (code: string) => boolean {
  const idx = indexGraph(graph);
  const pub = indexGraph(GRAPH_PUBLIC);
  return (c) => idx.byCode.has(c) || pub.byCode.has(c);
}

export function salvageProfile(p: Profile, ok: (code: string) => boolean, pinnable: (code: string) => boolean = ok): Profile {
  const minute = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24 * 60;
  const hours = minute(p.dayStartMin) && minute(p.dayEndMin) && p.dayStartMin < p.dayEndMin;
  const places = (p.places ?? []).filter((x) => ok(x.to));
  const placeKeys = new Set(places.map((x) => x.key));
  return {
    ...structuredClone(DEFAULT_PROFILE),
    gapHours: typeof p.gapHours === 'number' ? p.gapHours : DEFAULT_PROFILE.gapHours,
    homeWalkMin: typeof p.homeWalkMin === 'number' ? p.homeWalkMin : DEFAULT_PROFILE.homeWalkMin,
    walkPace: p.walkPace ?? DEFAULT_PROFILE.walkPace,
    fullBusMargin: p.fullBusMargin ?? DEFAULT_PROFILE.fullBusMargin,
    publicBuses: p.publicBuses === true,
    preferBus: p.preferBus !== false,
    ...(hours ? { dayStartMin: p.dayStartMin, dayEndMin: p.dayEndMin } : {}),
    seen: Array.isArray(p.seen) ? p.seen : [],
    home: p.home?.stops?.some(ok) ? { stops: p.home.stops.filter(ok) } : null,
    trips: (p.trips ?? []).filter((t) => ok(t.to)),
    manual: (p.manual ?? []).filter((t) => ok(t.to)),
    places,
    usual: (Array.isArray(p.usual) ? p.usual : []).filter(
      (u) => placeKeys.has(u.place) && Number.isInteger(u.day) && u.day >= 0 && u.day <= 6 && minute(u.atMin),
    ),
    once: (Array.isArray(p.once) ? p.once : []).filter((o) => typeof o.date === 'string' && minute(o.arriveByMin) && ok(o.to)),
    share: p.share ?? null,
    term: p.term ?? null,
    lang: LANG_PREFS.includes(p.lang) ? p.lang : 'auto',
    clock: CLOCK_PREFS.includes(p.clock) ? p.clock : 'auto',
    pinnedStops: (Array.isArray(p.pinnedStops) ? p.pinnedStops : [])
      .filter((c) => typeof c === 'string' && pinnable(c))
      .slice(0, PROFILE_LIMITS.pinnedStops),
  };
}
