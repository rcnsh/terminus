export const TABS = ['now', 'nearby', 'buses', 'map', 'settings'];

export function tabOf(hash) {
  if (hash === '#map') return 'map';
  if (hash === '#nearby') return 'nearby';
  if (hash.startsWith('#settings')) return 'settings';
  if (hash.startsWith('#buses')) return 'buses';
  return 'now';
}
