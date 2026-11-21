(() => {
  const phaseAt = (min) => (min < 390 || min >= 1180 ? 'night' : min < 510 ? 'dawn' : min < 990 ? 'day' : min < 1125 ? 'golden' : 'dusk');
  const set = () => {
    const d = new Date();
    document.documentElement.dataset.sky = phaseAt(d.getHours() * 60 + d.getMinutes());
  };
  set();
  setInterval(set, 60_000);
  const body = document.body;
  if (body && 'nowSky' in body.dataset) body.classList.add('sky', `sky-${document.documentElement.dataset.sky}`);
})();
