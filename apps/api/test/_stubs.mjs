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
    KV: kv,
    // Absent by default: logging must be a no-op without the binding.
    AE: ae,
    NEXTBUS_AUTH_BASE: 'https://auth.example.test',
    NEXTBUS_PROXY_BASE: 'https://proxy.example.test/univus/api/bus-proxy',
    NEXTBUS_PROXY_API_KEY: 'test-proxy-key',
    NEXTBUS_APP_VERSION: '0.0.0-test',
    NEXTBUS_HTD_API: 'test-htd',
    NEXTBUS_APP_API: 'test-app',
    // The public-route tests predate API keys; the key tests turn this off.
    PUBLIC_API_OPEN: '1',
  };
}

/** The bus proxy's shuttle-service reply: {code, msg, data}, with the old
 *  ShuttleServiceResult contents now sitting under `data`. */
export function shuttlePayload(shuttles) {
  return {
    code: '00000',
    msg: '',
    data: { TimeStamp: new Date().toISOString(), name: 'STUB', shuttles, hints: [] },
    ts: '20260928204939',
  };
}

// Global, so every mint in a test run is distinct even with Date.now frozen.
let tokenSerial = 0;

/** A structurally real PUBLIC-domain JWT that expires an hour from now. The
 *  serial makes each mint distinct, so a forced refresh is observable. */
function fakeJwt(serial = 0) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({ domain: 'PUBLIC', iss: 'HTD', jti: 'stubdevice000000', exp: now + 3600, iat: now, n: serial }),
    'c2lnbmF0dXJlLXJlbW92ZWQ',
  ].join('.');
}

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

/**
 * Fake upstream: the auth host plus the bus proxy. `reject` makes the next N
 * proxy calls answer with a non-"00000" code (at HTTP 200, like the real one)
 * so the forced-refresh retry can be exercised. Every proxy request is kept in
 * `requests` so tests can assert on headers and body.
 */
export function makeFetch({ byStop = {}, fail = false, reject = 0, rejectCode = '10009', hang = false, raw = null, mintReject = null, fcm = null } = {}) {
  const counts = { auth: 0, shuttle: 0 };
  const requests = [];
  const mints = [];
  const fn = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);

    if (url.includes('get-access-token')) {
      counts.auth++;
      mints.push(JSON.parse(init.body ?? '{}'));
      // A mint refused the way NUS refuses one: HTTP 200, a code, no token.
      if (mintReject) return Response.json({ code: mintReject, msg: 'We have a new release of uNivUS', data: null });
      tokenSerial++;
      return Response.json({
        msg: '',
        code: '00000',
        // No expires_in: the lifetime lives in the JWT exp, so this must be a
        // real three-part token or nothing downstream works.
        data: { username: 'User', token: fakeJwt(tokenSerial), userid: 'STUB-USER-ID', domain: 'PUBLIC' },
        ts: '20260827234622',
      });
    }

    if (url.includes('bus-proxy')) {
      counts.shuttle++;
      if (fail) throw new TypeError('upstream unreachable');
      // Never answers; only an abort signal ends it.
      if (hang) return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal.reason)));
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body ?? '{}');
      requests.push({ url, method: init.method, headers, body });
      if (reject > 0) {
        reject--;
        return Response.json({ code: rejectCode, msg: rejectCode === '10009' ? 'We have a new release of uNivUS' : 'token invalid', data: null });
      }
      if (raw) return Response.json(raw);
      return Response.json(shuttlePayload(byStop[body.busstopname] ?? []));
    }

    // Firebase: an OAuth token, then messages (recorded in `fcm.sent`).
    if (fcm && url === 'https://oauth2.googleapis.com/token') {
      fcm.oauth = (fcm.oauth ?? 0) + 1;
      return Response.json({ access_token: 'ya29.test', expires_in: 3599 });
    }
    if (fcm && url.startsWith('https://fcm.googleapis.com/v1/projects/')) {
      const msg = JSON.parse(init.body).message;
      if (fcm.dead?.has(msg.token)) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
      (fcm.sent ??= []).push(msg);
      return Response.json({ name: 'projects/x/messages/1' });
    }

    return new Response('unexpected upstream ' + url, { status: 599 });
  };
  fn.counts = counts;
  fn.requests = requests;
  fn.mints = mints;
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

/**
 * A Durable Object namespace that runs the real class in-process, one
 * instance per name, on in-memory storage with a settable alarm. `alarms`
 * lists each instance's pending alarm; fireAlarms() runs them.
 */
export function makeDurableObjects(Class, env = {}) {
  const pending = [];
  const instances = new Map();
  const alarms = new Map();
  const storageFor = (name) => {
    const m = new Map();
    return {
      _map: m,
      async get(k) {
        return m.has(k) ? structuredClone(m.get(k)) : undefined;
      },
      async put(k, v) {
        m.set(k, structuredClone(v));
      },
      async delete(k) {
        return m.delete(k);
      },
      async deleteAll() {
        m.clear();
        alarms.delete(name);
      },
      async getAlarm() {
        return alarms.get(name) ?? null;
      },
      async setAlarm(at) {
        alarms.set(name, at);
      },
    };
  };
  const instance = (name) => {
    if (!instances.has(name)) instances.set(name, new Class({ storage: storageFor(name), waitUntil: (p) => pending.push(p) }, typeof env === 'function' ? env() : env));
    return instances.get(name);
  };
  return {
    alarms,
    instances,
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (input, init) => instance(id).fetch(input instanceof Request ? input : new Request(input, init)),
    }),
    /** Runs only the alarms that are due by `nowMs` (the dev stub's clock). */
    async fireDue(nowMs) {
      for (const [name, at] of [...alarms.entries()]) {
        if (at > nowMs) continue;
        alarms.delete(name);
        await instance(name).alarm();
      }
      await Promise.all(pending.splice(0));
    },
    async fireAlarms() {
      for (const name of [...alarms.keys()]) {
        alarms.delete(name);
        await instance(name).alarm();
      }
      await Promise.all(pending.splice(0));
    },
  };
}
