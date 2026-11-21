import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { KEYED } from '../src/accounts/accounts.ts';

const CLIENTS = [
  ['android/app/src/main/java/sh/rcn/terminus/Api.kt', /val ANSWERS =\s*setOf\(([^)]*)\)/],
  ['macos/Sources/Terminus/Api.swift', /static let answers: Set<String> = \[([^\]]*)\]/],
  ['ios/Sources/Shared/Net.swift', /static let answers: Set<String> = \[([^\]]*)\]/],
];

test('every route the server refuses an outdated app is held back by each app after a 426', () => {
  for (const [file, pattern] of CLIENTS) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const list = pattern.exec(source);
    assert.ok(list, `the answers list in apps/${file}`);
    const held = new Set([...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    assert.deepEqual(
      KEYED.filter((p) => !held.has(p)),
      [],
      `apps/${file} holds back every KEYED route`,
    );
  }
});
