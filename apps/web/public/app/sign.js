import { Bar, Icon, Skeleton, html, store, useStore, widthOf } from '/assets/ui.js';
import { PIN_COUNT_KEY, inkOn, t } from '/account/dom.js';
import { togglePin } from '/account/profile.js';
import { NEXT, Row, STAR, colorOf, saidRow, svcVars } from '/app/board.js';

const mins = (s) => Math.round(s / 60);

const BUS =
  '<rect x="4.5" y="3" width="15" height="15" rx="3"/><path d="M4.5 11h15M8 21v-3M16 21v-3"/><circle cx="8.5" cy="14.5" r="1" fill="currentColor"/><circle cx="15.5" cy="14.5" r="1" fill="currentColor"/>';

const etaText = (b) =>
  b.etaS == null
    ? '–'
    : (b.eta ??
      (b.quality === 'scheduled' || b.quality === 'stale'
        ? t('~{0}', t('{0} min', Math.max(1, mins(b.etaS))))
        : b.etaS < 45
          ? t('Arriving')
          : t('{0} min', mins(b.etaS))));

export const anyGuess = (stops) =>
  stops
    .flatMap((s) => s.board.flatMap((b) => [b, ...(b.later ?? []).slice(0, 2)]))
    .some((x) => x.etaS != null && (x.quality === 'scheduled' || x.quality === 'stale') && /\d/.test(etaText(x)));

function SignTime({ bus, first }) {
  const approx = bus?.quality === 'scheduled' || bus?.quality === 'stale';
  const cls = `nb-time${first && bus?.etaS != null ? ' pick' : ''}`;
  if (bus?.etaS == null) return html`<span class=${cls} aria-hidden="true">–</span>`;
  const mark = approx ? '~' : '';
  const words = etaText(bus);
  const n = words.match(/\d+/)?.[0];
  if (!n) return html`<span class=${cls} aria-hidden="true">${words}</span>`;
  const unit = first ? words.slice(words.indexOf(n) + n.length) : '';
  return html`<span class=${cls} aria-hidden="true">${mark}${n}${unit ? html`<small>${unit}</small>` : ''}</span>`;
}

function SignDest({ b }) {
  if (!b.dest) {
    const end = b.towards?.at(-1);
    return html`<span class="nb-to" aria-hidden="true">${end ? t('to {0}', end) : (b.toText ?? t('Ends here'))}</span>`;
  }
  const i = b.destPlace ? b.dest.indexOf(b.destPlace) : -1;
  if (i < 0) return html`<span class="nb-to" aria-hidden="true">${b.dest}</span>`;
  return html`<span class="nb-to" aria-hidden="true">${b.dest.slice(0, i)}<b>${b.destPlace}</b>${b.dest.slice(i + b.destPlace.length)}</span>`;
}

const SignHead = () =>
  html`<div class="nb-head" aria-hidden="true"><span></span><span></span><span>${t('Next')}</span><span>${t('Then')}</span><span>${t('After')}</span></div>`;

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

export const SignSkeleton = ({ rows = 3 }) => html`
  <section class="stop-sign">
    <header class="plate"><${Icon} paths=${BUS} class="plate-bus" /><span class="plate-name"><${Bar} w="8rem" /></span></header>
    <${SignHead} />
    <${SignRows} n=${rows} />
  </section>
`;

export const pinAccount = store(null);

export function keptPinCount(account) {
  if (!account) return null;
  try {
    const kept = JSON.parse(localStorage.getItem(PIN_COUNT_KEY) ?? 'null');
    return kept?.account === account && Number.isInteger(kept.n) && kept.n >= 0 ? kept.n : null;
  } catch {
    return null;
  }
}

export function keepPinCount(account, n) {
  if (!account) return;
  try {
    localStorage.setItem(PIN_COUNT_KEY, JSON.stringify({ account, n }));
  } catch {}
}

export const NoPins = () =>
  html`<p class="bt-no-pins"><${Icon} paths=${STAR} />${t("Tap the star on any stop to keep it here: in Nearby, on the stop's page, or after searching for it.")}</p>`;

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

export function StopSign({ s, pinned, note = null, waiting = false, services = null, onStop, onLine }) {
  const code = s.stop.code;
  const on = pinned?.includes(code) ?? false;
  const running = s.board.filter((b) => b.running !== false);
  const stopped = note || !s.available ? [] : s.board.filter((b) => b.running === false);
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
      ${(waiting || (!note && running.length > 0)) && html`<${SignHead} />`}
      ${
        waiting
          ? html`<${Skeleton} said=${t('Checking…')} quiet cls="nb-rows" inner="nb-rows"><${SignRows} services=${services} /><//>`
          : !note && running.length
            ? running.map((b) => {
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
            : html`<div class="detail">${note ?? (s.available ? t('No buses due') : t('No times right now'))}</div>
                ${stopped.map((r) => html`<${Row} key=${r.svc} r=${r} chevron onPick=${(svc) => onLine(svc, code)} />`)}`
      }
    </section>
  `;
}
