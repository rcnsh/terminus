/**
 * One-answer front page.
 *
 * Renders `label`, `detail` and `alt` verbatim and computes nothing about the
 * bus itself -- that is the server's job, shared across every client. The page
 * owns only presentation: the clock, the freshness, the import flow, the menu.
 *
 * There is deliberately no stop picker. The destination comes from an imported
 * NUSMods timetable or the time-of-day prior; the origin from GPS or a home
 * stop. Everything the user manages lives in the menu and the import modal.
 */

export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f4f6f8" media="(prefers-color-scheme: light)">
<title>NUS Bus</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg">
<style>
  :root{
    --bg:#0b0d10; --bg2:#0f141a; --card:#12181f; --line:#212a33;
    --fg:#f4f7fa; --dim:#8b98a6; --faint:#5c6773;
    --accent:#ff7a1a; --live:#3fb950; --sched:#e3a008; --bad:#f0603c;
    --shadow:0 20px 60px -20px #000c;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#eef1f5; --bg2:#e7ebf0; --card:#ffffff; --line:#dde3ea;
      --fg:#0b1017; --dim:#5a6672; --faint:#93a0ad; --shadow:0 20px 50px -24px #7a8aa033; }
  }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{margin:0; background:
      radial-gradient(120% 90% at 50% -10%, var(--bg2), var(--bg) 60%);
    color:var(--fg); font:400 16px/1.45 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;
    display:flex; flex-direction:column; min-height:100dvh;
    padding:max(18px,env(safe-area-inset-top)) 20px max(18px,env(safe-area-inset-bottom));
    overscroll-behavior:none; }

  /* header: clock */
  header{display:flex; align-items:baseline; justify-content:space-between; gap:12px}
  .brand{display:flex; align-items:center; gap:9px; color:var(--dim); font-size:13px; font-weight:600; letter-spacing:.02em}
  .brand .glyph{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--accent),#ff9d4d);
    display:grid;place-items:center;color:#111;font-weight:800;font-size:13px}
  .clock{text-align:right; line-height:1.1}
  .clock .t{font-variant-numeric:tabular-nums; font-weight:650; font-size:19px; letter-spacing:.01em}
  .clock .t .s{color:var(--faint); font-size:.7em}
  .clock .d{color:var(--dim); font-size:12px; margin-top:2px}

  /* main answer */
  main{flex:1; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; gap:14px; padding:8px 0}
  .status{display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600;
    color:var(--dim); border:1px solid var(--line); background:var(--card);
    padding:5px 11px 5px 9px; border-radius:999px; letter-spacing:.02em}
  .status .dot{width:8px;height:8px;border-radius:50%; background:var(--faint); box-shadow:0 0 0 0 #0000}
  .live .status .dot{background:var(--live); animation:pulse 2.4s ease-out infinite}
  .scheduled .status .dot{background:var(--sched)}
  .stale .status .dot,.ended .status .dot,.unknown .status .dot{background:var(--bad)}
  @keyframes pulse{0%{box-shadow:0 0 0 0 #3fb95066}70%{box-shadow:0 0 0 7px #3fb95000}100%{box-shadow:0 0 0 0 #3fb95000}}
  #label{font-size:clamp(46px,15vw,88px); font-weight:680; letter-spacing:-.03em; margin:0; line-height:.98}
  .loading #label{opacity:.3; filter:blur(.3px)}
  #detail{color:var(--dim); max-width:32ch; margin:0; font-size:15.5px}
  #alt{color:var(--faint); font-size:13.5px; margin:0}

  /* footer controls */
  footer{display:flex; justify-content:center; gap:10px; position:relative}
  .btn{background:var(--card); color:var(--fg); border:1px solid var(--line); border-radius:999px;
    padding:11px 18px; font:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:transform .06s, background .15s}
  .btn:active{transform:scale(.97)}
  .btn.primary{background:var(--accent); color:#141414; border-color:transparent}
  .btn .ic{margin-right:6px}

  /* dropdown menu */
  .menu{position:relative}
  #menuList{position:absolute; bottom:calc(100% + 10px); right:0; min-width:210px;
    background:var(--card); border:1px solid var(--line); border-radius:14px; padding:6px;
    display:flex; flex-direction:column; gap:2px; box-shadow:var(--shadow); transform-origin:bottom right;
    animation:pop .12s ease-out}
  @keyframes pop{from{opacity:0; transform:scale(.96) translateY(4px)}to{opacity:1;transform:none}}
  #menuList[hidden]{display:none}
  #menuState{font-size:11.5px; color:var(--faint); text-transform:uppercase; letter-spacing:.06em; padding:6px 12px 7px}
  .item{width:100%; text-align:left; border:0; border-radius:10px; padding:11px 12px; color:var(--fg);
    background:transparent; font:inherit; font-size:14.5px; cursor:pointer; display:flex; align-items:center; gap:10px}
  .item:hover,.item:focus-visible{background:color-mix(in srgb,var(--fg) 8%,transparent)}
  .item[disabled]{opacity:.38; cursor:default}
  .item .ic{width:18px; text-align:center; opacity:.85}
  .item.danger{color:var(--bad)}
  #menuList hr{border:0; border-top:1px solid var(--line); margin:4px 6px}

  /* modal */
  .backdrop{position:fixed; inset:0; background:#000a; backdrop-filter:blur(4px);
    display:grid; place-items:center; padding:20px; z-index:20; animation:fade .15s ease-out}
  .backdrop[hidden]{display:none}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .sheet{width:min(460px,100%); background:var(--card); border:1px solid var(--line);
    border-radius:20px; box-shadow:var(--shadow); padding:22px; animation:rise .18s ease-out}
  @keyframes rise{from{opacity:0; transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
  .sheet h2{margin:0 0 4px; font-size:19px; letter-spacing:-.01em}
  .sheet .sub{margin:0 0 16px; color:var(--dim); font-size:13.5px}
  .field{display:flex; flex-direction:column; gap:5px; margin-bottom:12px}
  .field label{font-size:12px; font-weight:600; color:var(--dim); letter-spacing:.02em}
  .field input{padding:12px 13px; font-size:15px; border:1px solid var(--line); border-radius:11px;
    background:var(--bg2); color:var(--fg); width:100%; outline:none}
  .field input:focus{border-color:var(--accent)}
  .sheet .row{display:flex; gap:8px; margin-top:6px}
  .sheet .row .btn{flex:1}
  .note{font-size:12.5px; color:var(--dim); min-height:1.1em; margin:10px 0 0}
  .note.err{color:var(--bad)}

  /* copyable link box */
  .linkbox{margin-top:14px; border:1px solid var(--line); border-radius:12px; background:var(--bg2); overflow:hidden}
  .linkbox .lbl{font-size:11.5px; color:var(--faint); text-transform:uppercase; letter-spacing:.06em; padding:9px 12px 0}
  .linkbox .row{display:flex; align-items:stretch; gap:0}
  .linkbox input{flex:1; border:0; background:transparent; color:var(--fg); font:13px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding:10px 12px; outline:none; text-overflow:ellipsis}
  .linkbox .copy{border:0; border-left:1px solid var(--line); background:transparent; color:var(--accent);
    font:inherit; font-weight:700; font-size:13px; padding:0 16px; cursor:pointer; white-space:nowrap}
  .linkbox .copy:active{background:color-mix(in srgb,var(--accent) 14%,transparent)}
  .hide{display:none !important}
</style>
</head><body class="loading">

<header>
  <div class="brand"><span class="glyph">B</span><span>NUS Bus</span></div>
  <div class="clock"><div class="t" id="clock">--:--</div><div class="d" id="date">Singapore</div></div>
</header>

<main>
  <div class="status"><span class="dot"></span><span id="statusText">Locating…</span></div>
  <p id="label">…</p>
  <p id="detail"></p>
  <p id="alt"></p>
</main>

<footer>
  <button class="btn primary" id="refresh"><span class="ic">↻</span>Refresh</button>
  <div class="menu">
    <button class="btn" id="menuBtn" aria-haspopup="true" aria-expanded="false">Menu ▾</button>
    <div id="menuList" role="menu" hidden>
      <div id="menuState">No timetable</div>
      <button class="item" id="setup" role="menuitem"><span class="ic">＋</span><span id="setupText">Set up timetable</span></button>
      <button class="item" id="copyLink" role="menuitem" disabled><span class="ic">⧉</span>Copy my link</button>
      <button class="item" id="notify" role="menuitem" hidden><span class="ic">◐</span>Morning push</button>
      <hr>
      <button class="item danger" id="clearTt" role="menuitem" disabled><span class="ic">✕</span>Clear timetable</button>
    </div>
  </div>
</footer>

<div class="backdrop" id="modal" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
    <h2 id="sheetTitle">Set up your timetable</h2>
    <p class="sub">Paste your NUSMods share link — in NUSMods, open your timetable, tap Share/Sync, copy the URL. Pick the stop nearest home for morning trips. Nothing is stored: your personal link holds it all.</p>
    <div class="field">
      <label for="share">NUSMods share link</label>
      <input id="share" type="url" inputmode="url" placeholder="https://nusmods.com/timetable/sem-1/share?..." autocomplete="off" spellcheck="false">
    </div>
    <div class="field">
      <label for="home">Home stop code (optional)</label>
      <input id="home" type="text" placeholder="e.g. PGP, KR-MRT, UTOWN" autocomplete="off" autocapitalize="characters">
    </div>
    <div class="row">
      <button class="btn" id="cancel">Cancel</button>
      <button class="btn primary" id="go">Build my link</button>
    </div>
    <p class="note" id="note"></p>
    <div class="linkbox hide" id="linkbox">
      <div class="lbl">Your personal link</div>
      <div class="row">
        <input id="linkOut" readonly>
        <button class="copy" id="linkCopy">Copy</button>
      </div>
    </div>
  </div>
</div>

<script>
var $ = function(id){ return document.getElementById(id); };
var QUALITIES = ['live','scheduled','unknown','stale','ended'];

/* ---- clock (always Singapore time, whatever the device is set to) ---- */
var timeFmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
var dateFmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Singapore',weekday:'short',day:'numeric',month:'short'});
function tick(){
  var parts = timeFmt.format(new Date()).split(':');
  $('clock').innerHTML = parts[0]+':'+parts[1]+'<span class="s">:'+parts[2]+'</span>';
  $('date').textContent = dateFmt.format(new Date())+' · SGT';
}
tick(); setInterval(tick,1000);

/* ---- geolocation (a slightly stale fix is fine) ---- */
function coords(timeoutMs){
  return new Promise(function(resolve){
    if(!navigator.geolocation) return resolve(null);
    var done = setTimeout(function(){ resolve(null); }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      function(p){ clearTimeout(done); resolve(p.coords); },
      function(){ clearTimeout(done); resolve(null); },
      { enableHighAccuracy:false, maximumAge:60000, timeout:timeoutMs });
  });
}

/* ---- the personal timetable lives only in the URL / this device ---- */
function timetable(){
  var fromUrl = new URLSearchParams(location.search).get('tt');
  if(fromUrl){ try{ localStorage.setItem('tt',fromUrl); }catch(e){} return fromUrl; }
  try{ return localStorage.getItem('tt'); }catch(e){ return null; }
}
function personalLink(){ var tt=timetable(); return tt ? location.origin+'/?tt='+tt : null; }

/* ---- render the answer ---- */
function ago(iso){
  var s = Math.max(0, Math.round((Date.now()-new Date(iso).getTime())/1000));
  if(s<60) return s+'s ago'; return Math.round(s/60)+'m ago';
}
async function render(){
  document.body.classList.add('loading');
  $('statusText').textContent = 'Updating…';
  var c = await coords(2500);
  var q = new URLSearchParams({ t:String(Date.now()) });
  if(c){ q.set('lat',String(c.latitude)); q.set('lon',String(c.longitude)); }
  var tt = timetable(); if(tt) q.set('tt',tt);
  try{
    var res = await fetch('/next?'+q,{cache:'no-store'});
    var a = await res.json();
    $('label').textContent = a.label;
    $('detail').textContent = a.detail;
    $('alt').textContent = a.alt || '';
    var pct = a.stop ? Math.round(a.stop.confidence*100)+'%' : '';
    $('statusText').textContent = a.quality + (a.asOf ? ' · '+ago(a.asOf) : '') + (pct?' · '+pct:'');
    document.body.className = QUALITIES.indexOf(a.quality)>=0 ? a.quality : '';
  }catch(err){
    $('label').textContent = 'offline';
    $('detail').textContent = 'Could not reach the bus API';
    $('statusText').textContent = 'error';
    document.body.className = 'ended';
  }
}

/* ---- menu ---- */
function syncMenu(){
  var has = !!timetable();
  $('menuState').textContent = has ? 'Timetable active' : 'No timetable';
  $('setupText').textContent = has ? 'Change timetable' : 'Set up timetable';
  $('copyLink').disabled = !has; $('clearTt').disabled = !has;
}
function toggleMenu(open){
  var list=$('menuList'); var show = open===undefined ? list.hidden : open;
  list.hidden=!show; $('menuBtn').setAttribute('aria-expanded',String(show)); if(show) syncMenu();
}
$('menuBtn').addEventListener('click', function(e){ e.stopPropagation(); toggleMenu(); });
document.addEventListener('click', function(e){ if(!e.target.closest('.menu') && !$('menuList').hidden) toggleMenu(false); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ toggleMenu(false); closeModal(); } });

$('copyLink').addEventListener('click', async function(){
  var link=personalLink(); if(!link) return;
  try{ await navigator.clipboard.writeText(link); flash($('copyLink'),'Copied ✓'); }
  catch(e){ prompt('Copy your personal link:',link); }
  toggleMenu(false);
});
$('clearTt').addEventListener('click', function(){
  try{ localStorage.removeItem('tt'); }catch(e){}
  history.replaceState(null,'',location.pathname);
  toggleMenu(false); render();
});
function flash(el,txt){ var old=el.textContent; el.textContent=txt; setTimeout(function(){ el.textContent=old; },1400); }

/* ---- import modal ---- */
function openModal(){ $('modal').hidden=false; $('note').textContent=''; $('note').className='note';
  $('linkbox').classList.add('hide'); toggleMenu(false); setTimeout(function(){ $('share').focus(); },50); }
function closeModal(){ $('modal').hidden=true; }
$('setup').addEventListener('click', openModal);
$('cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', function(e){ if(e.target===$('modal')) closeModal(); });

$('go').addEventListener('click', async function(){
  var share=$('share').value.trim(); var home=$('home').value.trim();
  var note=$('note');
  if(!share){ note.textContent='Paste your NUSMods share link first.'; note.className='note err'; return; }
  note.textContent='Building your link…'; note.className='note';
  $('go').disabled=true;
  try{
    var u=new URLSearchParams({ share:share }); if(home) u.set('home',home);
    var res=await fetch('/import?'+u); var data=await res.json();
    if(!res.ok){ note.textContent=data.error||'Import failed.'; note.className='note err'; return; }
    try{ localStorage.setItem('tt', data.path.split('tt=')[1]); }catch(e){}
    var extra = data.unresolved && data.unresolved.length ? ' · '+data.unresolved.length+' venue(s) skipped' : '';
    note.textContent = data.classes+' classes imported'+extra+'.'; note.className='note';
    history.replaceState(null,'',data.path);
    // show the copyable link
    $('linkOut').value = location.origin+data.path;
    $('linkbox').classList.remove('hide');
    syncMenu(); render();
  }catch(err){ note.textContent='Import failed: '+err; note.className='note err'; }
  finally{ $('go').disabled=false; }
});
$('linkCopy').addEventListener('click', async function(){
  var v=$('linkOut').value;
  try{ await navigator.clipboard.writeText(v); flash($('linkCopy'),'Copied ✓'); }
  catch(e){ $('linkOut').select(); document.execCommand('copy'); flash($('linkCopy'),'Copied ✓'); }
});

/* ---- lifecycle ---- */
$('refresh').addEventListener('click', render);
document.addEventListener('visibilitychange', function(){ if(!document.hidden) render(); });
setInterval(function(){ if(!document.hidden) render(); }, 30000); // buses move
render();

/* ---- push (only when the server has VAPID) ---- */
(async function(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  var reg = await navigator.serviceWorker.register('/sw.js');
  var res = await fetch('/vapid'); if(!res.ok) return;
  var pk = (await res.json()).publicKey;
  if(await reg.pushManager.getSubscription()) return;
  var btn=$('notify'); btn.hidden=false;
  btn.addEventListener('click', async function(){
    if(await Notification.requestPermission()!=='granted') return;
    var key=Uint8Array.from(atob(pk.replace(/-/g,'+').replace(/_/g,'/')), function(c){ return c.charCodeAt(0); });
    var sub=await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:key });
    await fetch('/subscribe',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({endpoint:sub.endpoint}) });
    btn.textContent='Push on'; btn.disabled=true; toggleMenu(false);
  });
})();
</script>
</body></html>`;
