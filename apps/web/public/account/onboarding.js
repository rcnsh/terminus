// First sign-in setup, one step at a time: the timetable, where the day
// starts, how fast you walk, and the apps. The profile is saved as it goes
// (profile.js), so leaving halfway loses nothing.

import { html, reducedMotion, useEffect, useMemo, useRef, useState, useStore } from '../assets/ui.js';
import { api, t } from './dom.js';
import { campus, profile, residenceWalkMin, residencesByName, saveNow, stopsNear, toast } from './profile.js';
import { StopSelect } from './settings-pages.js';

const PACES = [
  { value: 'slow', title: t('Slow'), hint: t('A relaxed pace, or if you often carry a bag'), min: 6 },
  { value: 'normal', title: t('Normal'), hint: t('An average pace'), min: 5 },
  { value: 'fast', title: t('Fast'), hint: t('A brisk pace'), min: 4 },
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
    await saveNow((x) => (x.seen = [...new Set([...(x.seen ?? []), 'onboarding'])])).catch(() => {});
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
      <${Progress} n=${n} of=${STEPS.length} key=${n} />
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

/** The bar, starting at the previous step's length so it grows into place. Scaled, not resized: a width change would re-lay out the page. */
function Progress({ n, of }) {
  const fill = useRef(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => fill.current && (fill.current.style.transform = `scaleX(${(n + 1) / of})`)));
    return () => cancelAnimationFrame(id);
  }, []);
  return html`
    <div class="ob-progress" role="progressbar" aria-label=${t('Setup progress')} aria-valuemin="1" aria-valuemax=${String(of)} aria-valuenow=${String(n + 1)}>
      <div class="ob-fill" ref=${fill} style=${{ transform: `scaleX(${n / of})` }}></div>
    </div>
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
  return html`
    <img class="ob-mark" src="/assets/mark.svg" alt="" />
    <${Heading} text=${t('Welcome to terminus')} sub=${t('It tells you when to leave for class, not just when the bus comes. Setting up takes about a minute.')} />
    <ul class="ob-list">
      <li>${t('Your timetable, so it knows where you are going')}</li>
      <li>${t('Where your day starts')}</li>
      <li>${t('How fast you walk')}</li>
    </ul>
    <${Actions} nav=${nav} next=${t('Get started')} />
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

function Home({ nav }) {
  const c = useStore(campus);
  const residences = useMemo(() => residencesByName(c), [c]);
  const current = profile.get().home?.stops ?? [];
  const [stop, setStop] = useState(current[0] ?? '');
  const [walk, setWalk] = useState(String(profile.get().homeWalkMin ?? 5));
  // A residence's stops, when one is chosen.
  const [picked, setPicked] = useState(null);
  const [msg, setMsg] = useState('');
  const locate = () => {
    if (!navigator.geolocation) return setMsg(t('This browser cannot share its location.'));
    setMsg(t('Finding the nearest stop…'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const s = stopsNear(coords.latitude, coords.longitude)[0].s;
        setStop(s.code);
        setMsg(t('Picked {0}. Change it if you use a different stop.', s.name));
      },
      (err) => setMsg(t("Couldn't get your location ({0}). Pick your stop instead.", err.message)),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  return html`
    <${Heading} text=${t('Where your day starts')} sub=${t('Where you catch the bus in the morning, and head back to at the end of the day. Only the stops are saved, never where you live.')} />
    <label for="ob-residence">${t('Where do you live?')}</label>
    <select
      id="ob-residence"
      aria-label=${t('Where you live')}
      value=${picked?.code ?? ''}
      onChange=${(e) => {
        const r = residences.find((x) => x.code === e.currentTarget.value) ?? null;
        setPicked(r);
        if (!r) return;
        setStop(r.stops[0]);
        setWalk(String(residenceWalkMin(r)));
        setMsg(t("Stops for {0} added. The app won't direct you home when you're already there.", r.name));
      }}
    >
      <option value="">${t("Off campus, or I'll pick a stop")}</option>
      ${residences.map((r) => html`<option value=${r.code} key=${r.code}>${r.name}</option>`)}
    </select>
    <label for="ob-stop">${t('Home stop')}</label>
    <${StopSelect} id="ob-stop" aria-label=${t('Home stop')} value=${stop} onChange=${setStop} blank=${t('Choose a stop')} />
    <button type="button" class="link-btn locate" onClick=${locate}>${t('Pick the stop nearest me')}</button>
    <p class="hint" role="status">${msg}</p>
    <label for="ob-walk">${t('Walk from home to that stop')}</label>
    <div class="row tight">
      <input id="ob-walk" type="number" min="0" max="30" step="1" aria-label=${t('Minutes from home to your stop')} value=${walk} onInput=${(e) => setWalk(e.currentTarget.value)} />
      <span>${t('minutes')}</span>
    </div>
    <p class="hint">${t('Used when the app does not have your location.')}</p>
    <${Actions}
      nav=${nav}
      onNext=${() =>
        saveNow((x) => {
          const v = Number(walk);
          // A residence brings all its stops; otherwise the one chosen here first.
          if (picked && stop === picked.stops[0]) x.home = { stops: [...picked.stops] };
          else if (stop) x.home = { stops: [stop, ...current.filter((code) => code !== stop)].slice(0, 3) };
          if (Number.isInteger(v) && v >= 0 && v <= 30) x.homeWalkMin = v;
        })}
    />
  `;
}

function Travel({ nav }) {
  const [pace, setPace] = useState(profile.get().walkPace ?? 'normal');
  const [full, setFull] = useState(profile.get().fullBusMargin !== false);
  return html`
    <${Heading} text=${t('How you get around')} sub=${t('Walks follow the real paths on campus. Your pace sets how long they take.')} />
    <${PacePicker} value=${pace} onChange=${setPace} />
    <label class="check ob-check">
      <input type="checkbox" checked=${full} onChange=${(e) => setFull(e.currentTarget.checked)} />
      <span>
        <strong>${t('Allow for packed buses')}</strong>
        <span class="hint">${t('When the bus you would wait for is often full at that stop and time, aim one bus earlier.')}</span>
      </span>
    </label>
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
            <span class="ob-pace-eg">${t('400 m in about {0} min', x.min)}</span>
            <span class="hint">${x.hint}</span>
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
