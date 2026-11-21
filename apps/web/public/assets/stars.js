export const STARS = [
  [0.06, 0.3, 0.7],
  [0.17, 0.62, 0.5],
  [0.29, 0.18, 0.8],
  [0.38, 0.8, 0.4],
  [0.47, 0.42, 0.6],
  [0.55, 0.1, 0.5],
  [0.63, 0.68, 0.45],
  [0.72, 0.28, 0.7],
  [0.84, 0.88, 0.4],
  [0.92, 0.5, 0.55],
  [0.11, 0.95, 0.35],
  [0.33, 1, 0.4],
  [0.58, 0.98, 0.3],
];

export const starTop = (down) => `calc(${(down * 0.82).toFixed(3)} * var(--room, 108px) + 4px)`;

for (const el of globalThis.document?.querySelectorAll('[data-stars]') ?? []) {
  const sky = document.createElement('span');
  sky.className = 'night-sky';
  sky.setAttribute('aria-hidden', 'true');
  for (const [x, y, a] of STARS) {
    const star = document.createElement('span');
    star.className = 'star';
    star.style.cssText = `left: ${x * 100}%; top: ${starTop(y)}; opacity: ${a}`;
    sky.append(star);
  }
  const moon = document.createElement('span');
  moon.className = 'moon';
  sky.append(moon);
  el.replaceChildren(sky);
}
