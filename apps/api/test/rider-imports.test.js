/**
 * The Trip object and the rider's answer don't load accounts/me.ts, the
 * account routes: me.ts answers through rider.ts, so an import back would be
 * a cycle, and the Trip object would load every route to wake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = new URL('../src/', import.meta.url);

/** A module's imports, type-only and dynamic ones too, as URLs. */
const importsOf = (href) =>
  [...fs.readFileSync(new URL(href), 'utf8').matchAll(/(?:^\s*(?:import|export)\s[^'"]*?from\s+|import\(\s*)'(\.[^']+)'/gm)].map(
    (m) => new URL(m[1], href).href,
  );

for (const start of ['push/tripdo.ts', 'answer/rider.ts']) {
  test(`nothing ${start} imports leads to accounts/me.ts`, () => {
    const me = new URL('accounts/me.ts', SRC).href;
    /** Each module reached, and the one that imported it, to name the way there. */
    const from = new Map([[new URL(start, SRC).href, null]]);
    const todo = [new URL(start, SRC).href];
    while (todo.length) {
      const href = todo.pop();
      if (!href.endsWith('.ts')) continue;
      for (const next of importsOf(href)) {
        if (from.has(next)) continue;
        from.set(next, href);
        if (next === me) {
          const way = [];
          for (let at = next; at; at = from.get(at)) way.unshift(at.slice(SRC.href.length));
          assert.fail(`${way.join(' → ')}`);
        }
        todo.push(next);
      }
    }
    assert.ok(from.size > 20, `${from.size} modules walked`);
  });
}
