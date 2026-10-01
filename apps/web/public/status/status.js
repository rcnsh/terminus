// The status page: /status.json, rendered in Singapore time.
const $ = (id) => document.getElementById(id);
const TZ = { timeZone: 'Asia/Singapore' };
// The page's language (i18n.js).
const t = (en, ...a) => (window.i18n ? window.i18n.t(en, ...a) : en);
const LOCALE = window.i18n?.lang === 'zh' ? 'zh-CN' : 'en-SG';
const dateTime = (iso) =>
  new Date(iso).toLocaleString(LOCALE, { ...TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const time = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { ...TZ, hour: 'numeric', minute: '2-digit' });

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t('{0} min', m);
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? t('{0} h {1} min', h, m % 60) : t('{0} h', h);
  return t('{0} days', Math.round(h / 24));
}

const CAUSE = {
  version: t('NUS released a new uNivUS version and stopped answering the old one'),
  feed: t("NUS's feed didn't answer"),
};

function render(s) {
  const dot = $('dot');
  dot.className = 'dot';
  if (s.feed === 'up') {
    $('headline').textContent = t('Live bus times are working');
    $('detail').textContent = s.since ? t('Up since {0}.', dateTime(s.since)) : '';
  } else if (s.feed === 'down') {
    dot.classList.add('bad');
    $('headline').textContent = t("NUS's live feed is down");
    $('detail').textContent = t("Since {0}. The apps show timetable estimates until it's back.", dateTime(s.since));
  } else {
    dot.classList.add('off');
    $('headline').textContent = t('No checks yet');
    $('detail').textContent = '';
  }
  if (s.checkedAt) {
    const note = s.checking ? t('Last checked {0}.', time(s.checkedAt)) : t('Checks have stopped; last one {0}.', dateTime(s.checkedAt));
    $('detail').textContent = `${$('detail').textContent} ${note}`.trim();
    if (!s.checking) dot.className = 'dot warn';
  }

  const list = $('incidents');
  list.replaceChildren();
  if (!s.incidents.length) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = t('None recorded.');
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
      right.textContent = t('Ongoing');
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
    $('headline').textContent = t("Couldn't load the status");
    $('detail').textContent = t('Try again in a minute.');
  }
}

load();
setInterval(load, 60_000);
