// Destination search: a text box with a short, ranked, grouped list under it.
// Replaces the browser's own <datalist>, which listed every entry at once and
// could not say where a room or building actually takes you.

import { t } from './dom.js';

const KINDS = { timetable: 0, place: 1, class: 2, stop: 3, landmark: 4, building: 5, room: 6 };
const GROUP = { timetable: t('In your timetable'), place: t('Your favourites'), class: t('Your classes'), stop: t('Stops'), landmark: t('Food & places'), building: t('Buildings'), room: t('Rooms') };
const MAX = 8;

const norm = (s) => s.toLowerCase().replace(/[\s\-_]+/g, '');

/** 0 exact, 1 starts with, 2 a word starts with, 3 contains; -1 no match. */
export function score(d, query) {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  const names = [d.code.toLowerCase(), d.label.toLowerCase(), ...(d.aliases ?? [])];
  const nq = norm(q);
  if (names.some((n) => n === q) || norm(d.code) === nq) return 0;
  if (names.some((n) => n.startsWith(q)) || norm(d.code).startsWith(nq)) return 1;
  if (names.some((n) => n.split(/[\s()·,/&-]+/).some((w) => w && w.startsWith(q)))) return 2;
  if (names.some((n) => n.includes(q))) return 3;
  return -1;
}

/** The best few, most useful first. Rooms only once the query says which. */
export function rank(dests, query) {
  const q = query.trim();
  return dests
    .filter((d) => d.kind !== 'room' || q.length >= 2)
    .map((d) => ({ d, s: score(d, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || KINDS[a.d.kind] - KINDS[b.d.kind] || a.d.label.length - b.d.label.length)
    .slice(0, MAX)
    .map((x) => x.d);
}

const walkMin = (m) => Math.max(1, Math.round(m / 1.3 / 60));

/**
 * Turns `input` into a search box. `source()` gives the destinations,
 * `suggestions()` what to offer before anything is typed, `stopName(code)`
 * a stop's name. `pinned()`, if given, is listed first whenever it matches,
 * in its own group. The pick lands in input.dataset.stop (a stop code).
 */
export function attachSearch(input, { source, suggestions, stopName, onPick, pinned = () => [] }) {
  const wrap = document.createElement('div');
  wrap.className = 'search';
  input.replaceWith(wrap);
  wrap.append(input);
  const list = document.createElement('ul');
  const id = `search-${Math.random().toString(36).slice(2, 8)}`;
  list.id = id;
  list.className = 'search-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.autocomplete = 'off';

  let items = [];
  let active = -1;

  const meta = (d) => {
    if (d.kind === 'timetable') return d.detail;
    if (d.kind === 'stop') return t('Bus stop');
    if (d.kind === 'place' || d.kind === 'class') return t('{0} stop', stopName(d.stopCode));
    // Served by more than one stop: the quicker one is used at the time.
    if (d.kind === 'landmark') return `${d.detail ? `${d.detail} · ` : ''}${t('{0} stop', d.stops.map(stopName).join(t(' or ')))}`;
    const code = d.label !== d.code ? `${d.code} · ` : '';
    return `${code}${t('{0} stop', stopName(d.stopCode))}${d.walkM != null ? t(', {0} min walk', walkMin(d.walkM)) : ''}`;
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const highlight = (i) => {
    active = i;
    list.querySelectorAll('[role=option]').forEach((li, k) => li.classList.toggle('active', k === i));
    if (i >= 0) input.setAttribute('aria-activedescendant', `${id}-${i}`);
  };

  const pick = (d) => {
    input.value = d.kind === 'room' || d.label === d.code ? d.code : d.label;
    // A place with several stops is kept whole, so the router can pick.
    input.dataset.stop = d.kind === 'landmark' ? d.code : d.stopCode;
    input.setCustomValidity('');
    close();
    onPick?.(d);
  };

  const open = () => {
    const q = input.value.trim();
    if (q) {
      const top = rank(pinned(), q);
      items = [...top, ...rank(source(), q).filter((d) => !top.some((t) => t.code === d.code))].slice(0, MAX);
    } else {
      items = suggestions();
    }
    list.replaceChildren();
    if (!items.length) {
      if (q) {
        const li = document.createElement('li');
        li.className = 'search-empty';
        li.textContent = t('No stop, building or room by that name');
        list.append(li);
      } else return close();
    }
    let group = null;
    items.forEach((d, i) => {
      if (d.kind !== group) {
        group = d.kind;
        const h = document.createElement('li');
        h.className = 'search-group';
        h.setAttribute('role', 'presentation');
        h.textContent = GROUP[d.kind];
        list.append(h);
      }
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'search-title';
      title.textContent = d.label;
      const sub = document.createElement('span');
      sub.className = 'search-meta';
      sub.textContent = meta(d);
      li.append(title, sub);
      // mousedown, not click: the input's blur would close the list first.
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(d);
      });
      list.append(li);
    });
    list.hidden = false;
    // Wide enough to read even under a narrow box; kept on screen by opening
    // leftwards when there's no room to the right.
    const box = wrap.getBoundingClientRect();
    list.classList.toggle('flip', box.left + list.offsetWidth > document.documentElement.clientWidth - 8);
    input.setAttribute('aria-expanded', 'true');
    highlight(items.length && q ? 0 : -1);
  };

  input.addEventListener('input', () => {
    delete input.dataset.stop;
    open();
  });
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 0));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && e.key === 'ArrowDown') return open();
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(Math.min(items.length - 1, active + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(Math.max(0, active - 1));
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return { clear: () => { input.value = ''; delete input.dataset.stop; } };
}
