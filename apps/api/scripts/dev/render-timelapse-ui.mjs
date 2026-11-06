/**
 * What render-timelapse.mjs finds on the dashboard's Timelapse, in one
 * place. apps/web/test/web-render-timelapse.test.js draws the page and
 * checks every entry, so a change to the page's markup fails the tests
 * rather than the next unattended render.
 */

/** CSS selectors. */
export const UI = {
  token: '#timelapse-token',
  day: 'select[aria-label="Day"]',
  shape: '[role="group"][aria-label="Shape of the video"]',
  map: '[role="group"][aria-label="Map"]',
  overlay: '[role="group"][aria-label="Overlay"]',
  length: '[role="group"][aria-label="Length of the video"]',
  otherLength: 'input[aria-label="Other length, in seconds"]',
  from: '[role="slider"][aria-label="Start of the video"]',
  to: '[role="slider"][aria-label="End of the video"]',
  exportButton: '.export button.accent',
  summary: '.export .what',
  // Drawn only when something goes wrong: the day won't load, say.
  note: '.timelapse > p.bad',
  // Drawn only while an export runs, once it fails, or once it's done.
  progress: '.job .meta',
  failed: '.job.bad',
};

/** The words on the buttons, by the option each picks. */
export const WORDS = {
  open: 'Open the timelapse',
  shape: { story: 'Stories', wide: 'Landscape' },
  map: { dark: 'Dark map', light: 'Light map' },
  overlay: { on: 'Clock and counts', off: 'Map only' },
  /** The length buttons read "60 s"; any other length goes in UI.otherLength. */
  length: (seconds) => `${seconds} s`,
  export: 'Export the video',
  download: 'Download the video',
};
