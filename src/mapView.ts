/**
 * Map tab: the campus as real geography, not a stop picker.
 *
 * Renders every stop at its true relative position (data from /campus, which
 * projects the bundled lat/lon once server-side -- see campus.ts) and every
 * route as a colored line through its own stops. Tapping a stop opens the
 * dock at the bottom with that stop's live board, fetched on demand through
 * /arrivals -- the same per-stop 15s cache /next already uses, so opening
 * the map never costs more than checking the stops you actually tap.
 */

export const MAP_STYLE = `
  #map{gap:10px}
  #mapLegend{display:flex; gap:6px; overflow-x:auto; padding:2px 2px 4px; -webkit-overflow-scrolling:touch}
  #mapLegend::-webkit-scrollbar{display:none}
  #mapOffCore{display:flex; gap:6px; overflow-x:auto; padding:0 2px 2px; -webkit-overflow-scrolling:touch}
  #mapOffCore.hide{display:none}
  #mapOffCore::-webkit-scrollbar{display:none}
  .offChip{flex:none; font-size:12px; font-weight:600; color:var(--dim); background:var(--card);
    border:1px dashed var(--line); border-radius:999px; padding:6px 12px; cursor:pointer}
  .offChip:active{background:color-mix(in srgb,var(--fg) 6%,var(--card))}
  .legendChip{flex:none; display:flex; align-items:center; gap:6px; font-size:12px; font-weight:700;
    color:var(--dim); background:var(--card); border:1px solid var(--line); border-radius:999px; padding:5px 11px 5px 9px}
  .legendChip .sw{width:9px; height:9px; border-radius:50%}
  #mapCanvas{flex:1; min-height:0; border-radius:18px; background:var(--card); border:1px solid var(--line);
    overflow:hidden; position:relative}
  #mapSvg{width:100%; height:100%; display:block; touch-action:manipulation}
  .routeLine{fill:none; stroke-width:5; stroke-linecap:round; stroke-linejoin:round; opacity:.85}
  .stopDot{fill:var(--bg2); stroke:var(--faint); stroke-width:2.5; cursor:pointer; transition:r .12s}
  .stopDot:hover,.stopDot:focus-visible{stroke:var(--fg)}
  .stopDot.picked{fill:var(--accent); stroke:var(--accent)}
  .stopLabel{font-size:9.5px; fill:var(--fg); pointer-events:none; font-weight:700; opacity:0; transition:opacity .12s}
  .stopDot:hover + .stopLabel, .stopDot:focus-visible + .stopLabel, .stopDot.picked + .stopLabel, .stopLabel.show{opacity:1}
  .nearestRing{fill:none; stroke:var(--faint); stroke-width:2.5; opacity:0; transform-origin:center}
  .nearestRing.on{animation:mapPulse 2.4s ease-out infinite}
  @keyframes mapPulse{0%{opacity:.9; r:9px}70%{opacity:0; r:22px}100%{opacity:0; r:22px}}
  /* A tap-triggered, infrequent reveal -- max-height costs a reflow on open/
     close, but a grid-template-rows collapse left a sub-pixel text sliver
     visible when closed (Chrome does not clip an overflow:hidden child's
     line-box to a zero-height grid track as cleanly as to a max-height:0
     block). Correctness wins here over the (real but minor, one-shot)
     layout cost. */
  #mapDock{flex:none; max-height:0; overflow:hidden; background:var(--card); border:1px solid var(--line);
    border-radius:16px; transition:max-height .2s ease-out; box-shadow:var(--shadow)}
  #mapDock.open{max-height:240px}
  #mapDock .inner{padding:14px 16px 16px}
  #mapDock h3{margin:0 0 2px; font-size:16.5px; letter-spacing:-.01em}
  #mapDock .sub{margin:0 0 10px; color:var(--faint); font-size:12px}
  #mapBoard{display:flex; flex-direction:column; gap:6px; max-height:100px; overflow-y:auto}
  .boardRow{display:flex; align-items:center; gap:8px; font-size:14px}
  .boardRow .svc{flex:none; width:34px; height:22px; border-radius:6px; display:grid; place-items:center;
    font-size:11.5px; font-weight:800; color:#fff}
  .boardRow .eta{font-variant-numeric:tabular-nums; font-weight:650}
  .boardRow.live .eta{color:var(--live)}
  .boardRow.scheduled .eta,.boardRow.stale .eta{color:var(--sched)}
  .boardRow.unknown .eta{color:var(--faint); font-weight:500; font-size:12.5px}
  #mapDock .row{display:flex; gap:8px; margin-top:10px}
  #mapDock .row .btn{flex:1; padding:9px 14px; font-size:13.5px}
  #mapHint{color:var(--faint); font-size:12.5px; text-align:center; padding:6px 0}
`;

export const MAP_PANEL = `
<section class="panel" id="map" hidden>
  <div id="mapLegend"></div>
  <div id="mapOffCore" class="hide"></div>
  <div id="mapCanvas">
    <svg id="mapSvg" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Campus stop map"></svg>
    <p id="mapHint" class="hide">Loading campus map…</p>
  </div>
  <div id="mapDock">
    <div class="inner">
      <h3 id="mapDockName">—</h3>
      <p class="sub" id="mapDockSub"></p>
      <div id="mapBoard"></div>
      <div class="row">
        <button class="btn" id="mapDockClose">Close</button>
        <button class="btn primary" id="mapDockPlan">Plan from here</button>
      </div>
    </div>
  </div>
</section>
`;

export const MAP_SCRIPT = `
/* ---- Map tab: draws /campus once, fetches /arrivals per tap ---- */
var mapState = { loaded:false, picked:null, nearestCode:null };

function svgEl(tag, attrs){
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for(var k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function renderLegend(routes){
  var legend = $('mapLegend'); legend.innerHTML='';
  Object.keys(routes).sort().forEach(function(svc){
    var chip = document.createElement('div'); chip.className='legendChip';
    var sw = document.createElement('span'); sw.className='sw'; sw.style.background = routes[svc].color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(svc));
    legend.appendChild(chip);
  });
}

function drawMap(campus){
  var svg = $('mapSvg');
  svg.setAttribute('viewBox', campus.viewBox);
  svg.innerHTML = '';
  var byCode = {}; campus.stops.forEach(function(s){ byCode[s.code]=s; });

  Object.keys(campus.routes).forEach(function(svc){
    var r = campus.routes[svc];
    var seq = r.loop ? r.seq.concat([r.seq[0]]) : r.seq;
    // A route that dips off the dense core (P's excursion to Botanic Gardens
    // MRT) breaks into separate segments here rather than drawing a single
    // straight line across the gap -- that line would look like a real road
    // that does not exist.
    var segment = [];
    function flush(){
      if(segment.length>1) svg.appendChild(svgEl('polyline', { class:'routeLine', points:segment.join(' '), stroke:r.color }));
      segment = [];
    }
    seq.forEach(function(code){
      var s = byCode[code];
      if(s && s.core) segment.push(s.x+','+s.y); else flush();
    });
    flush();
  });

  var offCore = [];
  campus.stops.forEach(function(s){
    if(!s.core){ offCore.push(s); return; }
    var ring = svgEl('circle', { class:'nearestRing', cx:s.x, cy:s.y, r:9, 'data-code':s.code });
    svg.appendChild(ring);
    var dot = svgEl('circle', { class:'stopDot', cx:s.x, cy:s.y, r:6.5, 'data-code':s.code, tabindex:'0', role:'button', 'aria-label':s.name });
    dot.addEventListener('click', function(){ pickStop(s); });
    dot.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); pickStop(s); } });
    svg.appendChild(dot);
    var label = svgEl('text', { class:'stopLabel', x:s.x+9, y:s.y+3 });
    label.textContent = s.name;
    svg.appendChild(label);
  });

  var offBox = $('mapOffCore');
  offBox.innerHTML = '';
  offBox.classList.toggle('hide', offCore.length===0);
  offCore.forEach(function(s){
    var chip = document.createElement('button'); chip.className='offChip'; chip.type='button';
    chip.textContent = 'Off map · '+s.name;
    chip.addEventListener('click', function(){ pickStop(s); });
    offBox.appendChild(chip);
  });
}

function qualityWord(q){ return q==='live'?'live':(q==='scheduled'||q==='stale')?'estimated':'no live times'; }

async function pickStop(s){
  mapState.picked = s.code;
  document.querySelectorAll('#mapSvg .stopDot').forEach(function(d){ d.classList.toggle('picked', d.getAttribute('data-code')===s.code); });
  $('mapDockName').textContent = s.name;
  $('mapDockSub').textContent = 'Loading arrivals…';
  $('mapBoard').innerHTML = '';
  $('mapDock').classList.add('open');
  try{
    var res = await fetch('/arrivals?stop='+encodeURIComponent(s.code), { cache:'no-store' });
    var data = await res.json();
    $('mapDockSub').textContent = data.available===false ? 'Feed unreachable right now' : 'Next departures';
    if(!data.board.length){ $('mapBoard').innerHTML = '<p style="color:var(--faint);font-size:13px;margin:4px 0">No services board here right now.</p>'; }
    data.board.forEach(function(row){
      var el = document.createElement('div'); el.className = 'boardRow '+row.quality;
      var svcTag = document.createElement('span'); svcTag.className='svc'; svcTag.style.background = (campusCache && campusCache.routes[row.svc] ? campusCache.routes[row.svc].color : '#8b98a6'); svcTag.textContent = row.svc;
      var eta = document.createElement('span'); eta.className='eta';
      eta.textContent = row.etaS==null ? qualityWord(row.quality) : mins(row.etaS);
      el.appendChild(svcTag); el.appendChild(eta);
      $('mapBoard').appendChild(el);
    });
  }catch(err){ $('mapDockSub').textContent = 'Could not reach the bus API'; }
}

function mins(seconds){ if(seconds<45) return 'now'; if(seconds<90) return '1 min'; return Math.round(seconds/60)+' min'; }

$('mapDockClose').addEventListener('click', function(){ $('mapDock').classList.remove('open'); mapState.picked=null;
  document.querySelectorAll('#mapSvg .stopDot').forEach(function(d){ d.classList.remove('picked'); }); });
$('mapDockPlan').addEventListener('click', function(){
  if(!mapState.picked) return;
  var code = mapState.picked;
  $('mapDock').classList.remove('open');
  switchTab('plan');
  planSetDestinationByCode(code);
});

async function highlightNearest(){
  if(!campusCache) return;
  var c = await coords(2500);
  if(!c) return;
  // The nearest-stop pulse asks the server rather than re-deriving distance
  // client-side: /next already resolves the same nearest/candidate stop the
  // Now tab uses, so the map agrees with it by construction, not by copying
  // the resolver's logic into a second implementation.
  var QUALITY_STROKE = { live:'var(--live)', scheduled:'var(--sched)', stale:'var(--bad)', ended:'var(--bad)', unknown:'var(--faint)' };
  try{
    var q = new URLSearchParams({ lat:String(c.latitude), lon:String(c.longitude) });
    var res = await fetch('/next?'+q, { cache:'no-store' });
    var a = await res.json();
    if(a.stop && a.stop.code){
      mapState.nearestCode = a.stop.code;
      var ring = document.querySelector('#mapSvg .nearestRing[data-code="'+a.stop.code+'"]');
      if(ring){
        // The pulse is decorative only if its color is real: it reuses the
        // same live/scheduled/stale language as the Now tab's status dot,
        // not a fixed green regardless of what the feed actually said.
        ring.style.stroke = QUALITY_STROKE[a.quality] || QUALITY_STROKE.unknown;
        ring.classList.add('on');
        var label = ring.nextElementSibling && ring.nextElementSibling.nextElementSibling;
        if(label && label.classList.contains('stopLabel')) label.classList.add('show');
      }
    }
  }catch(e){}
}

async function loadMap(){
  if(mapState.loaded) return;
  $('mapHint').classList.remove('hide');
  try{
    var campus = await loadCampus();
    renderLegend(campus.routes);
    drawMap(campus);
    mapState.loaded = true;
    $('mapHint').classList.add('hide');
    highlightNearest();
  }catch(err){ $('mapHint').textContent = 'Could not load the campus map.'; }
}
`;
