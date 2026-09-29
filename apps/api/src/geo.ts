/**
 * Distance on the Earth's surface. A leaf module: it imports nothing, so
 * resolve.ts, walk.ts and residences.ts can all use it without importing
 * each other in a circle.
 */

const EARTH_R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}
