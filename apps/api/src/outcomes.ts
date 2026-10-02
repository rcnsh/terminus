/**
 * What happened to each planned trip, and what terminus learns from it
 * without being creepy about it (phase 3).
 *
 * One row per trip per day in `trip_outcomes`: what detection saw from the
 * phone's location (boarded, missed, arrived) or "Not going" (skipped). terminus
 * never asks what happened. Rows from before that may say `none` (a question
 * nobody answered); nothing reads them any more. Kept 35 days. From it:
 *
 * - **Three misses of the same trip in 30 days** suggest leaving one bus
 *   earlier for it. Only a suggestion; nothing changes until it's accepted.
 * - **"Not going" three weeks running** offers to stop reminders for it.
 *
 * Accepted and turned-down suggestions are `trip_prefs`, per weekly trip.
 */

import { sgtDate } from './trip.ts';
import { m } from './i18n.ts';

export type Outcome = 'boarded' | 'missed' | 'skipped' | 'arrived' | 'none';
export type PrefKind = 'earlier' | 'quiet';

/** Rows older than this are deleted by the cron. */
export const KEEP_DAYS = 35;
/** This many misses of one trip within MISS_DAYS suggest a bus earlier. */
export const MISSES = 3;
export const MISS_DAYS = 30;
/** This many "Not going" for one trip, its last occurrences in a row. */
export const SKIPS = 3;
/** A turned-down suggestion isn't offered again for this long. */
export const DISMISS_DAYS = 30;

const DAY_MS = 86_400_000;

/** A suggestion for the card: accept or turn down with /me/suggestion. */
export interface Suggestion {
  /** `earlier:<trip>` or `quiet:<trip>`. */
  id: string;
  text: string;
  accept: string;
  dismiss: string;
}

/** What the planner and the card need to know about the user's trips. */
export interface TripPrefs {
  /** Trip keys to leave one bus earlier for. */
  earlier: Set<string>;
  /** Trip keys with no reminders. */
  quiet: Set<string>;
  /** At most one pending suggestion. */
  suggestion: Suggestion | null;
}

export const NO_PREFS: TripPrefs = { earlier: new Set(), quiet: new Set(), suggestion: null };

/** Records (or replaces) today's outcome for a trip. */
export async function recordOutcome(db: D1Database, userId: string, key: string, outcome: Exclude<Outcome, 'none'>, nowMs: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO trip_outcomes (user_id, trip_key, day, outcome, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, trip_key, day) DO UPDATE SET outcome = excluded.outcome, at = excluded.at',
    )
    .bind(userId, key, sgtDate(nowMs), outcome, nowMs)
    .run();
}

/** "Undo": today's outcome for that trip is forgotten. */
export async function clearOutcome(db: D1Database, userId: string, key: string, nowMs: number): Promise<void> {
  await db.prepare('DELETE FROM trip_outcomes WHERE user_id = ? AND trip_key = ? AND day = ?').bind(userId, key, sgtDate(nowMs)).run();
}

/** More than any timetable has trips: the trip key comes from the client, so the rows are capped. */
export const MAX_PREFS = 200;

/** Accepts or turns down a suggestion, or undoes an accepted one. */
export async function setPref(db: D1Database, userId: string, key: string, pref: PrefKind, choice: 'accept' | 'dismiss' | 'undo', label: string | null, nowMs: number): Promise<void> {
  const stmts = [db.prepare("DELETE FROM trip_prefs WHERE user_id = ? AND trip_key = ? AND pref IN (?, 'no-' || ?)").bind(userId, key, pref, pref)];
  if (choice !== 'undo') {
    stmts.push(
      db
        .prepare('INSERT INTO trip_prefs (user_id, trip_key, pref, label, set_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, key, choice === 'accept' ? pref : `no-${pref}`, label, nowMs),
    );
  }
  // Accepting "leave earlier" starts the count again, so it isn't suggested twice.
  if (choice !== 'undo') stmts.push(db.prepare("DELETE FROM trip_outcomes WHERE user_id = ? AND trip_key = ? AND outcome = ?").bind(userId, key, pref === 'earlier' ? 'missed' : 'skipped'));
  // The oldest go first past the cap.
  if (choice !== 'undo') {
    stmts.push(
      db
        .prepare('DELETE FROM trip_prefs WHERE user_id = ? AND rowid IN (SELECT rowid FROM trip_prefs WHERE user_id = ? ORDER BY set_at DESC, rowid DESC LIMIT -1 OFFSET ?)')
        .bind(userId, userId, MAX_PREFS),
    );
  }
  await db.batch(stmts);
}

/** Accepted choices, for the settings screen. */
export async function listPrefs(db: D1Database, userId: string): Promise<Array<{ trip: string; pref: PrefKind; label: string | null; since: string }>> {
  const { results } = await db
    .prepare("SELECT trip_key AS trip, pref, label, set_at AS setAt FROM trip_prefs WHERE user_id = ? AND pref IN ('earlier', 'quiet') ORDER BY set_at")
    .bind(userId)
    .all<{ trip: string; pref: PrefKind; label: string | null; setAt: number }>();
  return results.map((r) => ({ trip: r.trip, pref: r.pref, label: r.label, since: new Date(r.setAt).toISOString() }));
}

interface OutcomeRow {
  trip_key: string;
  day: string;
  outcome: Outcome;
  at: number;
}

/**
 * Everything the planner and the card need, in one round trip. `labelOf`
 * names a trip key ("CS2030 Lecture"), or null for a trip that no longer
 * exists (a suggestion about it would make no sense).
 */
export async function tripPrefs(db: D1Database, userId: string, nowMs: number, labelOf: (key: string) => string | null): Promise<TripPrefs> {
  const since = nowMs - KEEP_DAYS * DAY_MS;
  const [rows, prefs] = await db.batch([
    db.prepare('SELECT trip_key, day, outcome, at FROM trip_outcomes WHERE user_id = ? AND at >= ? ORDER BY at DESC LIMIT 200').bind(userId, since),
    db.prepare('SELECT trip_key, pref, set_at FROM trip_prefs WHERE user_id = ?').bind(userId),
  ]);
  const outcomes = (rows.results ?? []) as OutcomeRow[];
  const chosen = (prefs.results ?? []) as Array<{ trip_key: string; pref: string; set_at: number }>;

  const has = (key: string, pref: string, withinMs = Infinity) => chosen.some((c) => c.trip_key === key && c.pref === pref && nowMs - c.set_at < withinMs);
  const earlier = new Set(chosen.filter((c) => c.pref === 'earlier').map((c) => c.trip_key));
  const quiet = new Set(chosen.filter((c) => c.pref === 'quiet').map((c) => c.trip_key));

  return { earlier, quiet, suggestion: suggest() };

  function suggest(): Suggestion | null {
    const byTrip = new Map<string, OutcomeRow[]>();
    for (const o of outcomes) byTrip.set(o.trip_key, [...(byTrip.get(o.trip_key) ?? []), o]);
    for (const [key, list] of byTrip) {
      const label = labelOf(key);
      if (!label) continue;
      // "Not going" on its last three occurrences (the list is newest first).
      const last = list.slice(0, SKIPS);
      if (!quiet.has(key) && !has(key, 'no-quiet', DISMISS_DAYS * DAY_MS) && last.length === SKIPS && last.every((o) => o.outcome === 'skipped')) {
        return { id: `quiet:${key}`, text: m().suggestQuiet(label, SKIPS), accept: m().stopReminders, dismiss: m().keepThem };
      }
      const misses = list.filter((o) => o.outcome === 'missed' && nowMs - o.at < MISS_DAYS * DAY_MS).length;
      if (!earlier.has(key) && !has(key, 'no-earlier', DISMISS_DAYS * DAY_MS) && misses >= MISSES) {
        return { id: `earlier:${key}`, text: m().suggestEarlier(label, misses), accept: m().leaveEarlier, dismiss: m().noThanks };
      }
    }
    return null;
  }
}

/** How many trips are in the history, for "Clear trip history". */
export async function historySize(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM trip_outcomes WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * "Clear trip history": forgets every trip's outcome, so nothing is suggested
 * from them and a muted question is asked again. Choices already made
 * (trip_prefs) stay; each has its own Undo.
 */
export async function clearHistory(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare('DELETE FROM trip_outcomes WHERE user_id = ?').bind(userId).run();
  return r.meta.changes ?? 0;
}

/** For the account export: the history and the choices, as they're kept. */
export async function exportOutcomes(db: D1Database, userId: string): Promise<{ tripOutcomes: unknown[]; tripChoices: unknown[] }> {
  const [o, p] = await db.batch([
    db.prepare('SELECT trip_key AS trip, day, outcome FROM trip_outcomes WHERE user_id = ? ORDER BY at').bind(userId),
    db.prepare('SELECT trip_key AS trip, pref, label, set_at AS setAt FROM trip_prefs WHERE user_id = ? ORDER BY set_at').bind(userId),
  ]);
  return {
    tripOutcomes: o.results ?? [],
    tripChoices: ((p.results ?? []) as Array<{ trip: string; pref: string; label: string | null; setAt: number }>).map((r) => ({ ...r, setAt: new Date(r.setAt).toISOString() })),
  };
}
