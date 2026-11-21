export const PHASES = ['night', 'dawn', 'day', 'golden', 'dusk'];

export function phaseAt(min) {
  if (min < 390 || min >= 1180) return 'night';
  if (min < 510) return 'dawn';
  if (min < 990) return 'day';
  if (min < 1125) return 'golden';
  return 'dusk';
}

export function parallax(s) {
  const y = Math.max(0, s);
  return { sky: y * 0.5, far: Math.min(y * 0.12, 18), fade: Math.max(0, 1 - y / 160) };
}
