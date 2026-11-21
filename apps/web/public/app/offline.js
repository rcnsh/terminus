export const CLASS_GRACE_MS = 15 * 60_000;
export const HOME_FOR_MS = 60 * 60_000;

export function sgtDate(nowMs) {
  return new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
}

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
