// A stop as its sign, as Nearby shows it: the name plate with the walk there
// and the star, then a row per service read like a stop's board. Shared by
// Nearby on Now (app.js) and the Stops tab's pinned stops (buses.js), so a
// stop reads the same in both.

import { Bar, Icon, Skeleton, html, store, useStore, widthOf } from '/assets/ui.js';
import { PIN_COUNT_KEY, inkOn, t } from '/account/dom.js';
import { togglePin } from '/account/profile.js';
import { NEXT, STAR, colorOf, saidRow, svcVars } from '/app/board.js';

const mins = (s) => Math.round(s / 60);

/** A bus from the side, for a stop's name plate. */
const BUS =
  '<rect x="4.5" y="3" width="15" height="15" rx="3"/><path d="M4.5 11h15M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r="1" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/>';

/** The server's "4 min", "now", "~6 min" for an estimate (never "now": ~1 min), or "–"; worked out here for an older server. */
const etaText = (b) =>
  b.etaS == null
    ? '–'
    : (b.eta ??
      (b.quality === 'scheduled' || b.quality === 'stale'
        ? t('~{0}', t('{0} min', Math.max(1, mins(b.etaS))))
        : b.etaS < 45
          ? t('Arriving')
          : t('{0} min', mins(b.etaS))));

/** Whether any of `stops`' signs shows a "~": only one on the screen needs explaining, and a guessed "now" has none. */
export const anyGuess = (stops) =>
  stops
    .flatMap((s) => s.board.flatMap((b) => [b, ...(b.later ?? []).slice(0, 2)]))
    .some((x) => x.etaS != null && (x.quality === 'scheduled' || x.quality === 'stale') && /\d/.test(etaText(x)));

/**
 * One bus in a sign's column, as on a stop's board: the figures large and
 * the words small. The Next column carries the unit ("4 min"); Then and
 * After only their figures ("16", "~28"), lined up down the column. An
 * estimate is marked "~" in both languages: in a column of figures a word
 * ("约") reads as part of the next. The next bus is the large one. A dash
 * with no bus.
 */
function SignTime({ bus, first }) {
  const approx = bus?.quality === 'scheduled' || bus?.quality === 'stale';
  const cls = `nb-time${first && bus?.etaS != null ? ' pick' : ''}`;
  if (bus?.etaS == null) return html`<span class=${cls} aria-hidden="true">–</span>`;
  const mark = approx ? '~' : '';
  const words = etaText(bus);
  const n = words.match(/\d+/)?.[0];
  // "now": no figure to set large; said as it is.
  if (!n) return html`<span class=${cls} aria-hidden="true">${words}</span>`;
  const unit = first ? words.slice(words.indexOf(n) + n.length) : '';
  return html`<span class=${cls} aria-hidden="true">${mark}${n}${unit ? html`<small>${unit}</small>` : ''}</span>`;
}

/**
 * Where a row's bus is going, as the server words it ("to PGP Foyer", "via
 * UTown"), the place set in ink and the words around it muted; an older
 * server's end of the line otherwise.
 */
function SignDest({ b }) {
  if (!b.dest) {
    const end = b.towards?.at(-1);
    return html`<span class="nb-to" aria-hidden="true">${end ? t('to {0}', end) : (b.toText ?? t('Ends here'))}</span>`;
  }
  const i = b.destPlace ? b.dest.indexOf(b.destPlace) : -1;
  if (i < 0) return html`<span class="nb-to" aria-hidden="true">${b.dest}</span>`;
  return html`<span class="nb-to" aria-hidden="true">${b.dest.slice(0, i)}<b>${b.destPlace}</b>${b.dest.slice(i + b.destPlace.length)}</span>`;
}

/** The sign's column headings, said by each row instead. */
const SignHead = () =>
  html`<div class="nb-head" aria-hidden="true"><span></span><span></span><span>${t('Next')}</span><span>${t('Then')}</span><span>${t('After')}</span></div>`;

/**
 * A sign's rows before its times come: a row per service that calls there
 * (`services`, from the campus data), its badge drawn; without them `n`
 * rows. Where it's going and the times are bars.
 */
const SignRows = ({ services, n = 3 }) =>
  (services?.length ? services : Array.from({ length: n }, () => null)).map(
    (svc, i) => html`
      <div class="nearby-row" key=${svc ?? i}>
        <span class="svc-col">${svc ? html`<span class="svc-tag" style=${svcVars(colorOf(svc))}>${svc}</span>` : html`<span class="svc-tag sk"></span>`}</span>
        <span class="nb-to"><${Bar} w=${widthOf(['72%', '56%', '64%', '48%'], i)} /></span>
        <span class="nb-time pick"><${Bar} w="2.9rem" /></span>
        <span class="nb-time"><${Bar} w="1.3rem" /></span>
        <span class="nb-time"><${Bar} w="1.3rem" /></span>
      </div>
    `,
  );

/**
 * A stop's sign while Nearby looks for the stops around you: the plate's
 * name and the rows as bars. No star or links yet: nothing there to press.
 * Inside a Skeleton, which hides it from screen readers.
 */
export const SignSkeleton = ({ rows = 3 }) => html`
  <section class="stop-sign">
    <header class="plate"><${Icon} paths=${BUS} class="plate-bus" /><span class="plate-name"><${Bar} w="8rem" /></span></header>
    <${SignHead} />
    <${SignRows} n=${rows} />
  </section>
`;

/** The account signed in here (its email), set by app.js: a kept pin count is only believed for it. Null until known. */
export const pinAccount = store(null);

/** The pinned stops' count last kept here for `account`, or null when none is. */
export function keptPinCount(account) {
  if (!account) return null;
  try {
    const kept = JSON.parse(localStorage.getItem(PIN_COUNT_KEY) ?? 'null');
    return kept?.account === account && Number.isInteger(kept.n) && kept.n >= 0 ? kept.n : null;
  } catch {
    return null;
  }
}

/** Keeps `account`'s count of pinned stops, for the shapes the next time the Stops tab opens. */
export function keepPinCount(account, n) {
  if (!account) return;
  try {
    localStorage.setItem(PIN_COUNT_KEY, JSON.stringify({ account, n }));
  } catch {
    // Private mode or storage blocked: the shapes fall back to one sign.
  }
}

/** Nothing pinned yet: where the star is, said once. */
export const NoPins = () =>
  html`<p class="bt-no-pins"><${Icon} paths=${STAR} />${t("Tap the star on any stop to keep it here: in Nearby, on the stop's page, or after searching for it.")}</p>`;

/**
 * The Stops tab's pinned stops before the pins are known, as many as this
 * browser last saw for this account: none, the hint's box with its words
 * as bars (pins may have been added elsewhere since, so the hint waits for
 * them); some, their names' control and one sign, as the pager shows one at
 * a time; not known, one sign. Quiet: the tab says "Checking…" (buses.js).
 */
export function PinnedSkeleton() {
  const n = keptPinCount(useStore(pinAccount));
  return html`
    <${Skeleton} said=${t('Checking…')} quiet>
      ${
        n === 0
          ? html`<p class="bt-no-pins sk-hint"><span class="sk round"></span><span><span class="sk-words">${t("Tap the star on any stop to keep it here: in Nearby, on the stop's page, or after searching for it.")}</span></span></p>`
          : html`${
              n > 0 &&
              html`<div class="segmented full bt-pins">
                ${Array.from({ length: n }, (_, i) => html`<label key=${i}><span><${Bar} w=${widthOf(['4.5rem', '3.5rem', '5rem'], i)} /></span></label>`)}
              </div>`
            }
            <div class="nearby"><${SignSkeleton} /></div>`
      }
    <//>
  `;
}

/**
 * Stop `s` (one stop of /api/me/nearby or /api/me/stops) as its sign. The
 * name opens the stop's board (`onStop(code)`) and a row its service's line
 * (`onLine(svc, code)`), both in the Stops tab; the star pins the stop
 * there, once the pins are known (`pinned`, else null: no star to read
 * wrong, or to unpin with). No walk without one (`walkS` null). `note`, in
 * place of the rows: why there are none. `waiting`: its times are on the
 * way, so its rows are drawn as shapes (`services`, the ones that call
 * there), quiet: the Stops tab says "Checking…" (buses.js).
 */
export function StopSign({ s, pinned, note = null, waiting = false, services = null, onStop, onLine }) {
  const code = s.stop.code;
  const on = pinned?.includes(code) ?? false;
  return html`
    <section class="stop-sign">
      <header class="plate">
        <${Icon} paths=${BUS} class="plate-bus" />
        <button type="button" class="plate-name" onClick=${() => onStop(code)}>${s.stop.name}<${Icon} paths=${NEXT} class="plate-go" /></button>
        ${s.walkS != null && html`<span class="plate-walk">${t('{0} min walk', Math.max(1, mins(s.walkS)))}</span>`}
        ${
          pinned &&
          html`<button
            type="button"
            class=${`plate-star${on ? ' on' : ''}`}
            aria-pressed=${String(on)}
            aria-label=${on ? t('Unpin {0}', s.stop.name) : t('Pin {0}', s.stop.name)}
            onClick=${() => togglePin(code)}
          >
            <${Icon} paths=${STAR} />
          </button>`
        }
      </header>
      ${(waiting || (!note && s.board.length > 0)) && html`<${SignHead} />`}
      ${
        waiting
          ? html`<${Skeleton} said=${t('Checking…')} quiet cls="nb-rows" inner="nb-rows"><${SignRows} services=${services} /><//>`
          : !note && s.board.length
            ? s.board.map((b) => {
                // A public bus has no line page, as on a stop's board.
                const Tag = b.paid ? 'div' : 'button';
                return html`
                <${Tag} type=${b.paid ? undefined : 'button'} class="nearby-row" key=${`${b.svc} ${b.dest ?? b.toText}`} onClick=${b.paid ? undefined : () => onLine(b.svc, code)}>
                  <span class="sr-only">${saidRow(b)}</span>
                  <span class="svc-col" aria-hidden="true"
                    ><span class="svc-tag" style=${b.color ? `--svc:${b.color};--svc-ink:${inkOn(b.color)}` : ''}
                      >${b.svc}${b.paid && html`<span class="fare" role="img" aria-label=${t('Public bus, fare applies')}>$</span>`}</span
                    ></span
                  >
                  <${SignDest} b=${b} />
                  ${[b, b.later?.[0], b.later?.[1]].map((bus, j) => html`<${SignTime} key=${j} bus=${bus} first=${j === 0} />`)}
                <//>
              `;
              })
            : html`<div class="detail">${note ?? (s.available ? t('No buses due') : t('No times right now'))}</div>`
      }
    </section>
  `;
}
