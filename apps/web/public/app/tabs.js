// The web app's tabs, in the bar's order, and which one an address opens.
// Apart from app.js, which starts the app as it loads, so a test can read it.

/** Now, Nearby, Stops (`buses`, ADR 0014), Map and Settings. */
export const TABS = ['now', 'nearby', 'buses', 'map', 'settings'];

/**
 * The tab address `hash` opens: #nearby, #buses and its pages
 * (#buses/line/D1), #map, #settings and its pages (#settings/trips). Now
 * for anything else, so an address from elsewhere still opens the app.
 */
export function tabOf(hash) {
  if (hash === '#map') return 'map';
  if (hash === '#nearby') return 'nearby';
  if (hash.startsWith('#settings')) return 'settings';
  if (hash.startsWith('#buses')) return 'buses';
  return 'now';
}
