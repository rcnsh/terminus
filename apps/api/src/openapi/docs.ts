/** The /docs page: Stoplight Elements reading /api/openapi.json, under a bar of the campus sky. */

import { horizonSvg, lightInkAt, skyVars } from '../pagesky.ts';
import { ELEMENTS } from '../http.ts';
import type { Phase } from '../pagesky.ts';

/** How wide the docs bar's hills are, in pixels: wider than any screen. */
const HZ_W = 4000;

/**
 * The docs page at the sky's hour in Singapore (pagesky.ts): its bar is a
 * slim band of that sky with the campus's hills along its foot, as at the
 * top of Settings' pages. Always the light page's sky: Elements is light.
 */
export function docsPage(phase: Phase): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>API · terminus</title>
  <meta name="description" content="The terminus API: NUS shuttle bus arrivals, live buses and the campus map, as ready-to-show answers. Free with an API key.">
  <link rel="canonical" href="https://terminus.run/docs">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script src="${ELEMENTS}/web-components.min.js" integrity="sha384-X5kH2B8aH81JEl8IfSBwwnr8FYcCqMzdxpqjmmlRbhIl7SsQ9Zn0xk+csQmU37zN" crossorigin="anonymous"></script>
  <link rel="stylesheet" href="${ELEMENTS}/styles.min.css" integrity="sha384-NzdOiocfnINlXfuCXi4OpL/xvdbgLiKaLHQ07Z+IwhVaxHqLShn5rVD5OHt/LYgz" crossorigin="anonymous">
  <script src="/assets/docs.js"></script>
  <style>
    /* On a wide screen the page never scrolls; only the docs inside it do,
       beside their menu. */
    html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; }
    body { position: fixed; top: 0; left: 0; right: 0; height: 100%; height: 100dvh; display: flex; flex-direction: column; }
    .bar { flex: none; position: relative; overflow: hidden; box-sizing: border-box; height: 76px; font: 500 14px/1 system-ui, -apple-system, sans-serif; ${skyVars(phase)}; background: linear-gradient(var(--s0), var(--s1) 50%, var(--s2) 86%, var(--s3)); }
    .bar .row { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; height: 48px; padding: 0 16px; }
    .bar a { color: var(--band-ink); text-decoration: none; display: inline-flex; align-items: center; gap: 8px; }
    .bar b { color: ${lightInkAt(phase) ? '#fb923c' : '#9a3412'}; font-weight: inherit; }
    .bar .back { padding: 12px 0; opacity: 0.85; }
    /* The hills at their own size along the bar's foot, behind its links,
       as wide as any screen: a wider bar shows more of them, not bigger. */
    .bar .hz { position: absolute; left: 0; bottom: 0; width: ${HZ_W}px; height: 52px; }
    .hz .far { fill: var(--h-far); } .hz .tree { fill: var(--h-tree); } .hz .city { fill: var(--h-city); } .hz .lit { fill: #fde9c9; } .hz .near { fill: #fff; }
    elements-api { display: block; flex: 1; min-height: 0; }
    /* Below Elements' breakpoint the sidebar becomes a drawer (layout="responsive"). */
    @media (max-width: 767px) {
      /* On a phone the page itself scrolls, as any page does. Only then does
         the browser move its bars out of the way and let the end of the page
         scroll clear of its toolbar: a page that never scrolls, with the
         docs scrolling inside it, left their last lines under Chrome's
         toolbar however it was sized, because the toolbar lies over the
         page rather than shrinking it. */
      html, body { height: auto; overflow: visible; }
      /* Our bar and Elements' (76 + 60 px) stay over the top of the page:
         what Elements scrolls into view, on picking a menu entry, stops
         below them. */
      html { scroll-padding-top: 136px; }
      body { position: static; display: block; height: auto; padding-top: 76px; }
      .bar { position: fixed; top: 0; left: 0; right: 0; z-index: 21; }
      elements-api .sl-overflow-y-auto.sl-flex-1 { overflow: visible; padding-top: 6px; padding-bottom: 0; }
      /* Elements leaves 64 px under the docs, and 40 more under the
         overview, for a box that scrolls inside a tall screen. Here the
         page ends under the reader's thumb: a short gap is enough. */
      elements-api .sl-overflow-y-auto.sl-flex-1 > .sl-py-16 { padding-bottom: 16px; }
      elements-api .sl-overflow-y-auto.sl-flex-1 > .sl-py-16 > .HttpService { margin-bottom: 0; }
      /* Inputs under 16px make iOS Safari zoom in on focus and stay zoomed. */
      elements-api input, elements-api select, elements-api textarea { font-size: 16px !important; }
      /* Elements' fixed mobile bar has no z-index, so sticky schema headings
         (z-index 10) slide over it while scrolling; and no top, so it sat
         wherever the page flow put it. It goes right under our 76px bar. */
      elements-api .TopNav--mosaic { z-index: 20; top: 76px; }
      elements-api .sl-drawer-container > .sl-fixed { z-index: 30; }
      /* The menu is a drawer of its own, fixed and 100vh tall (sl-h-screen),
         which Chrome counts as if its toolbar were hidden. It scrolls inside
         itself, so the toolbar never moves out of its way: room after the
         last entry as tall as the browser's bars (large minus small
         viewport) and the phone's own bar, plus a little, brings every entry
         clear of them. */
      elements-api .sl-drawer { box-sizing: border-box; padding-bottom: 16px; padding-bottom: calc(100lvh - 100svh + env(safe-area-inset-bottom, 0px) + 16px); }
    }
  </style>
</head>
<body>
  <div class="bar">
    <div class="row">
      <a href="/"><img src="/assets/mark.svg" alt="" width="22" height="22"><span>termi<b>nus</b> API</span></a>
      <a class="back" href="/">Back to terminus</a>
    </div>
    ${horizonSvg(phase === 'dusk' || phase === 'night', HZ_W)}
  </div>
  <noscript><p style="padding:16px">The docs need JavaScript. Without it: the spec, every endpoint with examples, is at <a href="/api/openapi.json">/api/openapi.json</a>, and a short guide to the API, in Markdown, is at <a href="/llms.txt">/llms.txt</a>.</p></noscript>
  <elements-api apiDescriptionUrl="/api/openapi.json" router="hash" layout="responsive"></elements-api>
</body>
</html>`;
}

/** The docs page for each of the sky's five phases, built once each. */
const docsMemo = new Map<Phase, string>();

export function docsPageFor(phase: Phase): string {
  let page = docsMemo.get(phase);
  if (page === undefined) docsMemo.set(phase, (page = docsPage(phase)));
  return page;
}
