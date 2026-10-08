// Pull to refresh on Now and Buses (app.js): drag the page down from its top
// and its sky stretches. The room above the card's words (a stop's name, a
// line's title) grows with the finger, the sky's colours stretching down to
// the horizon, so nothing opens above the page and there's no edge to see.
// A pill in the sky says what letting go does, and the horizon on screen
// plays it out: a bus in its service's colour drives to your stop as you
// pull, and once it's there, let go and it honks and pulls away while the
// tab fetches again, other services looping past until the answer is back.
// Then the pill says how it went and the sky springs back. The Android app
// does the same, by the same numbers.
//
// While a bus drives here, the horizon's own (the card's bus, one passing)
// is hidden, and it's back where the answer puts it once the sky closes.
//
// Touch only: with a mouse there's the timed refresh, and pulling is never
// the only way to new times. One fetch per pull, of what the tab asks for
// anyway, and none when its times are under PULL_FRESH_MS old (timing.js):
// the API would answer from its cache, so the pill says "Up to date".
//
// The numbers are pure and tested (web-pull.test.js). The drawing moves a
// few SVG nodes over the horizon each frame, only while the sky is pulled.

import { announce, html, reducedMotion, useEffect, useRef } from '/assets/ui.js';
import { t } from '/account/dom.js';
import { BEAM, ROAD_SCALE, WHEELS, arch, busParts, nearY, signX } from '/account/sky.js';

/**
 * In CSS px: how far the sky must stretch for a refresh (`arm`) and where it
 * waits meanwhile (`hold`), the most it stretches, and how much of the pull
 * the header and the chips follow (`lead`).
 */
export const PULL = { arm: 84, hold: 84, max: 170, lead: 0.12 };
/** The shortest a refresh shows for, from letting go: long enough to see the bus leave. */
export const MIN_SHOW_MS = 700;
/** How long the pill says how it went, before the sky closes. */
const RESULT_MS = 1_000;
/** Where a bus comes in from, off the horizon's left edge (its own numbers). */
export const OFF_LEFT = -44;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** The finger's travel to the sky's: it follows less the further it goes, and never past PULL.max. */
export const rubber = (raw) => PULL.max * (1 - Math.exp(-Math.max(0, raw) / 200));

/** Where a bus pulls up at your stop on a horizon `vw` wide: just short of the sign, as the horizon draws it. */
export const stopAt = (vw) => signX(vw) - 44;

/**
 * The bus along the horizon for a pull: from where it was (`from`), easing
 * into the stop as the pull nears `arm`, and never backwards (a bus already
 * past the stop waits there).
 */
export const busAt = (pull, from, vw) => {
  const to = Math.max(from, stopAt(vw));
  return from + (to - from) * (1 - (1 - clamp(pull / PULL.arm)) ** 1.6);
};

/**
 * Where the ground is under `x` on a horizon: Now's road (y 70), or on a
 * low one (Buses, no road) the near hill's top, and how steep it is there
 * (degrees, for a bus 38 long standing on it).
 */
export function groundAt(x, low) {
  if (!low) return { y: 70, tilt: 0 };
  const [a, b] = [nearY(x + 7.5), nearY(x + 26)];
  return { y: Math.max(a, b) - 2, tilt: (Math.atan2(b - a, 18.5) * 180) / Math.PI };
}

/** The words in the pill: pulling, ready to let go, checking, or how it went ('updated', 'fresh', 'failed'). */
export function pullWords(state) {
  switch (state) {
    case 'armed':
      return t('Let go to refresh');
    case 'busy':
      return t('Checking…');
    case 'updated':
      return t('Updated just now');
    case 'fresh':
      return t('Up to date');
    case 'failed':
      return t("Couldn't update");
    default:
      return t('Pull to refresh');
  }
}

/** A spring one step on: position, speed, towards `to`, stiffness `k`, damping `c`. */
const spring = (x, v, to, k, c, dt) => {
  v += (k * (to - x) - c * v) * dt;
  return [x + v * dt, v];
};

/** Something a pull mustn't start on: a field, a dialog, or inside a list scrolled down. */
function blocked(el) {
  if (!(el instanceof Element) || el.closest('input, textarea, select, dialog, [data-no-pull]')) return true;
  for (let n = el; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true;
  return false;
}

/** The first of `sel` in the tab on screen that's on screen too: Buses' home has a page per stop, side by side. */
function onScreen(sel) {
  for (const el of document.querySelectorAll(`#root > main:not([hidden]) ${sel}`)) {
    const r = el.getBoundingClientRect();
    if (r.width && r.left > -r.width / 2 && r.left < window.innerWidth / 2) return el;
  }
  return null;
}

/**
 * The horizon's own bus, if it shows one: where it is along the road and
 * its colour. Else the colour of the first service on the tab (a board's
 * first row, a line), or the accent.
 */
function busOf(horizon) {
  const own = horizon?.querySelector('.coming, .parked');
  const at = own?.getAttribute('transform')?.match(/translate\(\s*(-?[\d.]+)/);
  const colour = (el) => el?.style.getPropertyValue('--svc').trim();
  return {
    from: at ? Number(at[1]) : OFF_LEFT,
    colour: colour(own) || colour(onScreen('[style*="--svc"]')) || 'var(--accent-bright)',
  };
}

/**
 * The sky's stretch, the pill and the bus on the horizon. `enabled()`: the
 * tab on screen can be pulled. `refresh()`: fetches it again, resolving to
 * how it went ('updated', 'fresh' or 'failed'). `colours()`: the services'
 * colours, for the buses looping past.
 */
export function PullToRefresh({ enabled, refresh, colours }) {
  const root = useRef(null);
  // The latest props, for the listeners set up once.
  const props = useRef(null);
  props.current = { enabled, refresh, colours };

  useEffect(() => {
    const el = root.current;
    const $ = (sel) => el.querySelector(sel);
    const [scene, bus, body, door, honk, sign, post, puffs, hint, words] = ['.pull-scene', '.p-bus', '.p-body', '.p-door', '.p-honk', '.p-sign', '.p-post', '.p-puffs', '.pull-hint', '.pull-hint span'].map($);
    const wheels = [...el.querySelectorAll('.p-wheel')];
    const page = document.body;

    // `page`: idle, drag (following the finger), cancel (springing back
    // unarmed), hold (waiting at PULL.hold), closing. `mode`: what the bus is
    // doing: follow (the pull), board, go (pulling away), loop (others
    // passing), gone.
    const st = { page: 'idle', mode: 'follow', pull: 0, v: 0, x: 0, lastX: 0, busV: 0, smV: 0, smA: 0, tilt: 0, tiltV: 0, kneel: 0, kneelV: 0, wheel: 0, dist: 0 };
    // The horizon on screen, and what's on it: its width in its own numbers, low or not, its own sign, where the bus came from.
    let hz = null;
    let calm = reducedMotion();
    let armed = false;
    let released = 0;
    let modeAt = 0;
    let result = null;
    let shownAt = 0;
    let loop = [];
    let next = 0;
    let smoke = [];
    let smokeIn = 0;
    let frame = 0;
    let last = 0;
    let track = null;
    let said = '';

    const say = (state) => {
      hint.className = `pull-hint is-${state}`;
      const text = pullWords(state);
      if (words.textContent !== text) words.textContent = text;
      // Heard once each: checking, then how it went.
      if (state !== 'pull' && state !== 'armed' && said !== state) {
        said = state;
        announce(text, { again: true });
      }
    };

    const paint = (colour) => bus.style.setProperty('--svc', colour);

    function begin() {
      calm = reducedMotion();
      armed = false;
      result = null;
      said = '';
      const horizon = onScreen('.horizon');
      const w = horizon?.getBoundingClientRect().width ?? window.innerWidth;
      const low = horizon?.classList.contains('low') ?? false;
      const k = low ? 1 : ROAD_SCALE;
      const vw = Math.round(w / k);
      const { from, colour } = busOf(horizon);
      // With less motion, Now's own bus stays where it is and only the sign lights; a horizon without one gets a bus standing at the stop.
      const own = Boolean(horizon?.querySelector('.coming, .parked'));
      hz = { el: horizon, low, k, vw, from, own, signed: Boolean(horizon?.querySelector('.sign')), drive: !calm || !own };
      scene.setAttribute('viewBox', low ? `0 6 ${vw} 52` : `0 0 ${vw} 92`);
      page.classList.toggle('pull-drive', !calm);
      Object.assign(st, { page: 'drag', mode: 'follow', v: 0, busV: 0, tilt: 0, tiltV: 0, kneel: 0, kneelV: 0, smV: 0, smA: 0 });
      st.x = st.lastX = calm ? stopAt(vw) : busAt(st.pull, from, vw);
      paint(colour);
      loop = props.current.colours().filter((c) => c.toLowerCase() !== colour.toLowerCase());
      next = 0;
      smoke = [];
      say('pull');
      run();
    }

    function release() {
      if (st.page !== 'drag') return;
      if (!armed) return void (st.page = 'cancel');
      st.page = 'hold';
      st.mode = 'board';
      armed = false;
      released = modeAt = performance.now();
      say('busy');
      const settle = (r) => (result = r);
      props.current.refresh().then(settle, () => settle('failed'));
    }

    function step(dt, now) {
      const { vw, low, from } = hz;
      const stop = stopAt(vw);
      // The stretch: with the finger while dragging, else springing to where it waits or closed.
      if (st.page !== 'drag') {
        const to = st.page === 'hold' ? PULL.hold : 0;
        if (calm) [st.pull, st.v] = [st.pull + (to - st.pull) * Math.min(1, dt * 14), 0];
        else [st.pull, st.v] = spring(st.pull, st.v, to, st.page === 'closing' ? 240 : 190, st.page === 'closing' ? 31 : 26, dt);
        if (st.page !== 'hold' && st.pull < 0.4 && Math.abs(st.v) < 5) {
          st.pull = 0;
          st.page = 'idle';
        }
      }
      const nowArmed = st.page === 'drag' && st.pull >= PULL.arm;
      if (nowArmed !== armed) {
        armed = nowArmed;
        if (armed) {
          if (!calm) st.kneelV += 14;
          navigator.vibrate?.(8);
        }
        say(armed ? 'armed' : 'pull');
      }
      // The answer's back, and the bus has been seen leaving: say how it went, then close up.
      if (st.page === 'hold' && result && !shownAt && now - released >= MIN_SHOW_MS) {
        shownAt = now;
        say(result);
      }
      if (shownAt && now - shownAt >= RESULT_MS) {
        shownAt = 0;
        st.page = 'closing';
      }
      sign.classList.toggle('on', armed || st.mode === 'board' || (st.page === 'hold' && calm));
      sign.classList.toggle('done', st.page === 'hold' && Boolean(shownAt) && result !== 'failed');

      // The bus.
      let doorOpen = 0;
      let honked = 0;
      const since = now - modeAt;
      if (calm) {
        // Standing at the stop, its door open while it checks.
        st.x = stop;
        doorOpen = st.page === 'hold' ? 1 : 0;
      } else {
        if (st.mode === 'follow') st.x = busAt(st.pull, from, vw);
        else if (st.mode === 'board') {
          st.x = Math.max(from, stop);
          doorOpen = (since > 60 && since < 190) || (since > 300 && since < 430) ? 1 : 0;
          honked = since > 140 && since < 560 ? Math.sin(((since - 140) / 420) * Math.PI) : 0;
          if (since > 620) [st.mode, st.busV] = ['go', 30];
        } else if (st.mode === 'go' || st.mode === 'loop') {
          if (st.mode === 'go') st.busV += 900 * dt;
          st.x += st.busV * dt;
          if (st.x > vw + 20) {
            // Off the right edge: another service comes round while it's still checking.
            if (st.page === 'hold' && !shownAt && loop.length) {
              paint(loop[next++ % loop.length]);
              Object.assign(st, { mode: 'loop', x: OFF_LEFT, lastX: OFF_LEFT, busV: 340 });
            } else st.mode = 'gone';
          }
        }
        // Suspension: the body pitches with its acceleration and settles on a spring; it kneels at the stop.
        const v = (st.x - st.lastX) / Math.max(dt, 1 / 240);
        const a = (v - st.smV) / Math.max(dt, 1 / 240);
        st.lastX = st.x;
        st.smV += (v - st.smV) * 0.35;
        st.smA += (a - st.smA) * 0.2;
        [st.tilt, st.tiltV] = spring(st.tilt, st.tiltV, clamp(-st.smA * 0.0045, -4.5, 4.5), 160, 9, dt);
        [st.kneel, st.kneelV] = spring(st.kneel, st.kneelV, armed || st.mode === 'board' ? 0.55 : 0, 140, 10, dt);
        st.dist += Math.abs(v * dt);
        st.wheel += (v * dt) / 2.2;
        if (st.mode === 'go' || (st.mode === 'loop' && st.x < 30)) {
          smokeIn -= dt;
          if (smokeIn <= 0) {
            smokeIn = 0.07;
            smoke.push({ x: st.x - 1, y: groundAt(st.x, low).y - 4, age: 0 });
          }
        }
      }
      smoke = smoke.filter((f) => (f.age += dt) < 0.6);
      door.style.opacity = doorOpen;
      honk.setAttribute('opacity', honked.toFixed(3));
    }

    function draw() {
      const p = st.pull;
      const { el: horizon, low, vw, own, signed, drive } = hz;
      page.style.setProperty('--stretch', `${Math.round(p)}px`);
      page.style.setProperty('--lead', `${Math.round(p * PULL.lead)}px`);
      page.classList.toggle('pulled', p > 0.5);
      // The scene over the horizon on screen, wherever the stretch has put it.
      const r = horizon?.getBoundingClientRect();
      if (r) Object.assign(scene.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const shown = clamp(p / PULL.arm);
      // Your stop's sign: the horizon's own, drawn over; else it comes in with the pull (out of the hill, on a low one).
      const sx = signX(vw);
      const base = groundAt(sx - 3, low).y + (low ? 3 : 0);
      sign.setAttribute('transform', `translate(${sx} ${base.toFixed(2)})${signed ? '' : ` scale(1 ${(low ? shown : 1).toFixed(3)})`}`);
      sign.style.opacity = signed || low ? 1 : shown.toFixed(3);
      post.setAttribute('y1', low ? 3 : 0);
      // The bus: standing on the road, or on the hill and tilted with it.
      const g = groundAt(st.x, low);
      const bob = calm ? 0 : st.kneel + 0.25 * Math.sin(st.dist / 5) * clamp(Math.abs(st.smV) / 200);
      bus.setAttribute('transform', `translate(${st.x.toFixed(2)} ${(g.y - 13.2).toFixed(2)}) rotate(${g.tilt.toFixed(2)} 19 13)`);
      bus.style.opacity = !drive ? 0 : calm && !own ? shown.toFixed(3) : 1;
      body.setAttribute('transform', `translate(0 ${bob.toFixed(3)}) rotate(${(calm ? 0 : st.tilt).toFixed(3)} 7.5 12)`);
      for (const [i, wh] of wheels.entries()) wh.setAttribute('transform', `translate(${WHEELS[i]} 12) rotate(${((st.wheel * 180) / Math.PI) % 360})`);
      puffs.replaceChildren(
        ...smoke.map((f) => {
          const q = f.age / 0.6;
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('cx', (f.x - q * 10).toFixed(1));
          c.setAttribute('cy', (f.y - q * 5).toFixed(1));
          c.setAttribute('r', (1.4 + q * 3.5).toFixed(2));
          c.setAttribute('opacity', (0.55 * (1 - q)).toFixed(3));
          return c;
        }),
      );
      // The pill, in the middle of the room the stretch opened, once there's room for it.
      const head = onScreen('.sky-head');
      if (head) {
        const hr = head.getBoundingClientRect();
        const room = parseFloat(getComputedStyle(head).paddingTop) || 0;
        hint.style.top = `${Math.round(hr.top + room / 2 - 14)}px`;
      }
      hint.style.opacity = (st.page === 'hold' ? 1 : clamp((p - 30) / 30)).toFixed(3);
    }

    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt, now);
      draw();
      if (st.page === 'idle') {
        frame = 0;
        page.classList.remove('pulled', 'pull-drive');
        page.style.removeProperty('--stretch');
        page.style.removeProperty('--lead');
        return;
      }
      frame = requestAnimationFrame(tick);
    }
    function run() {
      if (frame) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }

    // The gesture: a touch at the top of the page, moving down more than across.
    const onStart = (e) => {
      track = null;
      if (st.page !== 'idle' || e.touches.length !== 1 || window.scrollY > 0 || !props.current.enabled() || blocked(e.target)) return;
      track = { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false };
    };
    const onMove = (e) => {
      if (!track) return;
      const p = e.touches[0];
      if (!track.on) {
        const dx = p.clientX - track.x;
        const dy = p.clientY - track.y;
        // Across (the Buses pages swipe), up, or the page scrolled after all: not a pull.
        if ((Math.abs(dx) > 10 && Math.abs(dx) > dy) || dy < -6 || window.scrollY > 0) return void (track = null);
        if (dy < 10) return;
        track.on = true;
        track.y = p.clientY;
        begin();
      }
      e.preventDefault();
      st.pull = rubber(p.clientY - track.y);
    };
    const onEnd = () => {
      if (track?.on) release();
      track = null;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  return html`
    <div class="pull" ref=${root} aria-hidden="true">
      <svg class="pull-scene">
        <g class="p-sign">
          <circle class="halo" cx="0" cy="-30.5" r="7" />
          <line class="p-post" x1="0" y1="0" x2="0" y2="-26" />
          <rect class="plate" x="-6.5" y="-37" width="13" height="13" rx="2.5" />
          <rect class="mark" x="-3.5" y="-34.5" width="7" height="7.5" rx="1.5" />
          <rect class="glyph" x="-2.5" y="-33.5" width="5" height="3" rx="0.5" />
        </g>
        <g class="p-puffs"></g>
        <g class="p-bus">
          <g class="p-body">
            <path class="beam" d=${BEAM} />
            ${busParts('body', 'band', 3, false)}
            <rect class="p-door" x="32" y="2.5" width="2.8" height="8.2" rx="0.6" />
            ${WHEELS.map((x) => html`<path class="arch" d=${arch(x)} />`)}
          </g>
          ${WHEELS.map(
            (x) => html`<g class="p-wheel" transform=${`translate(${x} 12)`}>
              <circle class="tyre" r="2.2" />
              <circle class="hub" r="0.8" />
              <rect class="spoke" x="-0.22" y="-0.85" width="0.44" height="0.6" />
            </g>`,
          )}
          <g class="p-honk" opacity="0">
            <path d="M40.2 3.2q1.5 2.4 0 4.8" />
            <path d="M42.4 1.6q2.8 4 0 8" />
          </g>
        </g>
      </svg>
      <p class="pull-hint is-pull">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
        <span></span>
      </p>
    </div>
  `;
}
