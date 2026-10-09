// A recorded day of shuttles, read back for the timelapse: the day file the
// recorder writes (DayFile in apps/api/src/timelapse.ts) turned into one
// track per bus, and where each bus is at any moment of the day.
//
// Shared: the timelapse page draws with it, and the API's tests check it
// against the encoder (apps/api/test/timelapse.test.js). Plain functions,
// no DOM, no imports.
//
// Between two readings a bus moves along its route line, from the metres
// along it the recorder kept to the next, so it follows the road round
// corners rather than cutting across. Readings far apart (the feed down,
// the breaker open, the bus off its line for a while) aren't joined up: the
// bus fades out after the first and back in before the next. So does a bus
// whose next reading is further on than a bus could have driven (its track
// started again somewhere else). After its last reading a bus stays for one
// poll (it would have been seen again then), then fades: the end of a
// recording isn't every bus fading out at once.

/** Readings further apart than this aren't joined: the bus fades out and in. */
export const GAP_MS = 120_000;
/** How long a fade takes. */
export const FADE_MS = 15_000;
/** Faster than this along the road (72 km/h, plus slack) is a jump, not a drive. */
const MAX_SPEED_MS = 20;
const SLACK_M = 150;

const DAY_MS = 86_400_000;
const SGT_MS = 8 * 3_600_000;

/** Metres between two points. */
export function haversineM(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A route line measured as the API measures it (metres from its start at
 *  each point), so a recorded `along` is a place on it. */
export function pathOf(line, loop) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversineM(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
  return { line, cum, total: cum[cum.length - 1] ?? 0, loop: Boolean(loop) };
}

/** The point [m] metres along [path], and the road's direction there. Round a loop it wraps. */
export function pointAt(path, m) {
  const { line, cum, total } = path;
  m = path.loop && total > 0 ? ((m % total) + total) % total : Math.max(0, Math.min(total, m));
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= m) lo = mid;
    else hi = mid;
  }
  const [aLon, aLat] = line[lo];
  const [bLon, bLat] = line[hi];
  const seg = cum[hi] - cum[lo];
  const k = seg > 0 ? (m - cum[lo]) / seg : 0;
  return { lat: aLat + (bLat - aLat) * k, lon: aLon + (bLon - aLon) * k, heading: bearing(aLat, aLon, bLat, bLon) };
}

function bearing(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (((Math.atan2(y, x) / r) % 360) + 360) % 360;
}

/**
 * The day file as tracks: every reading of every bus, in time order, by
 * service and plate. `start` and `end` are the first and last readings.
 * Readings off the route line (no `along`) aren't kept: there's nowhere on
 * the line to draw them.
 */
export function decodeDay(file) {
  if (file?.v !== 1) throw new Error(`not a timelapse day file (version ${file?.v})`);
  const [olon, olat] = file.origin;
  const q = file.q;
  const routes = {};
  for (const [svc, r] of Object.entries(file.routes)) routes[svc] = { color: r.color, path: pathOf(r.line, r.loop), line: r.line };
  const tracks = new Map();
  let t = file.t0;
  let start = Infinity;
  let end = -Infinity;
  let readings = 0;
  for (const s of file.samples) {
    t += s[0];
    const svc = file.services[s[1]];
    start = Math.min(start, t);
    end = Math.max(end, t);
    readings++;
    for (let i = 2; i + 3 < s.length; i += 4) {
      const along = s[i + 3];
      if (along < 0) continue;
      const plate = file.plates[s[i]];
      const key = `${svc} ${plate}`;
      let track = tracks.get(key);
      if (!track) tracks.set(key, (track = { key, svc, plate, pts: [] }));
      track.pts.push({ t, along, lat: olat + s[i + 1] / q, lon: olon + s[i + 2] / q });
    }
  }
  for (const track of tracks.values()) {
    // In time order, one reading per moment (a cached answer can come back
    // slightly out of order between services).
    track.pts.sort((a, b) => a.t - b.t);
    track.pts = track.pts.filter((p, i, all) => i === 0 || p.t !== all[i - 1].t);
  }
  return {
    date: file.date,
    start: Number.isFinite(start) ? start : file.t0,
    end: Number.isFinite(end) ? end : file.t0,
    readings,
    pollMs: file.pollMs,
    services: Object.keys(file.routes).sort(),
    routes,
    stops: file.stops,
    tracks: [...tracks.values()],
  };
}

/** The last index whose reading is at or before [t], or -1. */
function before(pts, t) {
  let lo = -1;
  let hi = pts.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Where [track]'s bus is at [t] on [path]: metres along, and how opaque it
 * is (0 to 1), or null when it isn't on the map then. After its last
 * reading it stays [holdMs] before it fades. A bus fading through a jump
 * comes with `jumping`: it's out all along, only drawn fading.
 */
export function placeAt(track, path, t, holdMs = 0) {
  const { pts } = track;
  if (!pts.length) return null;
  const at = (p, alpha) => (alpha > 0 ? { along: p.along, alpha: Math.min(1, alpha) } : null);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (t < first.t) return at(first, 1 - (first.t - t) / FADE_MS);
  if (t >= last.t) return at(last, 1 - Math.max(0, t - last.t - holdMs) / FADE_MS);
  const i = before(pts, t);
  const a = pts[i];
  const b = pts[i + 1];
  const dt = b.t - a.t;
  // A gap: out after the reading before it, in before the one after.
  if (dt > GAP_MS) return t - a.t < b.t - t ? at(a, 1 - (t - a.t) / FADE_MS) : at(b, 1 - (b.t - t) / FADE_MS);
  const k = (t - a.t) / dt;
  let d = b.along - a.along;
  // Round a loop, past the end is on from the start.
  if (path.loop && path.total > 0 && d < -path.total / 2) d += path.total;
  // Further than it could have driven, or backwards a long way: it didn't
  // drive there, so it doesn't slide there. Out at one, in at the other.
  if (Math.abs(d) > (MAX_SPEED_MS * dt) / 1000 + SLACK_M) return { along: (k < 0.5 ? a : b).along, alpha: Math.abs(1 - 2 * k), jumping: true };
  return { along: a.along + d * k, alpha: 1 };
}

/** Every bus on the map at [t]: where, which way, its colour and opacity. */
export function busesAt(day, t) {
  const out = [];
  for (const track of day.tracks) {
    const route = day.routes[track.svc];
    if (!route) continue;
    const place = placeAt(track, route.path, t, day.pollMs ?? 0);
    if (!place) continue;
    const p = pointAt(route.path, place.along);
    out.push({ key: track.key, svc: track.svc, plate: track.plate, color: route.color, lat: p.lat, lon: p.lon, heading: p.heading, alpha: place.alpha, jumping: place.jumping === true });
  }
  return out;
}

/** Buses out per service. A bus fading in or out is counted once it's more
 *  than half there, so a gap changes the number once each way; one fading
 *  through a jump is counted throughout, or a service with one bus out
 *  would blink to none at every jump (a one-way route's end, say). */
export function countBySvc(buses) {
  const n = {};
  for (const b of buses) if (b.alpha >= 0.5 || b.jumping) n[b.svc] = (n[b.svc] ?? 0) + 1;
  return n;
}

/**
 * Epoch ms of [hhmm] Singapore time on day [date]'s timeline: a time before
 * [dayStartHhmm] (the recording window's opening) is the next morning, so
 * 00:15 on a day that opened at 06:30 is after midnight.
 */
export function timeOn(date, hhmm, dayStartHhmm = '06:30') {
  const mins = (s) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const midnight = Date.parse(`${date}T00:00:00Z`) - SGT_MS;
  const m = mins(hhmm);
  return midnight + m * 60_000 + (m < mins(dayStartHhmm) ? DAY_MS : 0);
}

/** "08:05", Singapore time. */
export function clockAt(ms) {
  const d = new Date(ms + SGT_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
