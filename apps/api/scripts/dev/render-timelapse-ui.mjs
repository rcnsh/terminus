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
  note: '.timelapse > p.bad',
  progress: '.job .meta',
  failed: '.job.bad',
};

export const WORDS = {
  open: 'Open the timelapse',
  shape: { story: 'Stories', wide: 'Landscape' },
  map: { dark: 'Dark map', light: 'Light map' },
  overlay: { on: 'Clock and counts', off: 'Map only' },
  length: (seconds) => `${seconds} s`,
  export: 'Export the video',
  download: 'Download the video',
};
