// The hour's sky for the website's own pages (sky.css), on <html data-sky>.
// Loaded in <head>, before the page, so a page never shows the night first
// and then the day. The hours are daylight.js phaseAt's (a module can't run
// this early); web-sky.test.js keeps the two the same. Checked each minute.
(() => {
  /** The sky at `min` minutes past midnight, as daylight.js phaseAt. */
  const phaseAt = (min) => (min < 390 || min >= 1180 ? 'night' : min < 510 ? 'dawn' : min < 990 ? 'day' : min < 1125 ? 'golden' : 'dusk');
  const set = () => {
    const d = new Date();
    document.documentElement.dataset.sky = phaseAt(d.getHours() * 60 + d.getMinutes());
  };
  set();
  setInterval(set, 60_000);
})();
