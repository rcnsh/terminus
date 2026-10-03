// The signed-in account's profile and the campus it's about, shared by every
// part of the page that shows or changes them: Settings, first-time setup,
// and the map's "Save as place". One copy, so a place saved on the map is in
// Settings at once, and a change made in Settings is the one the map sees.

import { html, store, useStore } from '../assets/ui.js';
import { api, t } from './dom.js';

/** The profile as the server last returned it, with edits not yet saved. Null until loaded. */
export const profile = store(null);
/** /campus: stops, routes, destinations (the search list) and residences. Null until loaded. */
export const campus = store(null);
/** The user's walking speed (m/s, from their pace), as /me/next last said, for walk times worked out here. */
export const walkSpeed = store(1.3);
/** Bumped after each save: what depends on the profile (the account page's preview) redraws. */
export const saves = store(0);
/** Bumped when the lists the server keeps apart from the profile change (devices, keys, choices). */
export const lists = store(0);
/** The short message at the bottom of the screen ("Saved"), or null. */
export const toastText = store(null);

let toastTimer = null;
export function toast(text) {
  toastText.set(text);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastText.set(null), 1800);
}

/** Where toast() shows: once per page. */
export function Toast() {
  const text = useStore(toastText);
  // Kept while it fades out, so the words don't vanish first.
  const last = text ?? Toast.last ?? '';
  Toast.last = last;
  return html`<p class=${text ? 'toast show' : 'toast'} role="status" aria-live="polite">${last}</p>`;
}

/* ---------- loading and saving ---------- */

let saveTimer = null;
/** Counts edits: a save's reply doesn't replace edits made while it was on its way. */
let edits = 0;

/** A change waiting to be saved: reloading now would lose it. */
export const savePending = () => saveTimer !== null;

export async function loadProfile() {
  profile.set(await api('/me/profile'));
  return profile.get();
}

/** The profile afresh (it may have changed on the map or another device), unless a change here is waiting. */
export async function reloadProfile() {
  if (saveTimer) return;
  const p = await api('/me/profile');
  if (!saveTimer) profile.set(p);
}

/**
 * Changes the profile: `change` gets a copy to edit. Saved a moment later,
 * so a run of changes (typing, a few taps) is one save.
 */
export function edit(change) {
  const next = structuredClone(profile.get());
  change(next);
  profile.set(next);
  edits++;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const mine = edits;
    try {
      const saved = await api('/me/profile', { method: 'PUT', body: profile.get() });
      if (mine === edits) profile.set(saved);
      toast(t('Saved'));
      saves.set((n) => n + 1);
    } catch (err) {
      toast(t('Not saved. {0}', err.message));
    }
  }, 400);
}

/** Saves straight away, for steps that must land before moving on; throws if it can't. */
export async function saveNow(change) {
  clearTimeout(saveTimer);
  saveTimer = null;
  const next = structuredClone(profile.get());
  change?.(next);
  edits++;
  const saved = await api('/me/profile', { method: 'PUT', body: next });
  profile.set(saved);
  saves.set((n) => n + 1);
  return saved;
}

export async function loadCampus() {
  if (!campus.get()) campus.set(await api('/campus'));
  return campus.get();
}

/* ---------- reading them ---------- */

/** Every stop, by name, for menus. */
export const stopsByName = (c = campus.get()) => (c?.stops ?? []).map(({ code, name, lat, lon }) => ({ code, name, lat, lon })).sort((a, b) => a.name.localeCompare(b.name));

/** Residences on campus, by name. */
export const residencesByName = (c = campus.get()) => [...(c?.residences ?? [])].sort((a, b) => a.name.localeCompare(b.name));

/** A stop's name, or a food court's (favourites and classes can go to one). */
export function stopName(code) {
  const c = campus.get();
  return c?.stops.find((s) => s.code === code)?.name ?? c?.destinations?.find((d) => d.code === code)?.label ?? code;
}

export function haversineM(aLat, aLon, bLat, bLon) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Stops from nearest to furthest, with how far (metres). */
export function stopsNear(lat, lon) {
  return stopsByName()
    .map((s) => ({ s, d: haversineM(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.d - b.d);
}

/** The residence whose stops are exactly these, if any. Only stops are saved. */
export function residenceFor(homeStops) {
  const key = [...homeStops].sort().join();
  return residencesByName().find((r) => [...r.stops].sort().join() === key) ?? null;
}

/** A residence's walk to its stops, in minutes at a normal pace. */
export const residenceWalkMin = (r) => Math.max(1, Math.round(r.walkM / 1.3 / 60));

/**
 * Adds a favourite, called what was picked, short, as it reads on a button
 * ("KR MRT", "The Deck", "COM1" for School of Computing). One per stop.
 * Returns the one already there instead, if there is one.
 */
export function withPlace(p, to, label) {
  const same = p.places.find((x) => x.to === to);
  if (same) return same;
  label = label.slice(0, 24);
  let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';
  while (p.places.some((x) => x.key === key)) key = `${key.slice(0, 21)}-${Math.floor(Math.random() * 90 + 10)}`;
  p.places.push({ key, label, to });
  return null;
}
