// The status page: /status.json, rendered in Singapore time.
const $ = (id) => document.getElementById(id);
const TZ = { timeZone: 'Asia/Singapore' };
const dateTime = (iso) =>
  new Date(iso).toLocaleString('en-SG', { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString('en-SG', { ...TZ, hour: 'numeric', minute: '2-digit' });

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

const CAUSE = {
  version: 'NUS released a new uNivUS version and stopped answering the old one',
  feed: "NUS's feed didn't answer",
};

function render(s) {
  const dot = $('dot');
  dot.className = 'dot';
  if (s.feed === 'up') {
    $('headline').textContent = 'Live bus times are working';
    $('detail').textContent = s.since ? `Up since ${dateTime(s.since)}.` : '';
  } else if (s.feed === 'down') {
    dot.classList.add('bad');
    $('headline').textContent = "NUS's live feed is down";
    $('detail').textContent = `Since ${dateTime(s.since)}. The apps show timetable estimates until it's back.`;
  } else {
    dot.classList.add('off');
    $('headline').textContent = 'No checks yet';
    $('detail').textContent = '';
  }
  if (s.checkedAt) {
    const note = s.checking ? `Last checked ${time(s.checkedAt)}.` : `Checks have stopped; last one ${dateTime(s.checkedAt)}.`;
    $('detail').textContent = `${$('detail').textContent} ${note}`.trim();
    if (!s.checking) dot.className = 'dot warn';
  }

  const list = $('incidents');
  list.replaceChildren();
  if (!s.incidents.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'None recorded.';
    list.append(li);
    return;
  }
  for (const i of s.incidents) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = dateTime(i.start);
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = CAUSE[i.cause] ?? CAUSE.feed;
    left.append(when, what);
    const right = document.createElement('div');
    if (i.end) {
      right.className = 'how-long';
      right.textContent = duration(Date.parse(i.end) - Date.parse(i.start));
    } else {
      right.className = 'ongoing';
      right.textContent = 'Ongoing';
    }
    li.append(left, right);
    list.append(li);
  }
}

async function load() {
  try {
    const res = await fetch('/status.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
  } catch {
    $('headline').textContent = "Couldn't load the status";
    $('detail').textContent = 'Try again in a minute.';
  }
}

load();
setInterval(load, 60_000);
