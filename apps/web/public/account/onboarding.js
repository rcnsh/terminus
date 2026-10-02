// First sign-in setup, one step at a time, and the one-off "walking pace"
// screen for accounts set up before it existed. Everything it needs comes in
// through `ctx`, so it has no hold on the account page's own state.

import { t } from './dom.js';

const PACES = [
  { value: 'slow', title: t('Slow'), hint: t('A relaxed pace, or if you often carry a bag'), min: 6 },
  { value: 'normal', title: t('Normal'), hint: t('An average pace'), min: 5 },
  { value: 'fast', title: t('Fast'), hint: t("A brisk pace"), min: 4 },
];

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Walks a brand-new account through setup. Resolves when the user finishes
 * or skips; the profile is saved as they go, so leaving halfway loses nothing.
 */
export function runOnboarding(ctx) {
  const { el, api } = ctx;
  const root = document.querySelector('#onboarding');
  const steps = [welcome, timetable, home, travel, apps];

  return new Promise((done) => {
    const finish = async () => {
      ctx.profile.seen = [...new Set([...(ctx.profile.seen ?? []), 'onboarding'])];
      await ctx.save().catch(() => {});
      root.classList.add('leaving');
      setTimeout(() => {
        root.hidden = true;
        root.classList.remove('leaving');
        window.scrollTo({ top: 0 });
        done();
      }, reduced() ? 0 : 240);
    };

    const frame = (n) => {
      const bar = el('div', { class: 'ob-progress', role: 'progressbar', 'aria-label': t('Setup progress') });
      bar.setAttribute('aria-valuemin', '1');
      bar.setAttribute('aria-valuemax', String(steps.length));
      bar.setAttribute('aria-valuenow', String(n + 1));
      const fill = el('div', { class: 'ob-fill' });
      // Starts at the previous step's length, so the bar grows into place.
      // Scaled, not resized: a width change would re-lay out the page.
      fill.style.transform = `scaleX(${n / steps.length})`;
      bar.append(fill);
      requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.transform = `scaleX(${(n + 1) / steps.length})`)));
      const top = el(
        'div',
        { class: 'ob-top' },
        el('span', { class: 'ob-count', textContent: n ? t('Step {0} of {1}', n, steps.length - 1) : t('Welcome') }),
        el('button', { type: 'button', class: 'link-btn', textContent: t('Skip setup'), onclick: finish }),
      );
      return [top, bar];
    };

    const show = (n, dir = 1) => {
      const card = el('div', { class: `ob-card ob-in-${dir > 0 ? 'fwd' : 'back'}` });
      const nav = {
        next: async (work) => {
          if (work) await work();
          if (n + 1 >= steps.length) return finish();
          go(n + 1, 1);
        },
        back: n > 0 ? () => go(n - 1, -1) : null,
      };
      card.append(...steps[n](ctx, nav));
      const old = root.querySelector('.ob-card');
      root.replaceChildren(...frame(n), card);
      if (old) card.addEventListener('animationend', () => card.classList.remove('ob-in-fwd', 'ob-in-back'), { once: true });
      // Focus follows the step, for keyboards and screen readers.
      card.querySelector('h1')?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    };

    const go = (n, dir) => {
      const card = root.querySelector('.ob-card');
      if (!card || reduced()) return show(n, dir);
      card.classList.add(dir > 0 ? 'ob-out-fwd' : 'ob-out-back');
      setTimeout(() => show(n, dir), 160);
    };

    root.hidden = false;
    show(0);
  });

  /* ---------- steps ---------- */

  function heading(text, sub) {
    const h = el('h1', { textContent: text, tabIndex: -1 });
    return sub ? [h, el('p', { class: 'ob-sub', textContent: sub })] : [h];
  }

  function actions(nav, { next = t('Continue'), skip, onNext } = {}) {
    const row = el('div', { class: 'ob-actions' });
    if (nav.back) row.append(el('button', { type: 'button', class: 'btn ghost', textContent: t('Back'), onclick: nav.back }));
    row.append(el('span', { class: 'ob-grow' }));
    if (skip) row.append(el('button', { type: 'button', class: 'link-btn', textContent: skip, onclick: () => nav.next() }));
    const primary = el('button', { type: 'button', class: 'btn accent', textContent: next });
    primary.addEventListener('click', async () => {
      primary.disabled = true;
      try {
        await nav.next(onNext);
      } catch (err) {
        primary.disabled = false;
        ctx.toast(err.message);
      }
    });
    row.append(primary);
    return row;
  }

  function welcome(_ctx, nav) {
    return [
      el('img', { class: 'ob-mark', src: '/assets/mark.svg', alt: '' }),
      ...heading(t('Welcome to terminus'), t('It tells you when to leave for class, not just when the bus comes. Setting up takes about a minute.')),
      el(
        'ul',
        { class: 'ob-list' },
        el('li', { textContent: t('Your timetable, so it knows where you are going') }),
        el('li', { textContent: t('Where your day starts') }),
        el('li', { textContent: t('How fast you walk') }),
      ),
      actions(nav, { next: t('Get started') }),
    ].filter(Boolean);
  }

  function timetable(ctx, nav) {
    const input = el('input', { type: 'url', placeholder: 'https://nusmods.com/timetable/sem-1/share?…', value: ctx.profile.share ?? '' });
    input.setAttribute('aria-label', t('NUSMods share link'));
    const msg = el('p', { class: 'hint', role: 'status' });
    let imported = Boolean(ctx.profile.trips?.length);
    if (imported) msg.textContent = t('{0} classes already imported.', ctx.profile.trips.length);
    const doImport = async () => {
      const share = input.value.trim();
      if (!share) return;
      msg.textContent = t('Importing…');
      const r = await api('/me/import', { method: 'POST', body: { share } });
      Object.assign(ctx.profile, r.profile);
      ctx.onImport?.(r);
      imported = true;
      const n = r.profile.trips.length;
      msg.textContent = n === 1 ? t('Imported 1 class for {0}.', r.term) : t('Imported {0} classes for {1}.', n, r.term);
      // The next step replaces this one straight away: say it where it stays.
      ctx.toast(msg.textContent);
    };
    return [
      ...heading(t('Your timetable'), t('Paste your NUSMods share link. Each class goes to the stop nearest its room.')),
      el('label', { textContent: t('NUSMods share link') }),
      input,
      el('p', { class: 'hint', textContent: t('In NUSMods: Timetable, then Share/Sync, then Copy link.') }),
      msg,
      actions(nav, {
        skip: t("I'll do this later"),
        onNext: async () => {
          if (input.value.trim() && (!imported || input.value.trim() !== ctx.profile.share)) {
            try {
              await doImport();
            } catch (err) {
              msg.textContent = err.message;
              throw err;
            }
          }
        },
      }),
    ];
  }

  function home(ctx, nav) {
    const current = ctx.profile.home?.stops ?? [];
    let picked = null; // a residence's stops, when one is chosen
    const residence = el('select', {}, el('option', { value: '', textContent: t("Off campus, or I'll pick a stop") }));
    for (const r of ctx.residences) residence.append(el('option', { value: r.code, textContent: r.name }));
    residence.setAttribute('aria-label', t('Where you live'));
    const first = ctx.stopSelect(current[0], () => {}, { blank: t('Choose a stop') });
    first.setAttribute('aria-label', t('Home stop'));
    const walk = el('input', { type: 'number', min: 0, max: 30, step: 1, value: ctx.profile.homeWalkMin ?? 5 });
    walk.setAttribute('aria-label', t('Minutes from home to your stop'));
    const msg = el('p', { class: 'hint', role: 'status' });
    const locate = el('button', {
      type: 'button',
      class: 'link-btn locate',
      textContent: t('Pick the stop nearest me'),
      onclick: () => {
        if (!navigator.geolocation) return (msg.textContent = t('This browser cannot share its location.'));
        msg.textContent = t('Finding the nearest stop…');
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => {
            const s = ctx.nearestStop(coords.latitude, coords.longitude);
            first.value = s.code;
            msg.textContent = t('Picked {0}. Change it if you use a different stop.', s.name);
          },
          (err) => (msg.textContent = t("Couldn't get your location ({0}). Pick your stop instead.", err.message)),
          { enableHighAccuracy: true, timeout: 10_000 },
        );
      },
    });
    residence.addEventListener('change', () => {
      picked = ctx.residences.find((r) => r.code === residence.value) ?? null;
      if (!picked) return;
      first.value = picked.stops[0];
      walk.value = Math.max(1, Math.round(picked.walkM / 1.3 / 60));
      msg.textContent = t("Stops for {0} added. The app won't direct you home when you're already there.", picked.name);
    });
    return [
      ...heading(t('Where your day starts'), t('Where you catch the bus in the morning, and head back to at the end of the day. Only the stops are saved, never where you live.')),
      el('label', { textContent: t('Where do you live?') }),
      residence,
      el('label', { textContent: t('Home stop') }),
      first,
      locate,
      msg,
      el('label', { textContent: t('Walk from home to that stop') }),
      el('div', { class: 'row tight' }, walk, el('span', { textContent: t('minutes') })),
      el('p', { class: 'hint', textContent: t('Used when the app does not have your location.') }),
      actions(nav, {
        onNext: async () => {
          const v = Number(walk.value);
          // A residence brings all its stops; otherwise the one chosen here first.
          if (picked && first.value === picked.stops[0]) ctx.profile.home = { stops: [...picked.stops] };
          else if (first.value) ctx.profile.home = { stops: [first.value, ...current.filter((c) => c !== first.value)].slice(0, 3) };
          if (Number.isInteger(v) && v >= 0 && v <= 30) ctx.profile.homeWalkMin = v;
          await ctx.save();
        },
      }),
    ];
  }

  function travel(ctx, nav) {
    const picker = pacePicker(ctx);
    const full = fullBusToggle(ctx);
    return [
      ...heading(t('How you get around'), t('Walks follow the real paths on campus. Your pace sets how long they take.')),
      picker.node,
      full.node,
      actions(nav, {
        onNext: async () => {
          ctx.profile.walkPace = picker.value();
          ctx.profile.fullBusMargin = full.value();
          await ctx.save();
        },
      }),
    ];
  }

  function apps(_ctx, nav) {
    const link = (href, title, text) =>
      el('a', { class: 'ob-app', href }, el('strong', { textContent: title }), el('span', { class: 'hint', textContent: text }));
    return [
      ...heading(t("You're set"), t('Your widget preview is on the next page. For times on your phone or Mac, get the app and sign in with this email, or pair it from the Devices card with a code.')),
      el(
        'div',
        { class: 'ob-apps' },
        link('/download/android', 'Android', t('App and home-screen widgets')),
        link('/download/mac', 'Mac', t('Menu bar app, Apple silicon')),
      ),
      actions(nav, { next: t('Go to my account') }),
    ];
  }
}

/** Three cards, one chosen. Returns the node and a getter. */
export function pacePicker(ctx) {
  const { el } = ctx;
  let chosen = ctx.profile.walkPace ?? 'normal';
  const group = el('div', { class: 'ob-paces', role: 'radiogroup', 'aria-label': t('Walking pace') });
  const cards = PACES.map((p) => {
    const card = el(
      'button',
      { type: 'button', class: 'ob-pace', role: 'radio' },
      el('strong', { textContent: p.title }),
      el('span', { class: 'ob-pace-eg', textContent: t('400 m in about {0} min', p.min) }),
      el('span', { class: 'hint', textContent: p.hint }),
    );
    card.addEventListener('click', () => select(p.value));
    card.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      const next = PACES[(PACES.findIndex((x) => x.value === chosen) + k + PACES.length) % PACES.length].value;
      select(next);
      cards[PACES.findIndex((x) => x.value === next)].focus();
    });
    return card;
  });
  const select = (v) => {
    chosen = v;
    cards.forEach((c, i) => {
      const on = PACES[i].value === v;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    });
  };
  select(chosen);
  group.append(...cards);
  return { node: group, value: () => chosen };
}

export function fullBusToggle(ctx) {
  const { el } = ctx;
  const box = el('input', { type: 'checkbox', checked: ctx.profile.fullBusMargin !== false });
  const node = el(
    'label',
    { class: 'check ob-check' },
    box,
    el(
      'span',
      {},
      el('strong', { textContent: t('Allow for packed buses') }),
      el('span', { class: 'hint', textContent: t('When the bus you would wait for is often full at that stop and time, aim one bus earlier.') }),
    ),
  );
  return { node, value: () => box.checked };
}
