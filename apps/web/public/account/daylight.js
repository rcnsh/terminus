// What the sky over Now looks like at each hour (sky.js draws it). A plain
// function, so the API's tests import it, and the Android app keeps the
// same hours (NightSky.kt phaseAt).

/** The sky's looks, in the order of the day. */
export const PHASES = ['night', 'dawn', 'day', 'golden', 'dusk'];

/**
 * The sky at `min` minutes past midnight: dawn from 6:30, day from 8:30,
 * the golden hour from 4:30 PM, dusk from 6:45 PM and night from 7:40 PM.
 * Fixed hours, as Singapore's sunrise and sunset move little over the year.
 */
export function phaseAt(min) {
  if (min < 390 || min >= 1180) return 'night';
  if (min < 510) return 'dawn';
  if (min < 990) return 'day';
  if (min < 1125) return 'golden';
  return 'dusk';
}

/**
 * How far each layer of the sky lags as Now scrolls down by `s` px, so the
 * far things move slower than the near ones: the moon and the stars at half
 * speed, fading out by 160 px; the far hills, the city and a low sun sinking
 * behind the near hill, by 18 px at most. The near hill, the road and your
 * bus stay with the page. Each is how far down the page the layer moves, in
 * px (dp on Android: NightSky.kt parallax).
 */
export function parallax(s) {
  const y = Math.max(0, s);
  return { sky: y * 0.5, far: Math.min(y * 0.12, 18), fade: Math.max(0, 1 - y / 160) };
}
