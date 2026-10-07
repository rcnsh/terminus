// First sign-in setup, one step at a time: the timetable, where the day
// starts, how fast you walk, and the apps. The profile is saved as it goes
// (profile.js), so leaving halfway loses nothing.

import { html, reducedMotion, useEffect, useMemo, useRef, useState, useStore } from '../assets/ui.js';
import { api, browserHour12, clock, inkOn, locationError, t } from './dom.js';
import { campus, limit, profile, ResidenceOptions, residenceWalkMin, residencesByName, saveNow, stopName, stopsNear, toast, TOAST_MS } from './profile.js';
import { CLOCKS, StopSelect } from './settings-pages.js';

const PACES = [
  { value: 'slow', title: t('Slow'), min: 6 },
  { value: 'normal', title: t('Normal'), min: 5 },
  { value: 'fast', title: t('Fast'), min: 4 },
];

const STEPS = [Welcome, TimetableStep, Home, Travel, Apps];

/** Walks a brand-new account through setup; `onDone` runs when it's finished or skipped. */
export function Onboarding({ onDone }) {
  // `out`: the card leaving, before the next one comes in.
  const [step, setStep] = useState({ n: 0, dir: 1, out: null });
  const [leaving, setLeaving] = useState(false);
  const card = useRef(null);
  const { n, dir, out } = step;

  const finish = async () => {
    // Not saved, setup comes back next time: say so, but let them in. The
    // notice stays up here for its time first, since leaving may load
    // another page (back to the web app), which would take it away unread.
    const saved = await saveNow((x) => (x.seen = [...new Set([...(x.seen ?? []), 'onboarding'])])).then(
      () => true,
      (err) => (toast(t('Not saved. {0}', err.message)), false),
    );
    if (!saved) await new Promise((done) => setTimeout(done, TOAST_MS));
    setLeaving(true);
    setTimeout(
      () => {
        window.scrollTo({ top: 0 });
        onDone();
      },
      reducedMotion() ? 0 : 240,
    );
  };

  const go = (to, d) => {
    if (reducedMotion()) return setStep({ n: to, dir: d, out: null });
    setStep((s) => ({ ...s, out: d > 0 ? 'fwd' : 'back' }));
    setTimeout(() => setStep({ n: to, dir: d, out: null }), 160);
  };

  const nav = {
    next: async (work) => {
      if (work) await work();
      if (n + 1 >= STEPS.length) return finish();
      go(n + 1, 1);
    },
    back: n > 0 ? () => go(n - 1, -1) : null,
  };

  // Focus follows the step, for keyboards and screen readers.
  useEffect(() => {
    card.current?.querySelector('h1')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [n]);

  const Step = STEPS[n];
  const cls = out ? `ob-card ob-out-${out}` : `ob-card ob-in-${dir > 0 ? 'fwd' : 'back'}`;
  return html`
    <section class=${leaving ? 'onboard leaving' : 'onboard'} aria-live="polite">
      <div class="ob-top">
        <span class="ob-count">${n ? t('Step {0} of {1}', n, STEPS.length - 1) : t('Welcome')}</span>
        <button type="button" class="link-btn" onClick=${finish}>${t('Skip setup')}</button>
      </div>
      <${StepLine} n=${n} />
      <div
        class=${cls}
        key=${n}
        ref=${card}
        onAnimationEnd=${(e) => !out && e.currentTarget.classList.remove('ob-in-fwd', 'ob-in-back')}
      >
        <${Step} nav=${nav} />
      </div>
    </section>
  `;
}

/** Each step after the welcome, by its stop on the line. */
const STOPS = () => [t('Classes'), t('Your stop'), t('Pace'), t('Apps')];

/**
 * Where setup is, as a route: a stop per step, the line filled in the accent
 * up to this one, the stops passed filled, this one ringed.
 */
function StepLine({ n }) {
  const stops = STOPS();
  return html`
    <ol class="ob-line" style=${{ '--done': Math.max(0, n - 1) / (stops.length - 1) }} aria-label=${n ? t('Step {0} of {1}', n, stops.length) : t('Setup progress')}>
      ${stops.map((label, i) => html`<li key=${i} class=${i + 1 < n ? 'passed' : i + 1 === n ? 'here' : ''} aria-current=${i + 1 === n ? 'step' : undefined}><span class="ob-stop"></span>${label}</li>`)}
    </ol>
  `;
}

function Heading({ text, sub }) {
  return html`<h1 tabindex="-1">${text}</h1>${sub && html`<p class="ob-sub">${sub}</p>`}`;
}

/** Back, then a skip link if any, then the main button, which shows any error from `onNext` as a toast. */
function Actions({ nav, next = t('Continue'), skip, onNext }) {
  const [busy, setBusy] = useState(false);
  return html`
    <div class="ob-actions">
      ${nav.back && html`<button type="button" class="btn ghost" onClick=${nav.back}>${t('Back')}</button>`}
      <span class="ob-grow"></span>
      ${skip && html`<button type="button" class="link-btn" onClick=${() => nav.next()}>${skip}</button>`}
      <button
        type="button"
        class="btn accent"
        disabled=${busy}
        onClick=${async () => {
          setBusy(true);
          try {
            await nav.next(onNext);
          } catch (err) {
            setBusy(false);
            toast(err.message);
          }
        }}
      >${next}</button>
    </div>
  `;
}

function Welcome({ nav }) {
  // Untouched, times follow the browser; a pick is the account's, on every device.
  const [clock, setClock] = useState(null);
  const shown = clock ?? (browserHour12() ? '12' : '24');
  return html`
    <img class="ob-mark" src="/assets/mark.svg" alt="" />
    <${Heading} text=${t('Welcome to terminus')} sub=${t('It tells you when to leave for class, and which bus to catch. Setting up takes about a minute.')} />
    <ul class="ob-list">
      <li>${t('Your timetable, so it knows where you are going')}</li>
      <li>${t('Where your day starts')}</li>
      <li>${t('How fast you walk')}</li>
    </ul>
    <fieldset class="theme-choice ob-clock">
      <legend>${t('Show times as')}</legend>
      ${CLOCKS().map(
        (c) => html`
          <label class="check" key=${c.value}>
            <input type="radio" name="ob-clock" value=${c.value} checked=${shown === c.value} onChange=${() => setClock(c.value)} />
            ${' '}${t('{0} ({1})', c.label, c.eg)}
          </label>
        `,
      )}
    </fieldset>
    <${Actions} nav=${nav} next=${t('Get started')} onNext=${clock ? () => saveNow((x) => (x.clock = clock)) : undefined} />
  `;
}

function TimetableStep({ nav }) {
  const p = profile.get();
  const [share, setShare] = useState(p.share ?? '');
  const trips = p.trips?.length ?? 0;
  const [imported, setImported] = useState(trips > 0);
  const [msg, setMsg] = useState(trips ? (trips === 1 ? t('1 class already imported.') : t('{0} classes already imported.', trips)) : '');
  const doImport = async () => {
    setMsg(t('Importing…'));
    const r = await api('/me/import', { method: 'POST', body: { share: share.trim() } });
    profile.set(r.profile);
    setImported(true);
    const n = r.profile.trips.length;
    const text = n === 1 ? t('Imported 1 class for {0}.', r.term) : t('Imported {0} classes for {1}.', n, r.term);
    setMsg(text);
    // The next step replaces this one straight away: say it where it stays.
    toast(text);
  };
  return html`
    <${Heading} text=${t('Your timetable')} sub=${t('Paste your NUSMods share link. Each class goes to the stop nearest its room.')} />
    <label for="ob-share">${t('NUSMods share link')}</label>
    <input id="ob-share" type="url" placeholder="https://nusmods.com/timetable/sem-1/share?…" value=${share} onInput=${(e) => setShare(e.currentTarget.value)} />
    <p class="hint">${t('In NUSMods: Timetable, then Share/Sync, then Copy link.')}</p>
    <p class="hint" role="status">${msg}</p>
    <${Actions}
      nav=${nav}
      skip=${t("I'll do this later")}
      onNext=${async () => {
        if (share.trim() && (!imported || share.trim() !== profile.get().share)) {
          try {
            await doImport();
          } catch (err) {
            setMsg(err.message);
            throw err;
          }
        }
      }}
    />
  `;
}

/** How many of the other halls show as tiles before "All of them". */
const SHOWN = 4;

function Home({ nav }) {
  const c = useStore(campus);
  const residences = useMemo(() => residencesByName(c), [c]);
  const current = profile.get().home?.stops ?? [];
  const [stop, setStop] = useState(current[0] ?? '');
  const [walk, setWalk] = useState(String(profile.get().homeWalkMin ?? 5));
  // A residence's stops, when one is chosen; else off campus, or the full list open.
  const [picked, setPicked] = useState(() => residences.find((r) => r.stops[0] === current[0]) ?? null);
  const [mode, setMode] = useState(picked ? 'hall' : current.length ? 'off' : null);
  const [msg, setMsg] = useState('');
  // The walk the account can save (the profile's limits), and how many home stops.
  const range = limit('homeWalkMin', { min: 0, max: 30 });
  const stopsMax = limit('homeStops', 3);
  const pick = (r) => {
    setPicked(r);
    setMode(r ? 'hall' : 'off');
    if (!r) return;
    setStop(r.stops[0]);
    setWalk(String(residenceWalkMin(r)));
    setMsg(t("Stops for {0} added. The app won't direct you home when you're already there.", r.name));
  };
  const locate = () => {
    if (!navigator.geolocation) return setMsg(t('This browser cannot share its location.'));
    setMsg(t('Finding the nearest stop…'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const s = stopsNear(coords.latitude, coords.longitude)[0].s;
        setStop(s.code);
        setMsg(t('Picked {0}. Change it if you use a different stop.', s.name));
      },
      (err) => setMsg(locationError(err)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  // Where most students live, on their own at the top; then a few of the
  // other halls, and the one chosen if it's further down.
  const common = residences.filter((r) => r.common);
  const others = residences.filter((r) => !r.common);
  const tiles = others.slice(0, SHOWN);
  if (picked && !picked.common && !tiles.includes(picked)) tiles.push(picked);
  const tile = (r) => html`<${Tile} key=${r.code} on=${mode === 'hall' && picked === r} onClick=${() => pick(r)}><strong>${r.name}</strong><//>`;
  const yours = mode === 'hall' && picked ? picked.stops : stop ? [stop] : [];
  return html`
    <${Heading} text=${t('Where your day starts')} sub=${t('Where you catch the bus in the morning and head back to at night. Only the stops are saved.')} />
    <div role="radiogroup" aria-label=${t('Where you live')}>
      ${common.length > 0 &&
      html`<p class="eyebrow ob-label">${t('Most common')}</p>
        <div class="ob-tiles ob-common">${common.map(tile)}</div>
        <p class="eyebrow ob-label">${t('Elsewhere')}</p>`}
      <div class=${common.length ? 'ob-tiles ob-rest' : 'ob-tiles'}>
        ${tiles.map(tile)}
        <${Tile} on=${mode === 'more'} onClick=${() => setMode('more')}><strong>${t('All {0} halls and colleges', residences.length)}</strong><//>
        <${Tile} on=${mode === 'off'} onClick=${() => pick(null)}><strong>${t('Off campus')}</strong><span class="hint">${t('Choose your stop')}</span><//>
      </div>
    </div>
    ${mode === 'more' &&
    html`<label for="ob-residence">${t('Where do you live?')}</label>
      <select id="ob-residence" aria-label=${t('Where you live')} value=${picked?.code ?? ''} onChange=${(e) => pick(residences.find((x) => x.code === e.currentTarget.value) ?? null)}>
        <option value="">${t('Choose')}</option>
        <${ResidenceOptions} residences=${residences} />
      </select>`}
    ${mode === 'off' &&
    html`<label for="ob-stop">${t('Home stop')}</label>
      <${StopSelect} id="ob-stop" aria-label=${t('Home stop')} value=${stop} onChange=${setStop} blank=${t('Choose a stop')} />
      <button type="button" class="link-btn locate" onClick=${locate}>${t('Pick the stop nearest me')}</button>`}
    <p class="hint" role="status">${msg}</p>
    ${yours.length > 0 &&
    html`<p class="eyebrow ob-label">${t('Your stops')}</p>
      <div class="ob-signs">${yours.map((code) => html`<${StopSign} code=${code} key=${code} />`)}</div>`}
    <label for="ob-walk">${t('Walk from home to that stop')}</label>
    <div class="row tight">
      <input id="ob-walk" type="number" min=${range.min} max=${range.max} step="1" aria-label=${t('Minutes from home to your stop')} value=${walk} onInput=${(e) => setWalk(e.currentTarget.value)} />
      <span>${t('minutes')}</span>
    </div>
    <p class="hint">${t('Used when the app does not have your location.')}</p>
    <${Actions}
      nav=${nav}
      onNext=${() =>
        saveNow((x) => {
          const v = Number(walk);
          // A residence brings all its stops; otherwise the one chosen here first.
          if (mode === 'hall' && picked) x.home = { stops: [...picked.stops] };
          else if (stop) x.home = { stops: [stop, ...current.filter((code) => code !== stop)].slice(0, stopsMax) };
          if (Number.isInteger(v) && v >= range.min && v <= range.max) x.homeWalkMin = v;
        })}
    />
  `;
}

/** One choice of several, as a tile: outlined, or filled with the accent's soft colour and ticked when chosen. */
const Tile = ({ on, onClick, children }) => html`
  <button type="button" role="radio" aria-checked=${String(on)} class=${on ? 'ob-tile on' : 'ob-tile'} onClick=${onClick}>${children}</button>
`;

/** A stop as its sign: the name on the plate, the services that call there under it, in their colours. */
function StopSign({ code }) {
  const c = useStore(campus);
  const s = c?.stops.find((x) => x.code === code);
  return html`
    <div class="stop-sign">
      <div class="plate"><span class="plate-name">${stopName(code)}</span></div>
      <div class="sign-services">
        ${(s?.services ?? []).map((svc) => {
          const color = c?.routes?.[svc]?.color ?? '#8a939c';
          return html`<span class="svc-tag" key=${svc} style=${`--svc:${color};--svc-ink:${inkOn(color)}`}>${svc}</span>`;
        })}
      </div>
    </div>
  `;
}

function Travel({ nav }) {
  const [pace, setPace] = useState(profile.get().walkPace ?? 'normal');
  const [full, setFull] = useState(profile.get().fullBusMargin !== false);
  return html`
    <${Heading} text=${t('How you get around')} sub=${t('Walks follow the paths on campus. Your pace sets how long they take.')} />
    <${Track} min=${PACES.find((x) => x.value === pace)?.min ?? 5} />
    <p class="hint ob-lap">${t('One lap of a running track is 400 m.')}</p>
    <${PacePicker} value=${pace} onChange=${setPace} />
    <div class="ob-busy">
      <label class="ob-busy-row">
        <span>
          <strong>${t('Allow for busy buses')}</strong>
          <span class="hint">${t('When the bus you would wait for is often full at that stop and time, aim one bus earlier.')}</span>
        </span>
        <input type="checkbox" class="switch" checked=${full} onChange=${(e) => setFull(e.currentTarget.checked)} />
      </label>
      ${full &&
      html`<div class="ob-busy-eg">
        <span class="ob-bus on"><span class="svc-tag" style="--svc:#34a853;--svc-ink:#fff">R2</span>${clock('2026-01-05T09:38:00+08:00')}</span>
        <span class="hint">${t('instead of')}</span>
        <span class="ob-bus off"><span class="svc-tag" style="--svc:#34a853;--svc-ink:#fff">R2</span><s>${`${clock('2026-01-05T09:46:00+08:00')} · ${t('busy')}`}</s></span>
      </div>`}
    </div>
    <${Actions}
      nav=${nav}
      onNext=${() =>
        saveNow((x) => {
          x.walkPace = pace;
          x.fullBusMargin = full;
        })}
    />
  `;
}

/** Where you are on the track: on its lane line, round the far bend. */
const RUNNER = [325 + 67.5 * Math.cos((-50 * Math.PI) / 180), 75 + 67.5 * Math.sin((-50 * Math.PI) / 180)];

/**
 * A running track, from above: the lap's time at your pace in the infield,
 * and you on the far bend. The track's own red, the same in light and dark.
 */
const Track = ({ min }) => html`
  <div class="ob-track">
    <svg viewBox="0 0 400 150" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x="0" y="0" width="400" height="150" rx="75" fill="#b4533a" />
      <rect x="7.5" y="7.5" width="385" height="135" rx="67.5" fill="none" stroke="rgb(255 255 255 / 0.45)" stroke-width="1" />
      <rect x="15" y="15" width="370" height="120" rx="60" class="infield" />
      <line x1="200" y1="0" x2="200" y2="15" stroke="#fff" stroke-width="3" />
      <circle cx=${RUNNER[0]} cy=${RUNNER[1]} r="7.5" fill="#fff" />
      <circle cx=${RUNNER[0]} cy=${RUNNER[1]} r="5" class="you" />
    </svg>
    <div class="ob-track-text"><strong>${t('{0} min', min)}</strong><span>${t('a lap at your pace')}</span></div>
  </div>
`;

/** Three cards, one chosen, moved between with the arrow keys as a radio group is. */
function PacePicker({ value, onChange }) {
  const cards = useRef([]);
  const keys = (e) => {
    const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!k) return;
    e.preventDefault();
    const i = (PACES.findIndex((x) => x.value === value) + k + PACES.length) % PACES.length;
    onChange(PACES[i].value);
    cards.current[i]?.focus();
  };
  return html`
    <div class="ob-paces" role="radiogroup" aria-label=${t('Walking pace')}>
      ${PACES.map(
        (x, i) => html`
          <button
            type="button"
            key=${x.value}
            class=${x.value === value ? 'ob-pace on' : 'ob-pace'}
            role="radio"
            aria-checked=${String(x.value === value)}
            tabindex=${x.value === value ? 0 : -1}
            ref=${(node) => (cards.current[i] = node)}
            onClick=${() => onChange(x.value)}
            onKeyDown=${keys}
          >
            <strong>${x.title}</strong>
            <span class="ob-pace-eg">${t('{0} min a lap', x.min)}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function Apps({ nav }) {
  const app = (href, title, text) => html`<a class="ob-app" href=${href}><strong>${title}</strong><span class="hint">${text}</span></a>`;
  return html`
    <${Heading} text=${t("You're set")} sub=${t('Your widget preview is on the next page. For times on your phone or Mac, get the app and sign in with this email, or pair it from the Devices card with a code.')} />
    <div class="ob-apps">${app('/download/android', 'Android', t('App and home-screen widgets'))}${app('/download/mac', 'Mac', t('Menu bar app, Apple silicon'))}</div>
    <${Actions} nav=${nav} next=${t('Go to my account')} />
  `;
}
