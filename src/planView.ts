/**
 * Plan tab: an arbitrary trip, not a configured one.
 *
 * The client never resolves a venue or searches upstream itself -- /campus
 * already ships every stop and every known NUSMods venue code pre-resolved
 * to a boardable stop (campus.ts). Once a destination is picked, computing
 * the answer is exactly the existing /trip?to=<stop>&lat&lon call the Now
 * tab's configured trips already use; this tab just reaches it with a
 * destination the user typed instead of one baked into a link.
 */

export const PLAN_STYLE = `
  #plan{gap:14px}
  #planSearchWrap{position:relative}
  #planSearchWrap.hide{display:none}
  #planSearch{width:100%; padding:13px 40px 13px 15px; font-size:16px; border:1px solid var(--line);
    border-radius:14px; background:var(--card); color:var(--fg); outline:none}
  #planSearch:focus{border-color:var(--accent)}
  #planSearchClear{position:absolute; right:6px; top:50%; transform:translateY(-50%); border:0; background:transparent;
    color:var(--faint); padding:8px; cursor:pointer; display:none}
  #planSearchClear svg{width:16px; height:16px; display:block}
  #planSearchClear.show{display:block}
  #planResults{flex:none; max-height:min(46vh,340px); overflow-y:auto; border-radius:14px; display:none}
  #planResults.show{display:block}
  .resultGroup{font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--faint);
    padding:10px 4px 4px}
  .resultRow{width:100%; text-align:left; border:0; background:var(--card); border:1px solid var(--line); border-top-width:0;
    color:var(--fg); font:inherit; font-size:14.5px; padding:11px 13px; cursor:pointer; display:flex; flex-direction:column; gap:1px}
  .resultRow:first-of-type,.resultGroup + .resultRow{border-top-width:1px; border-top-left-radius:12px; border-top-right-radius:12px}
  .resultRow:last-of-type{border-bottom-left-radius:12px; border-bottom-right-radius:12px}
  .resultRow:hover,.resultRow:focus-visible{background:color-mix(in srgb,var(--fg) 6%,var(--card))}
  .resultRow .via{font-size:11.5px; color:var(--faint)}
  #planEmpty{color:var(--faint); font-size:13.5px; text-align:center; padding:14px 0; display:none}
  #planEmpty.show{display:block}

  #planAnswer{flex:1; display:none; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:12px; padding:8px 0}
  #planAnswer.show{display:flex}
  #planAnswer .status{display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600;
    color:var(--dim); border:1px solid var(--line); background:var(--card); padding:5px 11px 5px 9px; border-radius:999px}
  #planAnswer .status .dot{width:8px;height:8px;border-radius:50%; background:var(--faint)}
  #planAnswer.live .status .dot{background:var(--live); animation:pulse 2.4s ease-out infinite}
  #planAnswer.scheduled .status .dot{background:var(--sched)}
  #planAnswer.stale .status .dot,#planAnswer.ended .status .dot,#planAnswer.unknown .status .dot{background:var(--bad)}
  #planDestName{color:var(--faint); font-size:13px; margin:0}
  #planLabel{font-size:clamp(38px,12vw,64px); font-weight:680; letter-spacing:-.03em; margin:0; line-height:1}
  #planDetail{color:var(--dim); max-width:32ch; margin:0; font-size:15px}
  #planAlt{color:var(--faint); font-size:13px; margin:0}
  #planChange{margin-top:4px}
`;

export const PLAN_PANEL = `
<section class="panel" id="plan" hidden>
  <div id="planSearchWrap">
    <input id="planSearch" type="text" inputmode="search" autocomplete="off" spellcheck="false"
      placeholder="Where are you going? Building, landmark or stop…">
    <button id="planSearchClear" aria-label="Clear search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>
  <div id="planResults"></div>
  <p id="planEmpty">No match. Try the exact stop code, or a shorter search.</p>

  <div id="planAnswer">
    <p id="planDestName"></p>
    <div class="status"><span class="dot"></span><span id="planStatusText">—</span></div>
    <p id="planLabel">…</p>
    <p id="planDetail"></p>
    <p id="planAlt"></p>
    <button class="btn" id="planChange">Change destination</button>
  </div>
</section>
`;

export const PLAN_SCRIPT = `
/* ---- Plan tab: search /campus destinations, answer via /trip ---- */
var planState = { destination:null };

function scoreMatch(q, d){
  var label = d.label.toLowerCase(), code = d.code.toLowerCase();
  if(label===q || code===q) return 0;
  if(label.indexOf(q)===0 || code.indexOf(q)===0) return 1;
  if(label.indexOf(q)>=0 || code.indexOf(q)>=0) return 2;
  return -1;
}
var KIND_ORDER = { stop:0, building:1, room:2 };
var KIND_LABEL = { stop:'Stops', building:'Buildings', room:'Rooms & codes' };

function searchDestinations(q){
  if(!campusCache) return [];
  q = q.trim().toLowerCase();
  if(!q) return [];
  var scored = [];
  campusCache.destinations.forEach(function(d){
    var s = scoreMatch(q, d);
    if(s>=0) scored.push([s, d]);
  });
  scored.sort(function(a,b){ return a[0]-b[0] || KIND_ORDER[a[1].kind]-KIND_ORDER[b[1].kind] || a[1].label.length-b[1].label.length; });
  return scored.slice(0,8).map(function(p){ return p[1]; });
}

function renderResults(list, q){
  var box = $('planResults');
  box.innerHTML = '';
  box.classList.toggle('show', q.length>0 && list.length>0);
  $('planEmpty').classList.toggle('show', q.length>0 && list.length===0);
  var lastKind = null;
  list.forEach(function(d){
    if(d.kind!==lastKind){ var h=document.createElement('div'); h.className='resultGroup'; h.textContent=KIND_LABEL[d.kind]; box.appendChild(h); lastKind=d.kind; }
    var row = document.createElement('button'); row.className='resultRow'; row.type='button';
    var main = document.createElement('span'); main.textContent = d.label;
    row.appendChild(main);
    if(d.kind!=='stop'){ var via=document.createElement('span'); via.className='via'; via.textContent='near '+d.stopCode; row.appendChild(via); }
    row.addEventListener('click', function(){ chooseDestination(d.label, d.stopCode); });
    box.appendChild(row);
  });
}

$('planSearch').addEventListener('input', function(){
  var q = this.value;
  $('planSearchClear').classList.toggle('show', q.length>0);
  renderResults(searchDestinations(q), q.trim());
});
$('planSearchClear').addEventListener('click', function(){ $('planSearch').value=''; $('planSearchClear').classList.remove('show'); renderResults([], ''); $('planSearch').focus(); });

async function chooseDestination(label, stopCode){
  planState.destination = { label:label, stopCode:stopCode };
  $('planSearch').value=''; $('planSearchClear').classList.remove('show'); renderResults([], '');
  $('planResults').classList.remove('show'); $('planEmpty').classList.remove('show');
  $('planSearchWrap').classList.add('hide');
  $('planAnswer').classList.add('show');
  $('planDestName').textContent = 'To '+label;
  $('planStatusText').textContent = 'Locating…';
  $('planLabel').textContent = '…'; $('planDetail').textContent=''; $('planAlt').textContent='';
  var c = await coords(2500);
  var q = new URLSearchParams({ to:stopCode, t:String(Date.now()) });
  if(c){ q.set('lat',String(c.latitude)); q.set('lon',String(c.longitude)); }
  try{
    var res = await fetch('/trip?'+q, { cache:'no-store' });
    var a = await res.json();
    $('planLabel').textContent = a.label;
    $('planDetail').textContent = a.detail;
    $('planAlt').textContent = a.alt || '';
    $('planStatusText').textContent = a.quality;
    $('planAnswer').className = QUALITIES.indexOf(a.quality)>=0 ? ('show '+a.quality) : 'show';
  }catch(err){
    $('planLabel').textContent = 'offline';
    $('planDetail').textContent = 'Could not reach the bus API';
    $('planStatusText').textContent = 'error';
  }
}

/** Entry point for the Map tab's "plan a trip from here" cross-link: the
 *  stop is already known, so this skips straight past the search step. */
function planSetDestinationByCode(stopCode){
  var name = stopCode;
  if(campusCache){ var s = campusCache.stops.find(function(x){ return x.code===stopCode; }); if(s) name = s.name; }
  chooseDestination(name, stopCode);
}

$('planChange').addEventListener('click', function(){
  planState.destination = null;
  $('planAnswer').classList.remove('show'); $('planAnswer').className='';
  $('planSearchWrap').classList.remove('hide');
  $('planSearch').focus();
});
`;
