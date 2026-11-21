export const MAPLIBRE = '/vendor/maplibre-gl%406.11.2/';
export const PMTILES = '/vendor/pmtiles%404.5.0/pmtiles.mjs';

let hinted = false;

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
  for (const href of ['/app/map.js', `${MAPLIBRE}maplibre-gl.mjs`, `${MAPLIBRE}maplibre-gl-shared.mjs`, PMTILES])
    add('modulepreload', href);
  add('preload', `${MAPLIBRE}maplibre-gl.css`, 'style');
}
