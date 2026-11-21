import { html, store, useStore } from '../assets/ui.js';
import { api, apiTagged, setClockPref, t } from './dom.js';

export const profile = store(null);
profile.subscribe((p) => p && setClockPref(p.clock));
export const campus = store(null);
export const walkSpeed = store(1.3);
export const saves = store(0);
export const lists = store(0);
export const toastText = store(null);

export const TOAST_MS = 4_000;

let toastTimer = null;
export function toast(text, { error = false, action = null } = {}) {
  if (!error && !action && toastText.get()?.action) return;
  toastText.set(action ? { text, error, action } : { text, error });
  clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => toastText.set(null), action ? TOAST_MS * 1.5 : TOAST_MS);
}

export function Toast() {
  const now = useStore(toastText);
  const last = now ?? Toast.last ?? { text: '' };
  Toast.last = last;
  return html`
    <div class=${`toast${now ? ' show' : ''}${last.error ? ' error' : ''}${last.action ? ' has-action' : ''}`}>
      <p role="status">${now ? now.text : ''}</p>
      ${
        now?.action &&
        html`<button
        type="button"
        class="toast-action"
        onClick=${() => {
          toastText.set(null);
          now.action.run();
        }}
      >${now.action.label}</button>`
      }
      ${now?.error && html`<button type="button" class="toast-close" aria-label=${t('Close')} onClick=${() => toastText.set(null)}>×</button>`}
      ${!now && html`<p aria-hidden="true">${last.text}</p>`}
    </div>
  `;
}

const SAVE_TRIES = 3;

let saveTimer = null;
let confirmed = null;
let pending = [];
let sending = null;
let importing = null;
const awaited = new WeakSet();
let edits = 0;

const loaded = ({ data, etag }) => {
  confirmed = { doc: data, etag };
  return data;
};

function withChanges(doc, changes) {
  const next = structuredClone(doc);
  for (const change of changes) change(next);
  return next;
}

export async function loadProfile() {
  profile.set(loaded(await apiTagged('/api/me/profile')));
  return profile.get();
}

const busy = () => Boolean(saveTimer || sending || pending.length || importing);

export async function reloadProfile() {
  if (busy()) return;
  const mine = edits;
  const r = await apiTagged('/api/me/profile');
  if (!busy() && mine === edits) profile.set(loaded(r));
}

export function edit(change) {
  record(change);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    sendSave().catch(() => {});
  }, 400);
}

function record(change) {
  const next = structuredClone(profile.get());
  change(next);
  profile.set(next);
  pending.push(change);
  edits++;
}

function sendSave() {
  if (sending || importing || !pending.length) return sending?.done ?? Promise.resolve(null);
  const changes = pending;
  pending = [];
  const batch = { changes, quiet: changes.some((c) => awaited.has(c)) };
  batch.done = (async () => {
    try {
      let saved = null;
      for (let tries = 1; !saved; tries++) {
        if (!confirmed) loaded(await apiTagged('/api/me/profile'));
        const base = confirmed;
        try {
          saved = loaded(
            await apiTagged('/api/me/profile', { method: 'PUT', body: withChanges(base.doc, changes), ifMatch: base.etag ?? undefined }),
          );
        } catch (err) {
          if (err.status !== 412 || tries >= SAVE_TRIES) throw err;
          confirmed = null;
        }
      }
      profile.set(withChanges(saved, pending));
      if (!batch.quiet) toast(t('Saved'));
      saves.set((n) => n + 1);
      return saved;
    } catch (err) {
      if (confirmed) profile.set(withChanges(confirmed.doc, pending));
      if (!batch.quiet) toast(err.status ? t('Not saved. {0}', err.message) : t('Not saved. Check your connection.'), { error: true });
      throw err;
    } finally {
      sending = null;
      if (!saveTimer) sendSave().catch(() => {});
    }
  })();
  sending = batch;
  return batch.done;
}

export async function saveNow(change) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const mine = change ?? (() => {});
  awaited.add(mine);
  record(mine);
  for (;;) {
    if (sending?.changes.includes(mine)) return sending.done;
    if (sending) await sending.done.catch(() => {});
    else if (importing) await importing.catch(() => {});
    else sendSave().catch(() => {});
  }
}

export async function importTimetable(share) {
  clearTimeout(saveTimer);
  saveTimer = null;
  while (importing) await importing.catch(() => {});
  sendSave().catch(() => {});
  while (sending) await sending.done.catch(() => {});
  const run = (async () => {
    try {
      const { data, etag } = await apiTagged('/api/me/import', { method: 'POST', body: { share } });
      confirmed = { doc: data.profile, etag };
      profile.set(withChanges(data.profile, pending));
      return data;
    } finally {
      importing = null;
      if (!saveTimer) sendSave().catch(() => {});
    }
  })();
  importing = run;
  return run;
}

export async function loadCampus() {
  if (!campus.get()) campus.set(await api('/api/campus'));
  return campus.get();
}

export const campusRefused = store(false);

globalThis.navigator?.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.kind !== 'campus') return;
  if (e.data.status === 401) campusRefused.set(true);
  else if (!e.data.status && campus.get())
    api('/api/campus').then(
      (c) => campus.set(c),
      () => {},
    );
});

export const stopsByName = (c = campus.get()) =>
  (c?.stops ?? []).map(({ code, name, lat, lon }) => ({ code, name, lat, lon })).sort((a, b) => a.name.localeCompare(b.name));

export const residencesByName = (c = campus.get()) =>
  [...(c?.residences ?? [])].sort((a, b) => Number(b.common === true) - Number(a.common === true) || a.name.localeCompare(b.name));

export function ResidenceOptions({ residences }) {
  const option = (r) => html`<option value=${r.code} key=${r.code}>${r.name}</option>`;
  const common = residences.filter((r) => r.common);
  if (!common.length) return residences.map(option);
  return html`
    <optgroup label=${t('Most common')}>${common.map(option)}</optgroup>
    <optgroup label=${t('Other residences')}>${residences.filter((r) => !r.common).map(option)}</optgroup>
  `;
}

export function stopName(code) {
  const c = campus.get();
  return c?.stops.find((s) => s.code === code)?.name ?? c?.destinations?.find((d) => d.code === code)?.label ?? code;
}

export function haversineM(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function stopsNear(lat, lon) {
  return stopsByName()
    .map((s) => ({ s, d: haversineM(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d);
}

export function residenceFor(homeStops) {
  const key = [...homeStops].sort().join();
  return residencesByName().find((r) => [...r.stops].sort().join() === key) ?? null;
}

export const residenceWalkMin = (r) => r.walkMin ?? Math.max(1, Math.round(r.walkM / 1.3 / 60));

export const limit = (key, fallback) => profile.get()?.limits?.[key] ?? fallback;

export const pinMax = () => limit('pinnedStops', 8);

export async function togglePin(code) {
  if (!profile.get()) await reloadProfile().catch(() => {});
  if (!profile.get()) return toast(t("Couldn't pin that. Check your connection."), { error: true });
  const pins = profile.get().pinnedStops ?? [];
  if (pins.includes(code)) {
    edit((p) => {
      p.pinnedStops = (p.pinnedStops ?? []).filter((c) => c !== code);
    });
  } else if (pins.length >= pinMax()) {
    toast(t('You can pin up to {0} stops.', pinMax()), { error: true });
  } else {
    edit((p) => {
      p.pinnedStops = [...(p.pinnedStops ?? []), code];
    });
  }
}

export function withPlace(p, to, label, keep = {}) {
  const same = p.places.find((x) => x.to === to);
  if (same) return same;
  label = label.slice(0, 24);
  let key =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'place';
  if (keep.key && !p.places.some((x) => x.key === keep.key)) key = keep.key;
  while (p.places.some((x) => x.key === key)) key = `${key.slice(0, 21)}-${Math.floor(Math.random() * 90 + 10)}`;
  keep.key = key;
  p.places.push({ key, label, to });
  return null;
}

export function withoutPlace(p, key) {
  const index = p.places.findIndex((x) => x.key === key);
  if (index < 0) return null;
  const [place] = p.places.splice(index, 1);
  const usual = (p.usual ?? []).filter((u) => u.place === key);
  p.usual = (p.usual ?? []).filter((u) => u.place !== key);
  return { index, place, usual };
}

export function restorePlace(p, { index, place, usual }) {
  if (p.places.length >= (p.limits?.places ?? Infinity) || p.places.some((x) => x.to === place.to || x.key === place.key)) return;
  p.places.splice(Math.min(index, p.places.length), 0, place);
  if (usual.length) p.usual = [...(p.usual ?? []), ...usual];
}
