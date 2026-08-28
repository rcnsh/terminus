/**
 * Test doubles for the Workers runtime. The suite must run with NO
 * credentials and no network, so everything the Worker touches is faked here.
 */

/**
 * caches.default. Each match() returns a NEW Response whose body is
 * single-use -- exactly like the real one, so code that reads a cached
 * response twice still throws here. That is the point.
 */
export function makeCache() {
  const store = new Map();
  return {
    _store: store,
    async match(req) {
      const key = typeof req === 'string' ? req : req.url;
      const e = store.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return new Response(e.body, { headers: e.headers });
    },
    async put(req, res) {
      const key = typeof req === 'string' ? req : req.url;
      const body = await res.text();
      const cc = res.headers.get('cache-control') || '';
      const m = /max-age=(\d+)/.exec(cc);
      store.set(key, {
        body,
        headers: Object.fromEntries(res.headers),
        expiresAt: Date.now() + (m ? Number(m[1]) : 60) * 1000,
      });
    },
    async delete(req) {
      return store.delete(typeof req === 'string' ? req : req.url);
    },
    /** Put a value in directly, bypassing the Worker. */
    seed(url, value, maxAgeS = 300) {
      store.set(url, {
        body: JSON.stringify(value),
        headers: { 'content-type': 'application/json' },
        expiresAt: Date.now() + maxAgeS * 1000,
      });
    },
  };
}

/**
 * The real ExecutionContext keeps the Worker alive until waitUntil promises
 * settle. A stub that drops them makes tests race their own cache writes, so
 * this one collects them and settle() awaits them.
 */
export function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    passThroughOnException() {},
    async settle() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}

export function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    _map: m,
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, String(v));
    },
    async delete(k) {
      m.delete(k);
    },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      };
    },
  };
}

export function makeEnv(kv = makeKV(), ae = undefined) {
  // Structurally valid, entirely fake. No captured values anywhere.
  return {
    NUSBUS_KV: kv,
    // Absent by default: logging must be a no-op without the binding.
    NUSBUS_AE: ae,
    NEXTBUS_AUTH_BASE: 'https://auth.example.test',
    NEXTBUS_FMS_BASE: 'https://fms.example.test/fms',
    NEXTBUS_APP_VERSION: '0.0.0-test',
    NEXTBUS_HTD_API: 'test-htd',
    NEXTBUS_APP_API: 'test-app',
    NEXTBUS_FMS_SERVICE_ID: 'test-service',
    NEXTBUS_FMS_TENANT_CODE: 'test-tenant',
  };
}

/** A ShuttleService payload in the real nested shape, with the real quirks. */
export function shuttlePayload(shuttles) {
  return {
    ShuttleServiceResult: {
      TimeStamp: new Date().toISOString(),
      // One level deeper than you expect.
      data: { shuttles },
    },
  };
}

/**
 * Fake FMS. Counts ShuttleService calls separately from auth calls, because
 * "exactly one upstream call" is about arrivals, not tokens.
 */
/** A structurally real PUBLIC-domain JWT that expires an hour from now. */
function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({ domain: 'PUBLIC', iss: 'HTD', jti: 'stubdevice000000', exp: now + 3600, iat: now }),
    'c2lnbmF0dXJlLXJlbW92ZWQ',
  ].join('.');
}

/** Collects Analytics Engine writes so tests can assert on the schema. */
export function makeAnalytics() {
  const events = [];
  return {
    events,
    writeDataPoint(e) {
      events.push(e);
    },
    rows(kind) {
      return events.filter((e) => e.blobs[0] === kind);
    },
  };
}

export function makeFetch({ byStop = {}, fail = false } = {}) {
  const counts = { auth: 0, buswidget: 0, shuttle: 0 };
  const fn = async (input) => {
    const url = String(typeof input === 'string' ? input : input.url);

    // Stage 1: the PUBLIC access token.
    if (url.includes('get-access-token')) {
      counts.auth++;
      return Response.json({
        msg: '',
        code: '00000',
        // No expires_in: the lifetime lives in the JWT exp, so this must be a
        // real three-part token or nothing downstream works.
        data: { username: 'User', token: fakeJwt(), userid: 'STUB-USER-ID', domain: 'PUBLIC' },
        ts: '20260827234622',
      });
    }

    // Stage 2: the buswidget hop that mints the ConnectX token.
    if (url.includes('buswidget') || url.includes('get-init-data')) {
      counts.buswidget++;
      return Response.json({
        msg: '',
        code: '00000',
        data: {
          tokens: { nextbus_token: 'stub-nb1', nextbus_token2: 'stub-fms-token' },
          bus_stops: [],
          'bus-stop-color': [],
        },
      });
    }

    // Stage 3: ConnectX ShuttleService.
    counts.shuttle++;
    if (fail) throw new TypeError('upstream unreachable');
    const code = new URL(url).searchParams.get('busstopname');
    return Response.json(shuttlePayload(byStop[code] ?? []));
  };
  fn.counts = counts;
  return fn;
}

/** Installs caches/fetch globals. Call per test to get a clean cache. */
/**
 * Thursday 2026-08-27, 09:00 SGT. Inside every service's operating window.
 *
 * The Worker reads Date.now() internally, so without freezing it the smoke
 * tests quietly become time-of-day dependent: once real operating hours were
 * filled into data/service-hours.json, running the suite after 23:00 SGT made
 * every service legitimately 'ended' and three tests failed for a reason that
 * had nothing to do with the code under test.
 */
export const FROZEN_NOW = Date.UTC(2026, 7, 27, 1, 0, 0);

export function installGlobals(fetchImpl, nowMs = FROZEN_NOW) {
  const cache = makeCache();
  globalThis.caches = { default: cache, open: async () => cache };
  if (fetchImpl) globalThis.fetch = fetchImpl;
  Date.now = () => nowMs;
  return cache;
}
