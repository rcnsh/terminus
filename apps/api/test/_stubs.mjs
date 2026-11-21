import { DatabaseSync } from 'node:sqlite';
import { COL } from '../src/analytics-rows.ts';

export function makeCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url).split('#')[0];
  return {
    _store: store,
    async match(req) {
      const key = keyOf(req);
      const e = store.get(key);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return new Response(e.body, { headers: e.headers });
    },
    async put(req, res) {
      const key = keyOf(req);
      const body = await res.arrayBuffer();
      const cc = res.headers.get('cache-control') || '';
      const m = /max-age=(\d+)/.exec(cc);
      store.set(key, {
        body,
        headers: Object.fromEntries(res.headers),
        expiresAt: Date.now() + (m ? Number(m[1]) : 60) * 1000,
      });
    },
    async delete(req) {
      return store.delete(keyOf(req));
    },
    seed(url, value, maxAgeS = 300) {
      store.set(url, {
        body: JSON.stringify(value),
        headers: { 'content-type': 'application/json' },
        expiresAt: Date.now() + maxAgeS * 1000,
      });
    },
  };
}

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
  return {
    KV: kv,
    AE: ae,
    NEXTBUS_AUTH_BASE: 'https://auth.example.test',
    NEXTBUS_PROXY_BASE: 'https://proxy.example.test/univus/api/bus-proxy',
    NEXTBUS_PROXY_API_KEY: 'test-proxy-key',
    NEXTBUS_APP_VERSION: '0.0.0-test',
    NEXTBUS_HTD_API: 'test-htd',
    NEXTBUS_APP_API: 'test-app',
    [Symbol.for('terminus.testOpen')]: true,
  };
}

export function shuttlePayload(shuttles) {
  return {
    code: '00000',
    msg: '',
    data: { TimeStamp: new Date(Date.now()).toISOString(), name: 'STUB', shuttles, hints: [] },
    ts: '20260928204939',
  };
}

let tokenSerial = 0;

function fakeJwt(serial = 0) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return [
    b64({ alg: 'RS256', typ: 'JWT' }),
    b64({ domain: 'PUBLIC', iss: 'HTD', jti: 'stubdevice000000', exp: now + 3600, iat: now, n: serial }),
    'c2lnbmF0dXJlLXJlbW92ZWQ',
  ].join('.');
}

export function named(p) {
  const at = (c) => (c.startsWith('blob') ? p.blobs[Number(c.slice(4)) - 1] : p.doubles[Number(c.slice(6)) - 1]);
  return Object.fromEntries(Object.entries(COL[p.blobs[0]] ?? { kind: 'blob1' }).map(([f, c]) => [f, at(c)]));
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
    named(kind) {
      return events.filter((e) => e.blobs[0] === kind).map(named);
    },
  };
}

export function makeFetch({
  byStop = {},
  buses = {},
  fail = false,
  reject = 0,
  rejectCode = '10009',
  hang = false,
  raw = null,
  mintReject = null,
  mintStatus = 200,
  proxyStatus = 200,
  fcm = null,
  publicStops = {},
  publicStatus = 200,
  publicFail = false,
} = {}) {
  const counts = { auth: 0, shuttle: 0, public: 0 };
  const requests = [];
  const mints = [];
  const fn = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);

    if (url.includes('get-access-token')) {
      counts.auth++;
      mints.push(JSON.parse(init.body ?? '{}'));
      if (mintStatus !== 200) return new Response('unavailable', { status: mintStatus });
      if (mintReject) return Response.json({ code: mintReject, msg: 'We have a new release of uNivUS', data: null });
      tokenSerial++;
      return Response.json({
        msg: '',
        code: '00000',
        data: { username: 'User', token: fakeJwt(tokenSerial), userid: 'STUB-USER-ID', domain: 'PUBLIC' },
        ts: '20260827234622',
      });
    }

    if (url.includes('bus-proxy')) {
      counts.shuttle++;
      if (fail) throw new Error('Network connection lost.');
      if (hang) {
        return new Promise((_, rej) => {
          const keep = setTimeout(() => {}, 30_000);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(keep);
            rej(init.signal.reason);
          });
        });
      }
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body ?? '{}');
      requests.push({ url, method: init.method, headers, body, at: Date.now() });
      if (proxyStatus !== 200) return Response.json({ code: '?', msg: 'busy' }, { status: proxyStatus });
      if (reject > 0) {
        reject--;
        return Response.json({
          code: rejectCode,
          msg: rejectCode === '10009' ? 'We have a new release of uNivUS' : 'token invalid',
          data: null,
        });
      }
      if (raw) return Response.json(raw);
      if (url.endsWith('/active-bus')) {
        const list = buses[body.route_code] ?? [];
        return Response.json({
          code: '00000',
          msg: '',
          data: { ActiveBusCount: list.length, TimeStamp: '2026-10-02 09:14:02', activebus: list },
        });
      }
      return Response.json(shuttlePayload(byStop[body.busstopname] ?? []));
    }

    if (url.startsWith('https://datamall2.mytransport.sg/')) {
      counts.public++;
      requests.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: null });
      if (publicFail) throw new Error('Network connection lost.');
      if (publicStatus !== 200) return new Response('refused', { status: publicStatus });
      const code = new URL(url).searchParams.get('BusStopCode') ?? '';
      return Response.json(ltaPayload(code, publicStops[code] ?? []));
    }

    if (fcm && url === 'https://oauth2.googleapis.com/token') {
      fcm.oauth = (fcm.oauth ?? 0) + 1;
      return Response.json({ access_token: 'ya29.test', expires_in: 3599 });
    }
    if (fcm && url.startsWith('https://fcm.googleapis.com/v1/projects/')) {
      const msg = JSON.parse(init.body).message;
      if (fcm.dead?.has(msg.token)) return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
      if (fcm.expire > 0) {
        fcm.expire--;
        return Response.json({ error: { status: 'UNAUTHENTICATED' } }, { status: 401 });
      }
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

export function ltaPayload(code, services) {
  const slot = (b) =>
    b
      ? {
          OriginCode: b.origin ?? b.dest ?? '',
          DestinationCode: b.dest ?? '',
          EstimatedArrival: new Date(FROZEN_NOW + b.etaS * 1000).toISOString().replace('Z', '+00:00'),
          Monitored: b.monitored === false ? 0 : 1,
          Latitude: b.monitored === false ? '0.0' : '1.2966',
          Longitude: b.monitored === false ? '0.0' : '103.7724',
          VisitNumber: '1',
          Load: b.load ?? 'SEA',
          Feature: 'WAB',
          Type: 'SD',
        }
      : {
          OriginCode: '',
          DestinationCode: '',
          EstimatedArrival: '',
          Monitored: 0,
          Latitude: '0.0',
          Longitude: '0.0',
          VisitNumber: '',
          Load: '',
          Feature: '',
          Type: '',
        };
  return {
    'odata.metadata': 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival',
    BusStopCode: code,
    Services: services.map((s) => ({
      ServiceNo: s.ServiceNo,
      Operator: s.Operator ?? 'SBST',
      NextBus: slot(s.buses[0]),
      NextBus2: slot(s.buses[1]),
      NextBus3: slot(s.buses[2]),
    })),
  };
}

export function makeBucket(readFrom) {
  const written = new Map();
  const metadata = new Map();
  const read = async (key) => written.get(key) ?? (await readFrom(key));
  const etagOf = (data) => {
    let h = 0;
    for (const b of data) h = (h * 31 + b) >>> 0;
    return `${data.length}-${h.toString(16)}`;
  };
  const bucket = {
    gets: 0,
    _written: written,
    async put(key, body, opts = {}) {
      const data =
        body instanceof Uint8Array
          ? body
          : typeof body === 'string'
            ? new TextEncoder().encode(body)
            : new Uint8Array(await new Response(body).arrayBuffer());
      written.set(key, data);
      metadata.set(key, opts.customMetadata ?? {});
      return { key, size: data.length };
    },
    async list({ prefix = '' } = {}) {
      const objects = [...written.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, data]) => ({ key, size: data.length }));
      return { objects, truncated: false, cursor: undefined };
    },
    async head(key) {
      const data = await read(key);
      if (!data) return null;
      const etag = etagOf(data);
      return { size: data.length, etag, httpEtag: `"${etag}"`, customMetadata: metadata.get(key) ?? {} };
    },
    async get(key, opts = {}) {
      const data = await read(key);
      if (!data) return null;
      const etag = etagOf(data);
      const base = { size: data.length, etag, httpEtag: `"${etag}"` };
      const cond = opts.onlyIf;
      const ifMatch = cond instanceof Headers ? cond.get('if-match') : null;
      if (
        cond instanceof Headers
          ? cond.get('if-none-match') === base.httpEtag || (ifMatch != null && ifMatch !== base.httpEtag)
          : cond?.etagMatches != null && cond.etagMatches !== etag
      )
        return base;
      let offset = 0;
      let length = data.length;
      let ranged = false;
      if (opts.range instanceof Headers) {
        const r = /bytes=(\d+)-(\d*)/.exec(opts.range.get('range') ?? '');
        if (r) {
          ranged = true;
          offset = Number(r[1]);
          length = (r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1) - offset + 1;
        }
      } else if (opts.range) {
        ranged = true;
        offset = opts.range.offset ?? 0;
        length = opts.range.length ?? data.length - offset;
      }
      if (offset >= data.length) throw new Error('range not satisfiable');
      const body = data.slice(offset, offset + length);
      bucket.gets++;
      return {
        ...base,
        body,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => new TextDecoder().decode(body),
        json: async () => JSON.parse(new TextDecoder().decode(body)),
        ...(ranged ? { range: { offset, length: body.length } } : {}),
      };
    },
  };
  return bucket;
}

export const FROZEN_NOW = Date.UTC(2026, 7, 27, 1, 0, 0);

export function installGlobals(fetchImpl, nowMs = FROZEN_NOW) {
  const cache = makeCache();
  globalThis.caches = { default: cache, open: async () => cache };
  if (fetchImpl) globalThis.fetch = fetchImpl;
  Date.now = () => nowMs;
  return cache;
}

export function makeDurableObjects(Class, env = {}) {
  const pending = [];
  const instances = new Map();
  const alarms = new Map();
  const storageFor = (name) => {
    const m = new Map();
    let db = null;
    const sql = {
      exec(query, ...bindings) {
        db ??= new DatabaseSync(':memory:');
        const stmt = db.prepare(query);
        const rows = /^\s*select/i.test(query) ? stmt.all(...bindings).map((r) => ({ ...r })) : (stmt.run(...bindings), []);
        return {
          toArray: () => rows,
          one() {
            if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
            return rows[0];
          },
        };
      },
    };
    return {
      _map: m,
      sql,
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
        db?.close();
        db = null;
      },
      transactionSync(fn) {
        sql.exec('SAVEPOINT tx');
        try {
          const out = fn();
          sql.exec('RELEASE tx');
          return out;
        } catch (err) {
          sql.exec('ROLLBACK TO tx');
          sql.exec('RELEASE tx');
          throw err;
        }
      },
      async getAlarm() {
        return alarms.get(name) ?? null;
      },
      async deleteAlarm() {
        alarms.delete(name);
      },
      async setAlarm(at) {
        alarms.set(name, at);
      },
    };
  };
  const instance = (name) => {
    if (!instances.has(name)) {
      let queue = Promise.resolve();
      const blockConcurrencyWhile = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
      };
      instances.set(
        name,
        new Class(
          { storage: storageFor(name), waitUntil: (p) => pending.push(p), blockConcurrencyWhile },
          typeof env === 'function' ? env() : env,
        ),
      );
    }
    return instances.get(name);
  };
  return {
    alarms,
    instances,
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (input, init) => instance(id).fetch(input instanceof Request ? input : new Request(input, init)),
    }),
    async fireDue(nowMs) {
      for (const [name, at] of Array.from(alarms.entries())) {
        if (at > nowMs) continue;
        alarms.delete(name);
        await instance(name).alarm();
      }
      await Promise.all(pending.splice(0));
    },
    async fireAlarms() {
      for (const name of Array.from(alarms.keys())) {
        alarms.delete(name);
        await instance(name).alarm();
      }
      await Promise.all(pending.splice(0));
    },
  };
}
