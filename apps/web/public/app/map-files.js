// Where the map's libraries live: MapLibre and the PMTiles reader, vendored
// with their version in the folder's name (scripts/vendor-map.sh). The one
// place that names them, for the Map tab (map.js), the timelapse page, and
// the hint below that fetches them early.

// "@" spelled %40: Cloudflare's static assets redirect the "@" form to it,
// which cost a round trip per file.
export const MAPLIBRE = '/vendor/maplibre-gl%406.11.2/';
export const PMTILES = '/vendor/pmtiles%404.5.0/pmtiles.mjs';

let hinted = false;

/**
 * Asks for the Map tab's code and MapLibre at once, before they're needed:
 * as the tab is touched or hovered, and as it opens. Without it they come
 * one after another (map.js, then maplibre-gl.mjs, then the shared half it
 * imports, about 300 KB compressed), each found only once the last arrives.
 */
export function preloadMap() {
  if (hinted) return;
  hinted = true;
  const add = (rel, href, as) => {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (as) link.as = as;
    document.head.append(link);
  };
  for (const href of ['/app/map.js', `${MAPLIBRE}maplibre-gl.mjs`, `${MAPLIBRE}maplibre-gl-shared.mjs`, PMTILES]) add('modulepreload', href);
  add('preload', `${MAPLIBRE}maplibre-gl.css`, 'style');
}
