// Pull to refresh on Now and Buses (app.js): drag the page down from its top
// and a strip of road opens above it. The bus on screen, in its service's
// colour, drives in to your stop as you pull; let go once it's there and it
// honks and pulls away while the tab fetches again, other services looping
// past until the answer is back. Then the words say how it went and the page
// closes up. The Android app draws the same road, by the same rules.
//
// Touch only: with a mouse there's the timed refresh, and pulling is never
// the only way to new times. One fetch per pull, of what the tab asks for
// anyway, and none when its times are under PULL_FRESH_MS old (timing.js):
// the API would answer from its cache, so the road says "Up to date".
//
// The numbers are pure and tested (web-pull.test.js). The drawing moves a
// few SVG nodes each frame, and only while the road is open.

import { announce, html, reducedMotion, useEffect, useRef, useState } from '/assets/ui.js';
import { t } from '/account/dom.js';
import { BEAM, WHEELS, arch, busParts } from '/account/sky.js';

/**
 * The road's numbers, in CSS px: how tall it is, how far the page must come
 * down for a refresh (`arm`) and where it waits meanwhile (`hold`), the most
 * it comes down, how much bigger than sky.js's numbers the bus is drawn, and
 * the kerb line, down the strip.
 */
export const PULL = { scene: 104, arm: 84, hold: 84, max: 170, scale: 1.5, road: 90 };
/** Where the bus starts, off the left edge. */
const START_X = -66;
/** The shortest a refresh shows for, from letting go: long enough to see the bus leave. */
export const MIN_SHOW_MS = 700;
/** How long the words say how it went, before the page closes up. */
const RESULT_MS = 1_000;

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** The finger's travel to the page's: it follows less the further it goes, and never past PULL.max. */
export const rubber = (raw) => PULL.max * (1 - Math.exp(-Math.max(0, raw) / 200));

/** Where your stop's sign stands on a road `w` px wide, and where the bus pulls up: just short of it, as on the horizon. */
export const signAt = (w) => Math.round(w * 0.75);
export const stopAt = (w) => signAt(w) - 44 * PULL.scale;

/** The bus across the road for a pull: in from off the left, easing into the stop as the pull nears `arm`. */
export const busAt = (pull, w) => START_X + (stopAt(w) - START_X) * (1 - (1 - clamp(pull / PULL.arm)) ** 1.6);

/** The words on the road: pulling, ready to let go, checking, or how it went ('updated', 'fresh', 'failed'). */
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

/** Something a pull mustn't start on: a field, the map, or inside a list scrolled down. */
function blocked(el) {
  if (!(el instanceof Element) || el.closest('input, textarea, select, dialog, [data-no-pull]')) return true;
  for (let n = el; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true;
  return false;
}

/**
 * The colour of the bus on the tab on screen: Now's horizon bus, a line's,
 * or the first service on a board, as the first thing there wearing one.
 */
function shownColour() {
  const el = document.querySelector('#root > main:not([hidden]) [style*="--svc"]');
  return el?.style.getPropertyValue('--svc').trim() || 'var(--accent-bright)';
}

/**
 * The road, fixed above the page. `enabled()`: the tab on screen can be
 * pulled. `refresh()`: fetches it again, resolving to how it went
 * ('updated', 'fresh' or 'failed'). `colours()`: the services' colours, for
 * the buses looping past.
 */
export function PullToRefresh({ enabled, refresh, colours }) {
  const [w, setW] = useState(() => window.innerWidth);
  const root = useRef(null);
  // The latest props, for the listeners set up once.
  const props = useRef(null);
  props.current = { enabled, refresh, colours, w };

  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const el = root.current;
    const $ = (sel) => el.querySelector(sel);
    const [bus, body, door, honk, sign, puffs, hint, words] = ['.p-bus', '.p-body', '.p-door', '.p-honk', '.p-sign', '.p-puffs', '.pull-hint', '.pull-hint span'].map($);
    const wheels = [...el.querySelectorAll('.p-wheel')];
    const page = document.body;

    // `page`: idle, drag (following the finger), cancel (springing back
    // unarmed), hold (waiting at PULL.hold), closing. `mode`: what the bus is
    // doing: follow (the pull), board, go (pulling away), loop (others
    // passing), gone.
    const st = { page: 'idle', mode: 'follow', pull: 0, v: 0, x: START_X, lastX: START_X, smV: 0, smA: 0, tilt: 0, tiltV: 0, kneel: 0, kneelV: 0, wheel: 0, dist: 0, busV: 0 };
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
      Object.assign(st, { page: 'drag', mode: 'follow', v: 0, tilt: 0, tiltV: 0, kneel: 0, kneelV: 0, smV: 0, smA: 0 });
      st.x = st.lastX = busAt(st.pull, props.current.w);
      const first = shownColour();
      paint(first);
      loop = props.current.colours().filter((c) => c.toLowerCase() !== first.toLowerCase());
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
      const { w } = props.current;
      const stop = stopAt(w);
      // The page: with the finger while dragging, else springing to where it waits or home.
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
      sign.classList.toggle('lit', armed || st.mode === 'board' || (st.page === 'hold' && calm));
      sign.classList.toggle('done', st.page === 'hold' && Boolean(shownAt) && result !== 'failed');

      // The bus.
      let doorOpen = 0;
      let honked = 0;
      const since = now - modeAt;
      if (calm) {
        // Parked at the stop, there or not as the road opens; its door open while it checks.
        st.x = stop;
        bus.style.opacity = st.page === 'hold' ? 1 : clamp((st.pull - 10) / (PULL.arm - 10)).toFixed(3);
        doorOpen = st.page === 'hold' ? 1 : 0;
      } else {
        bus.style.opacity = 1;
        if (st.mode === 'follow') st.x = busAt(st.pull, w);
        else if (st.mode === 'board') {
          st.x = stop;
          doorOpen = (since > 60 && since < 190) || (since > 300 && since < 430) ? 1 : 0;
          honked = since > 140 && since < 560 ? Math.sin(((since - 140) / 420) * Math.PI) : 0;
          if (since > 620) [st.mode, st.busV] = ['go', 40];
        } else if (st.mode === 'go' || st.mode === 'loop') {
          if (st.mode === 'go') st.busV += 1150 * dt;
          st.x += st.busV * dt;
          if (st.x > w + 30) {
            // Off the right edge: another service comes round while it's still checking.
            if (st.page === 'hold' && !shownAt && loop.length) {
              paint(loop[next++ % loop.length]);
              Object.assign(st, { mode: 'loop', x: START_X - 10, lastX: START_X - 10, busV: 430 });
            } else st.mode = 'gone';
          }
        }
        // Suspension: the body pitches with its acceleration and settles on a spring; it kneels at the stop.
        const v = (st.x - st.lastX) / Math.max(dt, 1 / 240);
        const a = (v - st.smV) / Math.max(dt, 1 / 240);
        st.lastX = st.x;
        st.smV += (v - st.smV) * 0.35;
        st.smA += (a - st.smA) * 0.2;
        [st.tilt, st.tiltV] = spring(st.tilt, st.tiltV, clamp(-st.smA * 0.0035, -4.5, 4.5), 160, 9, dt);
        [st.kneel, st.kneelV] = spring(st.kneel, st.kneelV, armed || st.mode === 'board' ? 0.55 : 0, 140, 10, dt);
        st.dist += Math.abs(v * dt);
        st.wheel += (v * dt) / (2.2 * PULL.scale);
        if (st.mode === 'go' || (st.mode === 'loop' && st.x < 40)) {
          smokeIn -= dt;
          if (smokeIn <= 0) {
            smokeIn = 0.07;
            smoke.push({ x: st.x - 2, y: PULL.road - 4.2 * PULL.scale, age: 0 });
          }
        }
      }
      smoke = smoke.filter((f) => (f.age += dt) < 0.6);
      door.style.opacity = doorOpen;
      honk.setAttribute('opacity', honked.toFixed(3));
    }

    function draw() {
      const p = st.pull;
      page.style.setProperty('--pull', `${p.toFixed(2)}px`);
      page.classList.toggle('pulled', p > 0.5);
      // The words sit in the sky over the road, once there's room for them.
      hint.style.opacity = (st.page === 'hold' ? 1 : clamp((p - 50) / 26)).toFixed(3);
      const bob = calm ? 0 : st.kneel + 0.25 * Math.sin(st.dist / 5) * clamp(Math.abs(st.smV) / 250);
      bus.setAttribute('transform', `translate(${st.x.toFixed(2)} ${PULL.road - 13.2 * PULL.scale}) scale(${PULL.scale})`);
      body.setAttribute('transform', `translate(0 ${bob.toFixed(3)}) rotate(${(calm ? 0 : st.tilt).toFixed(3)} 7.5 12)`);
      for (const [i, wh] of wheels.entries()) wh.setAttribute('transform', `translate(${WHEELS[i]} 12) rotate(${((st.wheel * 180) / Math.PI) % 360})`);
      puffs.replaceChildren(
        ...smoke.map((f) => {
          const k = f.age / 0.6;
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('cx', (f.x - k * 14).toFixed(1));
          c.setAttribute('cy', (f.y - k * 7).toFixed(1));
          c.setAttribute('r', (2 + k * 5).toFixed(2));
          c.setAttribute('opacity', (0.5 * (1 - k)).toFixed(3));
          return c;
        }),
      );
    }

    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt, now);
      draw();
      if (st.page === 'idle') {
        frame = 0;
        page.classList.remove('pulled');
        page.style.removeProperty('--pull');
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

  const H = PULL.scene;
  const S = PULL.scale;
  const far = (x) => 60 + 5 * Math.sin(x / 41 + 1.2) + 3 * Math.sin(x / 17);
  const near = (x) => 74 + 2.5 * Math.sin(x / 53 + 0.4) + 1.2 * Math.sin(x / 23);
  const ridge = (y) => {
    let d = `M0 ${H}L0 ${y(0).toFixed(1)}`;
    for (let x = 4; x < w + 4; x += 4) d += `L${x} ${y(x).toFixed(1)}`;
    return `${d}L${w} ${H}Z`;
  };
  // A rain tree on the left, as on the horizon, a little bigger.
  const c = 30;
  const g = near(c);
  return html`
    <div class="pull" ref=${root} aria-hidden="true">
      <svg width=${w} height=${H} viewBox=${`0 0 ${w} ${H}`}>
        <path class="p-far" d=${ridge(far)} />
        <g class="p-tree" transform=${`translate(${c} ${g}) scale(1.15) translate(${-c} ${-g})`}>
          <path d=${`M${c - 1.5} ${g + 2}V${g - 7}L${c - 7} ${g - 13}H${c - 4.5}L${c} ${g - 9}L${c + 4.5} ${g - 13}H${c + 7}L${c + 1.5} ${g - 7}V${g + 2}Z`} />
          <ellipse cx=${c} cy=${g - 18} rx="21" ry="5.5" />
          <ellipse cx=${c - 8} cy=${g - 21.5} rx="11" ry="4.5" />
          <ellipse cx=${c + 8} cy=${g - 22} rx="12" ry="4.5" />
        </g>
        <path class="p-ground" d=${ridge(near)} />
        <line class="p-road" x1="0" y1=${PULL.road} x2=${w} y2=${PULL.road} />
        <g class="p-sign" transform=${`translate(${signAt(w)} ${PULL.road}) scale(${S})`}>
          <circle class="halo" cx="0" cy="-30.5" r="7" />
          <line x1="0" y1="0" x2="0" y2="-26" />
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
