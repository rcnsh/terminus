#!/usr/bin/env node
// Checks a deployed Worker answers: `node scripts/deploy/smoke.mjs <base-url> [--account]`.
// Runs at the end of `deploy:beta` (package.json); run it by hand after a
// production deploy. Always: /api/health and the main pages. With
// --account: a throwaway anonymous account (deleted after 60 days unused)
// asks for a trip, steps to the later bus and checks the step is still
// there on the next two answers, through the Trip object. Use --account on
// the beta, where the accounts are test ones.
//
// A feed outage is a warning, not a failure: the deploy can be fine while
// NUS is down, and the account check is skipped when no bus runs.

const [base, ...flags] = process.argv.slice(2);
if (!base || !/^https?:\/\//.test(base)) {
  console.error('usage: smoke.mjs <base-url> [--account]');
  process.exit(2);
}
const account = flags.includes('--account');
// PGP to UTown: a trip with buses most of the day.
const AT = { lat: 1.2915, lon: 103.7805 };
const ASK = `lat=${AT.lat}&lon=${AT.lon}&to=UTOWN`;

const failures = [];
const fail = (what) => {
  failures.push(what);
  console.log(`✖ ${what}`);
};
const ok = (what) => console.log(`✔ ${what}`);

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

const health = await call('/api/health');
if (health.status !== 200 || !health.json?.ok) fail(`/api/health is ${health.status}`);
else {
  ok('/api/health');
  if (health.json.upstream && !health.json.upstream.up) console.log('! the NUS feed is down: answers will be guesses');
}
for (const page of ['/', '/app/', '/docs']) {
  const { status } = await call(page);
  if (status === 200) ok(page);
  else fail(`${page} is ${status}`);
}

if (account) {
  const anon = await call('/api/auth/anon', { method: 'POST', body: { name: 'deploy smoke', platform: 'ios' } });
  const token = anon.json?.token;
  if (!token) fail(`/api/auth/anon is ${anon.status}`);
  else {
    const first = await call(`/api/me/next?${ASK}`, { token });
    const later = first.json?.card?.step?.later;
    if (first.status !== 200 || !first.json?.label) fail(`/api/me/next is ${first.status}`);
    else if (!later) ok(`/api/me/next: "${first.json.label}" (no later bus to step to)`);
    else {
      ok(`/api/me/next: "${first.json.label}"`);
      const stepped = await call(`/api/me/step?${ASK}`, {
        method: 'POST',
        token,
        body: { trip: first.json.card.step.trip, to: later, dir: 'later', ...AT },
      });
      if (stepped.status !== 200) fail(`/api/me/step is ${stepped.status}`);
      else
        for (const n of [1, 2]) {
          const again = await call(`/api/me/next?${ASK}`, { token });
          const kept = again.json?.card?.step?.moved === true && again.json?.leave?.board === later.board;
          if (kept) ok(`answer ${n} after "Later bus" keeps the bus chosen`);
          else fail(`answer ${n} after "Later bus" is back on ${again.json?.leave?.board ?? 'nothing'}, not ${later.board}`);
        }
    }
  }
}

if (failures.length) {
  console.error(`\n${base}: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\n${base}: all checks passed`);
