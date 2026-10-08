import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The Python scrapers and check_scraped.py, run by python3 against made-up
// data and a server on 127.0.0.1: no network, no keys. Skipped where there
// is no python3.

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

/** Runs [code] in python3 with the scripts importable; returns what it prints as JSON. */
function py(code) {
  const res = spawnSync('python3', ['-I', '-c', `import sys, json\nsys.path.insert(0, ${JSON.stringify(SCRIPTS)})\n${code}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, LTA_ACCOUNT_KEY: 'test-lta-key' },
    timeout: 60_000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

/** A server on 127.0.0.1 that redirects /start to /landed, answers /big
 *  with more bytes than allowed and /page with a full page, recording what
 *  reached it; [body] runs while it's up, with `base` its address. */
const SERVER = `
import http.server, threading
hits = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def answer(self):
        hits.append({"path": self.path, "key": self.headers.get("AccountKey"), "auth": self.headers.get("x-api-key")})
        if self.path.startswith("/start"):
            self.send_response(302); self.send_header("Location", base + "/landed"); self.end_headers(); return
        body = b'{"value": []}'
        if self.path.startswith("/big"):
            body = b'{"value": "' + b"x" * 2000 + b'"}'
        elif self.path.startswith("/page"):
            body = json.dumps({"value": [{}] * 500}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_GET = do_POST = answer
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
base = f"http://127.0.0.1:{srv.server_port}"
threading.Thread(target=srv.serve_forever, daemon=True).start()
def attempt(fn):
    try:
        fn()
        return "ok"
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return f"{type(e).__name__}: {e}"
`;

test('the scrapers that send keys refuse every redirect, and send nothing on', { skip: !python }, () => {
  const out = py(`${SERVER}
import scrape_lta, scrape_stops
scrape_lta.BASE = base + "/"
lta = attempt(lambda: scrape_lta.get_json("start"))
stops = attempt(lambda: scrape_stops.post_json(base + "/start", {"x-api-key": "test-proxy-key"}, {}))
print(json.dumps({"lta": lta, "stops": stops, "hits": hits}))
`);
  assert.match(out.lta, /HTTP 302 \(redirect refused\)/);
  assert.match(out.stops, /POST \/start -> HTTP 302 \(redirect refused\)/);
  assert.doesNotMatch(out.stops, /127\.0\.0\.1/, 'no address in the message');
  assert.deepEqual(out.hits.map((h) => h.path), ['/start', '/start'], 'the redirect is never followed');
});

test('the other scrapers refuse a redirect to plain http', { skip: !python }, () => {
  const out = py(`${SERVER}
import route_shapes, fetch_calendar, walk_routes
r = {}
for name, opener in (("shapes", route_shapes.OPENER), ("calendar", fetch_calendar.OPENER), ("walks", walk_routes.OPENER)):
    r[name] = attempt(lambda: opener.open(base + "/start", timeout=10).read())
print(json.dumps({"r": r, "hits": [h["path"] for h in hits]}))
`);
  for (const v of Object.values(out.r)) assert.match(v, /HTTP Error 302: redirect to plain http refused/);
  assert.ok(!out.hits.includes('/landed'));
});

test('every scraper caps the bytes it reads, and the LTA scraper the pages', { skip: !python }, () => {
  const out = py(`${SERVER}
import scrape_lta, scrape_stops, fetch_calendar, walk_routes
for m in (scrape_lta, scrape_stops, fetch_calendar, walk_routes):
    m.MAX_BYTES = 1000
scrape_lta.BASE = base + "/"
scrape_lta.MAX_PAGES = 3
r = {
    "lta": attempt(lambda: scrape_lta.get_json("big")),
    "stops": attempt(lambda: scrape_stops.post_json(base + "/big", {}, {})),
    "calendar": attempt(lambda: fetch_calendar.get_json(base + "/big")),
    "walks": attempt(lambda: walk_routes.fetch(base + "/big")),
    "small": attempt(lambda: scrape_lta.get_json("small")),
}
scrape_lta.MAX_BYTES = 100_000
pages = attempt(lambda: scrape_lta.dataset("page"))
r["more"] = {"pages": pages, "pageHits": len([h for h in hits if h["path"].startswith("/page")])}
print(json.dumps(r))
`);
  for (const k of ['lta', 'stops', 'calendar', 'walks']) assert.match(out[k], /more than 1000 bytes/, k);
  assert.equal(out.small, 'ok');
  assert.match(out.more.pages, /still going after 3 pages/);
  assert.equal(out.more.pageHits, 3);
});

test('route_shapes asks only the Overpass project itself', { skip: !python }, () => {
  const out = py(`import route_shapes
print(json.dumps({"url": route_shapes.OVERPASS, "mirrors": hasattr(route_shapes, "MIRRORS")}))`);
  assert.deepEqual(out, { url: 'https://overpass-api.de/api/interpreter', mirrors: false });
});

// A calendar of its own, so these don't move when calendar.json refreshes.
const CAL = {
  semesters: [
    { acadYear: '2026/2027', semester: 1, start: '2026-08-10' },
    { acadYear: '2026/2027', semester: 2, start: '2027-01-11' },
    { acadYear: '2026/2027', semester: 3, start: '2027-05-10' },
    { acadYear: '2026/2027', semester: 4, start: '2027-06-21' },
  ],
  holidays: [
    { date: '2026-08-09', name: 'National Day' },
    { date: '2026-08-10', name: 'National Day (Observed)' },
    { date: '2026-11-08', name: 'Deepavali' },
    { date: '2026-11-09', name: 'Deepavali (Observed)' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2027-01-01', name: 'New Year’s Day' },
    { date: '2027-02-06', name: 'Chinese New Year' },
    { date: '2027-02-07', name: 'Chinese New Year' },
    { date: '2027-03-26', name: 'Good Friday' },
    { date: '2027-05-01', name: 'Labour Day' },
  ],
};

/**
 * check_scraped.py's checks on the committed stop graph and public buses,
 * and CAL, with [edit] applied: the problems found. `r` and `pr` are a
 * shuttle and a public route of three stops or more, whichever they are.
 */
function checked(edit) {
  return py(`import check_scraped as c, copy, datetime as dt, pathlib
data = pathlib.Path(c.ROOT) / c.DATA
g = json.loads((data / "stops.json").read_text())
p = json.loads((data / "public.json").read_text())
cal = json.loads(${JSON.stringify(JSON.stringify(CAL))})
og, op, ocal = copy.deepcopy(g), copy.deepcopy(p), copy.deepcopy(cal)
r = next(k for k, v in sorted(g["routes"].items()) if len(v) >= 3)
pr = next(k for k, v in sorted(p["routes"].items()) if len(v) >= 3)
today = dt.date(2026, 10, 5)
${edit}
problems = []
c.check_graph(g, og, problems)
c.check_public_data(p, {s["code"] for s in g["stops"]}, op, problems)
c.check_calendar_data(cal, ocal, today, problems)
print(json.dumps(problems))
`);
}

test('check_scraped.py passes the committed data', { skip: !python }, () => {
  assert.deepEqual(checked(''), []);
});

test('check_scraped.py fails a stop moved more than 100 m, but not 50 m', { skip: !python }, () => {
  // 0.001 degrees of latitude is about 110 m.
  assert.match(checked('g["stops"][0]["lat"] += 0.001').join('\n'), /^stops moved more than 100 m: \S+ \(111 m\)$/m);
  assert.deepEqual(checked('g["stops"][0]["lat"] += 0.0005'), []);
  assert.match(checked('p["stops"][0]["lon"] -= 0.002').join('\n'), /public stops moved more than 100 m/);
});

test('check_scraped.py fails a route that runs another way; a new route passes', { skip: !python }, () => {
  assert.match(checked('g["routes"][r] = g["routes"][r][::-1]').join('\n'), /^route \S+ changed: /m);
  assert.match(checked('g["routes"][r] = g["routes"][r][:-1]').join('\n'), /^route \S+ changed/m);
  assert.match(checked('p["routes"][pr] = p["routes"][pr][1:]; p["along"][pr] = p["along"][pr][1:]').join('\n'), /^public route \S+ changed/m);
  assert.deepEqual(checked('g["routes"]["NEW"] = g["routes"][r][:2]'), []);
});

test('check_scraped.py fails a short list that loses one item', { skip: !python }, () => {
  assert.match(checked('del g["routes"][r]').join('\n'), /^routes: \S+ gone$/m);
  assert.match(checked('del p["routes"][pr]; del p["along"][pr]').join('\n'), /^public routes: \S+ gone$/m);
  assert.match(checked('p["stops"] = p["stops"][1:]').join('\n'), /^public stops: \d+ gone$/m);
});

test('check_scraped.py fails a name that is not plain', { skip: !python }, () => {
  assert.match(checked('g["stops"][0]["name"] = "<b>COM 3</b>"').join('\n'), /has an odd name/);
  assert.match(checked('g["stops"][0]["longName"] = "Go to evil.example"').join('\n'), /has an odd name/);
  assert.match(checked('g["stops"][0]["longName"] = "COM 3\\u0007"').join('\n'), /has an odd name/);
  assert.match(checked('p["stops"][0]["longName"] = "x" * 81').join('\n'), /public stop \d+ has an odd name/);
  assert.match(checked('cal["holidays"][-1]["name"] = "http://x"').join('\n'), /holiday .* is malformed/);
  assert.deepEqual(checked('g["stops"][0]["longName"] = "电脑 3"; cal["holidays"][-1]["name"] = "春节 (Observed)"'), []);
});

test('check_scraped.py holds the calendar to calendarsync.ts valid()', { skip: !python }, () => {
  assert.match(checked('cal["holidays"][0]["date"] = "2026-02-30"').join('\n'), /holiday .* is malformed/);
  assert.match(checked('cal["holidays"] = cal["holidays"][:4]').join('\n'), /only 4 holidays/);
  assert.match(checked('cal["semesters"][-1]["start"] = "2027-06-22"').join('\n'), /is malformed/, 'a Tuesday');
  assert.match(checked('cal["semesters"].append({"acadYear": "2027/2028", "semester": 1, "start": "2026-08-10"})').join('\n'), /is malformed/, 'outside its year');
  assert.match(checked('cal["semesters"].append({"acadYear": "2027/2029", "semester": 1, "start": "2027-08-09"})').join('\n'), /is malformed/);
  assert.deepEqual(checked('cal["semesters"].append({"acadYear": "2027/2028", "semester": 1, "start": "2027-08-09"})'), []);
});

test('check_scraped.py fails a semester moved, or many holidays to come gone', { skip: !python }, () => {
  assert.match(checked('cal["semesters"][1]["start"] = "2027-01-18"').join('\n'), /semester 2026\/2027 2 moved from 2027-01-11 to 2027-01-18/);
  // Past ones roll off; one to come may go.
  assert.deepEqual(checked('cal["holidays"] = [h for h in cal["holidays"] if h["date"] not in ("2026-08-09", "2026-08-10", "2026-11-09")]'), []);
  assert.match(
    checked('cal["holidays"] = [h for h in cal["holidays"] if h["date"] not in ("2026-11-08", "2026-11-09", "2026-12-25", "2027-01-01")]').join('\n'),
    /4 holidays to come are gone/,
  );
});
