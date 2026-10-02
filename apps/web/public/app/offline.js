// What the web app shows when it's offline and its last answer has gone
// stale: the next thing on the day plan it kept (/me/day). The Android and
// Mac apps follow the same rule (OfflineDay.kt, OfflineDay.swift), checked
// against the same cases (apps/api/test/fixtures/offline-day.json).

/** A class still counts this long after it starts: late, but still the one to go to. */
export const CLASS_GRACE_MS = 15 * 60_000;
/** A trip home with no end of its own stays up this long. */
export const HOME_FOR_MS = 60 * 60_000;

/** The SGT date (YYYY-MM-DD) at `nowMs`. */
export function sgtDate(nowMs) {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * The day plan's next item at `nowMs`, and which line to show for it:
 * `leaveBy` (its leave-by is still ahead), `leaveNow` (a class whose
 * leave-by has passed) or `home` (a trip home). Null when the plan is
 * another day's, or nothing in it is still ahead.
 */
export function offlineNext(day, nowMs) {
  if (!day || day.date !== sgtDate(nowMs)) return null;
  for (const item of day.items ?? []) {
    if (item.status === 'done' || item.status === 'skipped') continue;
    const start = Date.parse(item.startsAt);
    if (item.kind === 'class') {
      if (nowMs >= start + CLASS_GRACE_MS) continue;
      const leave = item.leave?.at ? Date.parse(item.leave.at) : null;
      return { item, step: leave !== null && nowMs < leave ? 'leaveBy' : 'leaveNow' };
    }
    const end = item.endsAt ? Date.parse(item.endsAt) : start + HOME_FOR_MS;
    if (nowMs >= end) continue;
    return { item, step: 'home' };
  }
  return null;
}
