/**
 * Made-up numbers for the dashboard (/admin/), so the dev stub shows every
 * part of it filled in: Analytics Engine's answers to the queries admin.ts
 * makes, a feed state with past incidents in KV, two weeks of scored arrival
 * times in the downloads bucket, and accounts, devices and reports in D1.
 * Nothing here is real; STUB_ADMIN=empty leaves the dashboard as a fresh
 * install would see it.
 */

const DAY = 86_400_000;

/** A number from 0 to 1 that's the same every run for the same seed. */
function rand(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** The last [n] days as YYYY-MM-DD, oldest first. */
const days = (nowMs, n) => Array.from({ length: n }, (_, i) => new Date(nowMs - (n - 1 - i) * DAY).toISOString().slice(0, 10));
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
/** Busier on weekdays, as term is. */
const busy = (d) => ([0, 6].includes(weekday(d)) ? 0.45 : 1);

const SERVICES = ['A1', 'A2', 'D1', 'D2', 'BTC', 'E', 'K', 'L'];
const VERSIONS = ['android/3.5.0', 'android/3.4.3', 'android/3.4.2', 'mac/3.5.0', 'mac/3.4.3', 'android/3.5.1-beta.1'];

/** What Analytics Engine's SQL API would answer [q] with, or null for a query this doesn't know. */
export function fakeAeRows(q, nowMs) {
  if (q.includes("blob1 IN ('answer', 'error')")) {
    return days(nowMs, 14).flatMap((day) => {
      const n = Math.round((1800 + rand(day) * 900) * busy(day));
      return [
        { day, kind: 'answer', n },
        { day, kind: 'error', n: Math.round(n * (0.004 + rand(`e${day}`) * 0.012)) },
      ];
    });
  }
  if (q.includes('blob5 AS quality')) {
    return [
      { quality: 'live', n: 11_842 },
      { quality: 'scheduled', n: 2_315 },
      { quality: 'ended', n: 904 },
      { quality: 'stale', n: 211 },
      { quality: 'unknown', n: 37 },
    ];
  }
  if (q.includes('blob2 AS route')) {
    return [
      { route: '/api/me/next', n: 81 },
      { route: '/api/buses', n: 34 },
      { route: '/api/arrivals', n: 22 },
      { route: 'cron eta', n: 6 },
      { route: '/api/campus', n: 3 },
    ];
  }
  if (q.includes("blob1 = 'timelapse'")) {
    return days(nowMs, 14).flatMap((day) => {
      const polls = Math.round(15_000 + rand(`t${day}`) * 2000);
      const err = Math.round(polls * rand(`te${day}`) * 0.01);
      return [
        { day, outcome: 'upstream', n: Math.round(polls * 0.38) },
        { day, outcome: 'hit', n: Math.round(polls * 0.6) },
        { day, outcome: 'error', n: err },
        { day, outcome: 'retry', n: Math.round(err / 3) },
        { day, outcome: 'stale', n: Math.round(err / 2) },
        { day, outcome: 'failed', n: Math.round(err / 4) },
        { day, outcome: 'skipped', n: rand(`ts${day}`) > 0.85 ? 120 : 0 },
      ];
    });
  }
  if (q.includes("blob1 = 'active'")) {
    // Counted after midnight for the day before: none for today.
    return days(nowMs - DAY, 30).flatMap((day, i) => {
      const growth = 0.7 + i / 100;
      const d1 = Math.round((160 + rand(`a${day}`) * 60) * busy(day) * growth);
      const row = (scope, name, share) => ({
        day,
        scope,
        name,
        d1: Math.round(d1 * share),
        d7: Math.round(d1 * share * 2.6),
        d30: Math.round(d1 * share * 4.1),
      });
      return [
        row('all', 'all', 1),
        row('app', 'android', 0.58),
        row('app', 'web', 0.24),
        row('app', 'mac', 0.12),
        row('app', 'api', 0.06),
        ...VERSIONS.map((v, j) => row('version', v, [0.42, 0.12, 0.04, 0.09, 0.03, 0.02][j])),
      ];
    });
  }
  if (q.includes('blob7 AS stack')) {
    const ago = (h) => new Date(nowMs - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
    return [
      {
        fingerprint: 'a1f3',
        platform: 'android',
        type: 'java.lang.IllegalStateException',
        message: 'Flow invariant is violated: emission from another coroutine',
        stack:
          'java.lang.IllegalStateException: Flow invariant is violated\n  at kotlinx.coroutines.flow.internal.SafeCollector.checkContext(SafeCollector.kt:85)\n  at sh.rcn.terminus.ui.MapScreenKt$MapScreen$1.invokeSuspend(MapScreen.kt:212)',
        n: 14,
        fatal: 9,
        last: ago(2),
      },
      {
        fingerprint: 'b7c2',
        platform: 'web',
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'stops')",
        stack:
          "TypeError: Cannot read properties of undefined (reading 'stops')\n  at Board (/app/board.js:88:21)\n  at renderComponent (/vendor/preact-10.29.8/preact.mjs:1:7120)",
        n: 6,
        fatal: 0,
        last: ago(20),
      },
      {
        fingerprint: 'c9d0',
        platform: 'mac',
        type: 'DecodingError',
        message: 'keyNotFound(stretch)',
        stack: 'Terminus.Api.decode(_:) Api.swift:140\nTerminus.AppModel.refresh() AppModel.swift:301',
        n: 2,
        fatal: 0,
        last: ago(70),
      },
    ];
  }
  if (q.includes('blob8 AS os')) {
    return [
      { fingerprint: 'a1f3', version: '3.5.0', os: 'Android 15', n: 9 },
      { fingerprint: 'a1f3', version: '3.4.3', os: 'Android 14', n: 5 },
      { fingerprint: 'b7c2', version: 'web', os: 'Safari 26', n: 4 },
      { fingerprint: 'b7c2', version: 'web', os: 'Chrome 140', n: 2 },
      { fingerprint: 'c9d0', version: '3.4.3', os: 'macOS 26.1', n: 2 },
    ];
  }
  return null;
}

/** Two weeks of scored arrival times, as eta.ts writes them to the bucket. */
function etaDay(date) {
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const s = Math.floor(rand(`${date}s${i}`) * SERVICES.length);
    const etaS = 30 + Math.floor(rand(`${date}h${i}`) ** 1.6 * 1700);
    // Further ahead is less sure, and late more often than early.
    const spread = 25 + etaS / 9;
    const errS = Math.round((rand(`${date}e${i}`) - 0.38) * spread * 2.2);
    const hour = 7 + Math.floor(rand(`${date}o${i}`) * 17);
    rows.push([s, etaS, errS, hour % 24]);
  }
  return {
    v: 1,
    date,
    predictions: 5200 + Math.round(rand(date) * 900),
    matched: 4300 + Math.round(rand(`m${date}`) * 500),
    services: SERVICES,
    rows,
  };
}

/** Fills the stub's D1, KV and bucket with the dashboard's made-up data. */
export async function seedAdmin({ db, kv, downloads, nowMs }) {
  for (const date of days(nowMs - DAY, 14)) await downloads.put(`eta/${date}.json`, JSON.stringify(etaDay(date)));
  await kv.put(
    'monitor:upstream',
    JSON.stringify({ up: true, since: nowMs - 2.3 * DAY, reason: null, checkedAt: nowMs - 6 * 60_000, failures: 0, oks: 40 }),
  );
  await kv.put(
    'monitor:incidents',
    JSON.stringify([
      { start: nowMs - 2.4 * DAY, end: nowMs - 2.3 * DAY, cause: 'version' },
      { start: nowMs - 6.1 * DAY, end: nowMs - 6.08 * DAY, cause: 'feed' },
      { start: nowMs - 12 * DAY, end: nowMs - 11.9 * DAY, cause: 'feed' },
    ]),
  );
  const users = db._db.prepare('INSERT INTO users (id, email, created, last_seen, via, email_added) VALUES (?, ?, ?, ?, ?, ?)');
  const sessions = db._db.prepare(
    'INSERT INTO sessions (token_hash, user_id, kind, created, last_seen, platform, client) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const profiles = db._db.prepare('INSERT INTO profiles VALUES (?, ?, 1)');
  const platforms = ['android', 'android', 'android', 'mac', 'web', 'android', 'ios'];
  for (let i = 0; i < 240; i++) {
    const id = `demo-${i}`;
    const created = nowMs - Math.floor(rand(`c${i}`) ** 1.4 * 60 * DAY);
    const app = rand(`v${i}`) < 0.7;
    const withEmail = !app || rand(`m${i}`) < 0.35;
    users.run(id, withEmail ? `demo${i}@u.nus.edu` : null, created, created, app ? 'app' : 'web', withEmail && app ? created + DAY : null);
    const seen = nowMs - Math.floor(rand(`s${i}`) ** 2 * 20 * DAY);
    const platform = platforms[i % platforms.length];
    if (platform === 'web') sessions.run(`demo-web-${i}`, id, 'web', created, seen, null, null);
    else {
      const client = platform === 'ios' ? null : (VERSIONS.filter((v) => v.startsWith(platform))[i % 2] ?? null);
      sessions.run(`demo-dev-${i}`, id, 'device', created, seen, platform, client);
    }
    const profile = {
      trips: rand(`t${i}`) < 0.55 ? [{}] : [],
      home: { stops: rand(`h${i}`) < 0.7 ? ['PGP'] : [] },
      seen: rand(`o${i}`) < 0.8 ? ['onboarding'] : [],
    };
    profiles.run(id, JSON.stringify(profile));
  }
  const feedback = db._db.prepare(
    'INSERT INTO feedback (id, user_id, created, kind, note, platform, app_version, context, reply_to, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const answer = (label, stop, quality) => JSON.stringify({ label, stop: { code: stop, name: stop }, quality });
  const reports = [
    ['wrong', 'Waited 10 minutes at COM3, D2 never showed up.', 'android', '3.5.0', answer('D2 in 3 min', 'COM3', 'live'), 'never-came'],
    ['wrong', '', 'web', null, answer('A1 in 6 min', 'Kent Ridge MRT', 'scheduled'), 'times-off'],
    ['other', 'Love the widget! Could it show two buses?', 'android', '3.4.3', null, null],
    [
      'wrong',
      'From E4 I always walk to Kent Vale, not Opp. YIH.',
      'mac',
      '3.5.0',
      JSON.stringify({ venue: 'E4', stop: 'KV', stopName: 'Kent Vale', now: ['YIH-OPP'] }),
      'better-stop',
    ],
    [
      'wrong',
      'The walk to UTown takes far more than 4 minutes in the rain.',
      'web',
      null,
      answer('Walk 4 min', 'UTown', 'live'),
      'walk-longer',
    ],
    ['wrong', 'My CS2103 tutorial moved to Friday.', 'android', '3.5.0', answer('Leave in 12 min', 'PGP', 'live'), 'wrong-class'],
  ];
  reports.forEach(([kind, note, platform, version, context, reason], i) =>
    feedback.run(
      `fb-${i}`,
      `demo-${i * 7}`,
      nowMs - i * 0.7 * DAY - 3_600_000,
      kind,
      note,
      platform,
      version,
      context,
      i === 2 ? 'fan@example.com' : null,
      reason,
    ),
  );
}
