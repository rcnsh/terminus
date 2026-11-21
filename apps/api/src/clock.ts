import { m } from './i18n.ts';
import { SGT_MS } from './config.ts';

export function clockMin(minutes: number, h12 = false): string {
  const h = Math.floor(minutes / 60) % 24;
  const mm = String(minutes % 60).padStart(2, '0');
  if (!h12) return `${String(h).padStart(2, '0')}:${mm}`;
  return m().clock12(`${h % 12 || 12}:${mm}`, h >= 12);
}

export function clockAt(ms: number, h12 = false): string {
  const d = new Date(ms + SGT_MS);
  return clockMin(d.getUTCHours() * 60 + d.getUTCMinutes(), h12);
}

export function slackText(slackS: number): string {
  const n = Math.round(slackS / 60);
  return n > 0 ? m().earlyBy(n) : n === 0 ? m().justInTime : m().lateBy(-n);
}
