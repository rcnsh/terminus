/**
 * Clock times and lateness, worded once for every client.
 *
 * Campus time (SGT) always: class times and bus times must read in the same
 * zone whatever the phone is set to. `h12` is the client's own preference
 * (`?h12=1`); without it, 24-hour, which is what the API has always sent.
 */

const SGT_MS = 8 * 3_600_000;

/** "18:36", or "6:36 PM" with h12. */
export function clockMin(minutes: number, h12 = false): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = String(minutes % 60).padStart(2, '0');
  if (!h12) return `${String(h).padStart(2, '0')}:${m}`;
  return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** An instant as campus clock time. */
export function clockAt(ms: number, h12 = false): string {
  const d = new Date(ms + SGT_MS);
  return clockMin(d.getUTCHours() * 60 + d.getUTCMinutes(), h12);
}

/**
 * Spare time before a class, in words: "4 min early", "just in time",
 * "~3 min late". Rounded to the minute, so the card and the pill agree.
 */
export function slackText(slackS: number): string {
  const m = Math.round(slackS / 60);
  return m > 0 ? `${m} min early` : m === 0 ? 'just in time' : `~${-m} min late`;
}
