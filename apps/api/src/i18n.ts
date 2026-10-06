/**
 * Every word the server writes, in English and Simplified Chinese (phase 10).
 *
 * The language is per request: the profile's `lang` when it isn't "auto",
 * else `?lang=`, else the request's Accept-Language (any zh* is Chinese),
 * else English. It's carried in an AsyncLocalStorage set once at the top of
 * the request, so the formatters call `m()` instead of passing a language
 * through every function. Outside a request (tests, the cron) it's English,
 * and the English output is exactly what it was before this file existed.
 *
 * `zh` is typed from `en`: a message without a translation fails the
 * typecheck. Place and service names (KR MRT, COM3, D2) stay English in both.
 *
 * Glossary: leave 出发, board/catch 搭, get off 下车, stop 车站, bus 巴士,
 * walk 步行, timetable 课表, class 课, favourite 收藏, Today 今天,
 * Nearby 附近, widget 小组件, Settings 设置, sign in 登录, device 设备,
 * busy (a bus) 很挤, crowding 拥挤程度 (low 低, medium 中,
 * high 高), estimate 估计, live 实时, an email address 邮箱 ("添加邮箱"),
 * an email sent 电子邮件. A space between Chinese and Latin letters or digits
 * ("9:41 的 D2"), full-width punctuation in Chinese. The website and the
 * apps follow the same glossary.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type Lang = 'en' | 'zh';
export const LANGS: readonly Lang[] = ['en', 'zh'];
/** What a profile can say: a language, or follow each device. */
export type LangPref = Lang | 'auto';
export const LANG_PREFS: readonly LangPref[] = ['auto', 'en', 'zh'];

const store = new AsyncLocalStorage<{ lang: Lang }>();

/** Runs `fn` with this request's language. */
export function withLang<T>(lang: Lang, fn: () => T): T {
  return store.run({ lang }, fn);
}

/** The current request's language. */
export function lang(): Lang {
  return store.getStore()?.lang ?? 'en';
}

/** The profile chose a language: it wins over the request's for the rest of the request. */
export function useProfileLang(pref: LangPref | undefined): void {
  const s = store.getStore();
  if (s && pref && pref !== 'auto') s.lang = pref;
}

/** "zh-CN,zh;q=0.9,en;q=0.8" -> zh. The first supported language by q, else English. */
export function langFromHeader(header: string | null | undefined): Lang {
  if (!header) return 'en';
  const tags = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const t of tags) {
    if (t.tag === 'zh' || t.tag.startsWith('zh-')) return 'zh';
    if (t.tag === 'en' || t.tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

/**
 * A request's language before the profile is known: ?lang=, then the
 * website's choice (the terminus-lang cookie, for pages the Worker serves
 * itself, like the sign-in link's), then Accept-Language.
 */
export function langOfRequest(req: Request): Lang {
  const q = new URL(req.url).searchParams.get('lang');
  if (q === 'en' || q === 'zh') return q;
  const c = /(?:^|;\s*)terminus-lang=(en|zh)(?:;|$)/.exec(req.headers.get('cookie') ?? '')?.[1];
  if (c === 'en' || c === 'zh') return c;
  return langFromHeader(req.headers.get('accept-language'));
}

type Fn<A extends unknown[]> = (...a: A) => string;

const en = {
  // Durations (format.ts)
  now: 'now',
  oneMin: '1 min',
  nMin: ((n: number) => `${n} min`) as Fn<[number]>,
  /** An estimate: "~5 min", "~9:41". */
  approx: ((s: string) => `~${s}`) as Fn<[string]>,
  noTimes: 'no times',
  staleLabel: ((svc: string, eta: string, ageMin: number) => `${svc} · ${eta} (${ageMin}m)`) as Fn<[string, string, number]>,

  // The answer's detail line (format.ts)
  crossRoad: 'cross the road',
  walkToStop: ((t: string) => `${t} walk`) as Fn<[string]>,
  shortWalk: 'short walk',
  rightHere: 'right here',
  offAt: ((stop: string) => `off at ${stop}`) as Fn<[string]>,
  destStops: ((dest: string, n: number) => `${dest}, ${n} stop${n === 1 ? '' : 's'}`) as Fn<[string, number]>,
  destIn: ((dest: string, t: string) => `${dest} in ~${t}`) as Fn<[string, string]>,
  atDest: ((dest: string) => `at ${dest}`) as Fn<[string]>,
  walkingAll: ((t: string) => `walking ${t}`) as Fn<[string]>,
  crowdLow: 'crowding: low',
  crowdMedium: 'crowding: medium',
  crowdHigh: 'crowding: high',
  directionUnconfirmed: 'direction unconfirmed',
  minOld: ((n: number) => `${n} min old`) as Fn<[number]>,
  estimated: 'estimated',
  /** The headline bus is a public one, with a fare. */
  publicBus: 'public bus',
  liveUnavailable: 'live times unavailable',
  /** "or A1 in 14 min", "or A1 now", "or UTown in 3 min" (the same bus from another stop). */
  orAlt: ((name: string, eta: string, plain: boolean) => `or ${name} ${plain ? eta : `in ${eta}`}`) as Fn<[string, string, boolean]>,

  // Nothing to board, or faster on foot (format.ts)
  noBuses: 'No buses running',
  walkLabel: ((t: string) => `Walk · ${t}`) as Fn<[string]>,
  noBusWalk: ((t: string) => `No bus · walk ${t}`) as Fn<[string]>,
  servicesEnded: 'Services ended for the night',
  isAWalk: ((dest: string | null, t: string) => `${dest ?? 'It'} is a ${t} walk`) as Fn<[string | null, string]>,
  endedWalkTo: ((t: string, dest: string | null) => `Services ended · ${t} walk to ${dest ?? 'there'}`) as Fn<[string, string | null]>,
  busNoLive: ((svc: string) => `${svc} has no live times`) as Fn<[string]>,
  busWouldBe: ((svc: string, t: string) => `${svc} would be ${t}`) as Fn<[string, string]>,
  onFootTo: ((dest: string) => `On foot to ${dest}`) as Fn<[string]>,
  fasterOnFoot: 'Faster on foot',
  fromStop: ((stop: string) => `from ${stop}`) as Fn<[string]>,

  // Clock and lateness (clock.ts)
  am: 'AM',
  pm: 'PM',
  /** "6:36 PM", with a no-break space so a line never ends between the two. */
  clock12: ((hm: string, pm: boolean) => `${hm}\u00a0${pm ? 'PM' : 'AM'}`) as Fn<[string, boolean]>,
  earlyBy: ((n: number) => `${n} min early`) as Fn<[number]>,
  justInTime: 'just in time',
  lateBy: ((n: number) => `~${n} min late`) as Fn<[number]>,

  // The card (card.ts)
  crowdLowCap: 'Crowding: low',
  crowdMediumCap: 'Crowding: medium',
  crowdHighCap: 'Crowding: high',
  qualityScheduled: 'Timetable estimate',
  qualityStale: 'Live times are a few minutes old',
  qualityUnknown: 'No live data',
  feedDown: ((since: string) => `NUS's live bus times have been down since ${since}.`) as Fn<[string]>,
  termSoonTitle: ((term: string, date: string) => `${term} starts ${date}`) as Fn<[string, string]>,
  termSoonBody: 'Import your new timetable from NUSMods, so your plans are right from the first day.',
  estimateNote: 'Estimated from the usual gap between buses. Live times show nearer the time.',
  /** At the stop: "D2 at 9:41". */
  busAt: ((svc: string, t: string) => `${svc} at ${t}`) as Fn<[string, string]>,
  leaveBy: ((t: string) => `Leave by ${t}`) as Fn<[string]>,
  leaveNow: 'Leave now',
  /** After the leave-by: "catch the 9:41 D2 at COM3, off at KR MRT". */
  leaveVia: ((t: string | null, svc: string, stop: string, off: string | null) => `catch the ${t ? `${t} ` : ''}${svc} at ${stop}${off ? `, off at ${off}` : ''}`) as Fn<[string | null, string, string, string | null]>,
  /** The class card: "Catch the 9:41 D2 at COM3". */
  catchBus: ((t: string | null, svc: string, stop: string, off: string | null) => `Catch the ${t ? `${t} ` : ''}${svc} at ${stop}${off ? `, off at ${off}` : ''}`) as Fn<[string | null, string, string, string | null]>,
  walkThere: 'Walk there',
  arrive: ((t: string, slack: string) => `Arrive ${t} · ${slack}`) as Fn<[string, string]>,
  arriveLower: ((t: string, slack: string) => `arrive ${t} · ${slack}`) as Fn<[string, string]>,
  catchLine: ((c: string, t: string, slack: string) => `${c} · arrive ${t}, ${slack}`) as Fn<[string, string, string]>,
  goNow: ((svc: string, t: string, reach: string | null) => `Or go now: ${svc} at ${t}${reach ? ` · arrive ${reach}` : ''}`) as Fn<[string, string, string | null]>,
  detectedRiding: "Looks like you're on the bus",
  detectedMissed: "Looks like you missed it. Here's the next way there.",
  phaseDue: 'Time to get going',
  phaseHeading: 'On your way',
  phaseWaiting: 'At the stop',
  phaseRiding: 'On the bus',
  phaseMissed: "Missed it. Here's the next way there.",
  svcFrom: ((svc: string, stop: string) => `${svc} from ${stop}`) as Fn<[string, string]>,
  walk: 'walk',
  leaveGlance: ((t: string) => `Leave ${t}`) as Fn<[string]>,
  /** "D2 9:41 at COM3". */
  svcAtStop: ((svc: string, t: string | null, stop: string) => `${svc} ${t ? `${t} ` : ''}at ${stop}`) as Fn<[string, string | null, string]>,
  walkThereNow: 'Walk there now',
  walkNow: 'Walk now',
  missedThe: ((t: string) => `Missed the ${t}`) as Fn<[string]>,
  missedIt: 'Missed it',
  missedLine: ((missed: string, next: string, late: string | null) => `${missed} · next ${next}${late ? `, ${late}` : ''}`) as Fn<[string, string, string | null]>,
  onThe: ((svc: string) => `On the ${svc}`) as Fn<[string]>,
  offAtTime: ((stop: string, t: string) => `off at ${stop} ${t}`) as Fn<[string, string]>,
  yourStop: 'your stop',
  offGlance: ((t: string) => `Off ${t}`) as Fn<[string]>,
  fromGlance: ((t: string) => `From ${t}`) as Fn<[string]>,
  doneToday: 'Done today',
  setUp: 'Set up',
  noClasses: 'No classes',
  home: 'Home',
  youreThere: "You're there",
  notGoing: 'Not going',
  notOnCampus: 'Not on campus today',
  backOnCampus: 'Back on campus',
  undoHome: 'Undo: going home',
  undoTo: ((label: string) => `Undo: going to ${label}`) as Fn<[string]>,

  // Rest, the next class, will I make it (profile.ts, calendar.ts)
  dayStarts: ((t: string) => `Day starts ${t}`) as Fn<[string]>,
  doneForToday: 'Done for today',
  timetableFor: ((term: string) => `Your timetable is for ${term} · import this semester's in Settings`) as Fn<[string]>,
  noClassesComing: 'No classes coming up',
  nothingOnTimetable: 'Nothing on your timetable',
  today: 'today',
  tomorrow: 'tomorrow',
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as readonly string[],
  /** "Mon 28 Sep". */
  shortDate: ((dow: number, date: number, month: number) => `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow]} ${date} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month]}`) as Fn<[number, number, number]>,
  nextClass: ((off: string | null, label: string, when: string, t: string) => `${off ? `${off} · ` : ''}Next: ${label}, ${when} ${t}`) as Fn<[string | null, string, string, string]>,
  termSem: ((n: number, ay: string) => `Sem ${n} ${ay}`) as Fn<[number, string]>,
  termSpecial: ((roman: string, ay: string) => `Special Term ${roman} ${ay}`) as Fn<[string, string]>,
  recessWeek: 'Recess week',
  readingWeek: 'Reading week',
  exams: 'Exams',
  vacation: 'Vacation',
  /** A public holiday's name, as in data/calendar.json. */
  holiday: ((name: string) => name) as Fn<[string]>,

  // The planned answer (next.ts, answer.ts)
  youreHome: "You're home",
  noTimetableYet: 'No timetable yet',
  noMoreClassesToday: 'No more classes today',
  noClassesToday: 'No classes today',
  addTimetableHint: 'Add your timetable in Settings. Buses near you are under Nearby.',
  addHomeStop: 'Add a home stop',
  addHomeStopHint: 'Pick where your day starts in Settings, or turn on location',
  lastBus: ((svc: string, stop: string, n: number) => `Last ${svc} from ${stop} in ${n} min`) as Fn<[string, string, number]>,
  it: 'it',
  offAtCap: ((stop: string) => `Off at ${stop}`) as Fn<[string]>,
  arriveAt: ((t: string) => `arrive ${t}`) as Fn<[string]>,
  inClass: ((label: string) => `In ${label}`) as Fn<[string]>,
  atPlace: ((label: string) => `At ${label}`) as Fn<[string]>,
  startsAt: ((label: string, t: string) => `${label} starts ${t}`) as Fn<[string, string]>,
  till: ((t: string) => `till ${t}`) as Fn<[string]>,
  noStartPoint: 'No start point',
  noStartPointHint: 'Send your location, or a stop to start from',
  youreHere: "You're here",
  destIsAt: ((dest: string, stop: string) => `${dest} is at ${stop}`) as Fn<[string, string]>,
  youreAt: ((stop: string) => `You're at ${stop}`) as Fn<[string]>,
  setUpHint: 'Send lat/lon for nearby buses, or ?to= a stop or venue',

  // What terminus has learned (outcomes.ts, leave.ts)
  suggestQuiet: ((label: string, n: number) => `You've skipped ${label} ${n} weeks running. Stop reminders for it?`) as Fn<[string, number]>,
  stopReminders: 'Stop reminders',
  keepThem: 'Keep them',
  suggestEarlier: ((label: string, n: number) => `You've missed the bus to ${label} ${n} times this month. Leave one bus earlier for it?`) as Fn<[string, number]>,
  leaveEarlier: 'Leave earlier',
  noThanks: 'No thanks',
  oneEarlierNote: 'One bus earlier, as you chose for this class',
  oftenBusy: ((svc: string, stop: string) => `${svc} is often busy at ${stop} around then`) as Fn<[string, string]>,
  mayBeFull: ((busy: string) => `${busy}, and may be full`) as Fn<[string]>,
  soOneEarlier: ((busy: string) => `${busy}, so this is one bus earlier`) as Fn<[string]>,

  // Timetable import errors (me.ts, nusmods.ts)
  nusmodsNoAnswer: ((mods: string) => `NUSMods didn't respond for ${mods}. Nothing was changed. Try again in a minute.`) as Fn<[string]>,
  modsNoClasses: ((mods: string, many: boolean, term: string) => `${mods} ${many ? 'have' : 'has'} no classes in ${term}`) as Fn<[string, boolean, string]>,
  linkNoClasses: ((term: string) => `no classes in that link run in ${term}`) as Fn<[string]>,
  nothingImported: ((why: string) => `Nothing imported: ${why}. Your timetable was not changed.`) as Fn<[string]>,
  tooManyModules: ((n: number, max: number) => `that link has ${n} modules; the limit is ${max}`) as Fn<[number, number]>,
  notAModule: ((code: string) => `"${code}" is not a module code`) as Fn<[string]>,
  noteTooLong: ((n: number) => `keep the note under ${n} characters`) as Fn<[number]>,
  tooManyOnce: ((n: number) => `up to ${n} one-off trips at a time`) as Fn<[number]>,
  tooManyKeys: ((n: number) => `you can have ${n} keys; revoke one first`) as Fn<[number]>,
  needsKey: ((site: string) => `this needs an API key: create one at ${site}/account and send it as x-api-key`) as Fn<[string]>,
  signalKinds: ((kinds: string) => `kind is one of ${kinds}`) as Fn<[string]>,

  // Emails (accounts.ts, applogin.ts)
  checkEmail: 'Check your email for a sign-in code.',
  codeSubject: ((code: string) => `Your terminus code: ${code}`) as Fn<[string]>,
  codeIs: ((code: string) => `Your terminus sign-in code is ${code}`) as Fn<[string]>,
  codeIsHtml: 'Your terminus sign-in code is',
  codeTypeWeb: 'Type it on the terminus page where you asked to sign in. It works once and expires in 15 minutes. Never give it to anyone.',
  codeOrLinkText: 'Or sign in with this link instead:',
  codeOrLinkHtml: ((href: string) => `Or <a href="${href}">sign in with this link</a> instead.`) as Fn<[string]>,
  codeWhyWeb: ((site: string) => `You're getting this because someone entered this address at ${site}, the NUS shuttle bus times app. If that wasn't you, you can ignore this email. Nothing happens without the code.`) as Fn<[string]>,
  codeTypeApp: ((device: string) => `Type it in terminus on ${device}. It works once and expires in 15 minutes. Never give it to anyone.`) as Fn<[string]>,
  codeOtherDeviceText: ((device: string) => `Reading this on another device? Open this link instead and choose the number ${device} is showing:`) as Fn<[string]>,
  codeOtherDeviceHtml: ((href: string, device: string) => `Reading this on another device? <a href="${href}">Open this link</a> instead and choose the number ${device} is showing.`) as Fn<[string, string]>,
  codeWhyApp: ((site: string, device: string) => `You're getting this because someone entered this address in the terminus app (${site}, NUS shuttle bus times) on ${device}. If that wasn't you, you can ignore this email. Nothing happens without the code.`) as Fn<[string, string]>,
  aDevice: 'a device',
  singaporeTime: ((when: string) => `${when} Singapore time`) as Fn<[string]>,
  deviceAddedSubject: ((device: string) => `terminus was added to ${device}`) as Fn<[string]>,
  deviceRemovedSubject: ((device: string) => `${device} was removed from terminus`) as Fn<[string]>,
  deviceAddedText: ((device: string, when: string, site: string) => `terminus was added to ${device} on your account, ${when}.\n\nIf that wasn't you, remove it on the account page (${site}/account) or from any of your devices, and sign out everywhere.`) as Fn<[string, string, string]>,
  deviceRemovedText: ((device: string, when: string, site: string) => `${device} was removed from your terminus account, ${when}. It is signed out.\n\nIf that wasn't you, sign in at ${site}/account and sign out everywhere.`) as Fn<[string, string, string]>,

  // Pages the Worker serves itself (me.ts)
  pageLinkExpired: 'Link expired',
  linkExpiredHtml: '<h1>That link has expired</h1><p class="hint">Sign-in links work once, for 15 minutes.</p><a class="btn accent" href="/account">Get a new link</a>',
  pageSignIn: 'Sign in',
  signInTitle: 'Sign in to terminus',
  continueAs: ((who: string) => `Continue as <strong>${who}</strong> on this device. If that isn't your address, or someone sent you this link, close this page. Continuing would sign you in to their account, and anything you add would be theirs.`) as Fn<[string]>,
  signInButton: 'Sign in',
  pageRequestExpired: 'Request expired',
  approveExpiredHtml: '<h1>This request has expired</h1><p class="hint">Sign-in requests work once, for 15 minutes. Start again on your device.</p>',
  pageApprove: 'Approve sign-in',
  approveTitle: ((device: string) => `Sign in terminus on ${device}?`) as Fn<[string]>,
  approveHint: ((when: string, device: string) => `Requested ${when}. Choose the number ${device} is showing.`) as Fn<[string, string]>,
  notMe: "This wasn't me",
  pageApproved: 'Approved',
  approvedHtml: '<h1>Approved</h1><p class="hint">Return to your device. It will be signed in within a few seconds. You can close this page.</p>',
  pageCancelled: 'Cancelled',
  cancelledHtml: ((picked: boolean) => `<h1>Cancelled</h1><p class="hint">${picked ? "That number didn't match the one on your device, so the request was cancelled." : 'The request was cancelled, and nothing was signed in.'} If you were trying to sign in, start again on your device.</p>`) as Fn<[boolean]>,
};

export type Msgs = typeof en;

/** "到 COM3", but "到家" for home. */
const zhTo = (dest: string) => (dest === '家' ? '到家' : `到 ${dest}`);

const zhDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const HOLIDAYS_ZH: Record<string, string> = {
  'Chinese New Year': '农历新年',
  'Christmas Day': '圣诞节',
  Deepavali: '屠妖节',
  'Good Friday': '耶稣受难日',
  'Hari Raya Haji': '哈芝节',
  'Hari Raya Puasa': '开斋节',
  'Labour Day': '劳动节',
  'National Day': '国庆日',
  "New Year's Day": '元旦',
  'Polling Day': '投票日',
  'Vesak Day': '卫塞节',
};

const zh: Msgs = {
  now: '现在',
  oneMin: '1 分钟',
  nMin: (n) => `${n} 分钟`,
  approx: (s) => `约 ${s}`,
  noTimes: '暂无时间',
  staleLabel: (svc, eta, ageMin) => `${svc} · ${eta}（${ageMin} 分钟前）`,

  crossRoad: '过马路',
  walkToStop: (t) => `步行 ${t}`,
  shortWalk: '走几步',
  rightHere: '就在这里',
  offAt: (stop) => `在 ${stop} 下车`,
  destStops: (dest, n) => `${zhTo(dest)}，${n} 站`,
  destIn: (dest, t) => `约 ${t} ${zhTo(dest)}`,
  atDest: (dest) => zhTo(dest),
  walkingAll: (t) => `步行要 ${t}`,
  crowdLow: '拥挤程度：低',
  crowdMedium: '拥挤程度：中',
  crowdHigh: '拥挤程度：高',
  directionUnconfirmed: '方向未确认',
  minOld: (n) => `${n} 分钟前的数据`,
  estimated: '估计',
  publicBus: '公共巴士',
  liveUnavailable: '暂无实时时间',
  orAlt: (name, eta, plain) => (plain ? `或 ${name}，${eta}` : `或 ${name}，${eta}后`),

  noBuses: '没有巴士运行',
  walkLabel: (t) => `步行 · ${t}`,
  noBusWalk: (t) => `无巴士 · 步行 ${t}`,
  servicesEnded: '今晚已停运',
  isAWalk: (dest, t) => (dest ? `${zhTo(dest)} 步行 ${t}` : `步行 ${t}`),
  endedWalkTo: (t, dest) => (dest ? `已停运 · 步行 ${t} ${zhTo(dest)}` : `已停运 · 步行 ${t}`),
  busNoLive: (svc) => `${svc} 暂无实时时间`,
  busWouldBe: (svc, t) => `搭 ${svc} 要 ${t}`,
  onFootTo: (dest) => (dest === '家' ? '步行回家' : `步行去 ${dest}`),
  fasterOnFoot: '走路更快',
  fromStop: (stop) => `从 ${stop} 出发`,

  am: '上午',
  pm: '下午',
  clock12: (hm, pm) => `${pm ? '下午' : '上午'}\u00a0${hm}`,
  earlyBy: (n) => `早到 ${n} 分钟`,
  justInTime: '刚好赶上',
  lateBy: (n) => `约迟到 ${n} 分钟`,

  crowdLowCap: '拥挤程度：低',
  crowdMediumCap: '拥挤程度：中',
  crowdHighCap: '拥挤程度：高',
  qualityScheduled: '按时刻表估计',
  qualityStale: '实时时间已是几分钟前的',
  qualityUnknown: '没有实时数据',
  feedDown: (since) => `NUS 的实时巴士时间自 ${since} 起无法获取。`,
  termSoonTitle: (term, date) => `${term}将于 ${date}开始`,
  termSoonBody: '从 NUSMods 导入新课表，让第一天起的行程安排都准确无误。',
  estimateNote: '根据巴士平常的间隔估计，临近时会显示实时时间。',
  busAt: (svc, t) => `${t} 的 ${svc}`,
  leaveBy: (t) => `${t} 前出发`,
  leaveNow: '现在出发',
  leaveVia: (t, svc, stop, off) => `在 ${stop} 搭${t ? ` ${t} 的` : ''} ${svc}${off ? `，在 ${off} 下车` : ''}`,
  catchBus: (t, svc, stop, off) => `在 ${stop} 搭${t ? ` ${t} 的` : ''} ${svc}${off ? `，在 ${off} 下车` : ''}`,
  walkThere: '走过去',
  arrive: (t, slack) => `${t} 到达 · ${slack}`,
  arriveLower: (t, slack) => `${t} 到达 · ${slack}`,
  catchLine: (c, t, slack) => `${c} · ${t} 到达，${slack}`,
  goNow: (svc, t, reach) => `或现在走：${t} 的 ${svc}${reach ? ` · ${reach} 到达` : ''}`,
  detectedRiding: '看来你已经上车了',
  detectedMissed: '看来你错过了。这是下一种到达方式。',
  phaseDue: '该出发了',
  phaseHeading: '在路上',
  phaseWaiting: '在车站',
  phaseRiding: '在车上',
  phaseMissed: '错过了。这是下一种到达方式。',
  svcFrom: (svc, stop) => `在 ${stop} 搭 ${svc}`,
  walk: '步行',
  leaveGlance: (t) => `${t} 出发`,
  svcAtStop: (svc, t, stop) => `在 ${stop} 搭${t ? ` ${t} 的` : ''} ${svc}`,
  walkThereNow: '现在走过去',
  walkNow: '现在走',
  missedThe: (t) => `错过了 ${t} 那班`,
  missedIt: '错过了',
  missedLine: (missed, next, late) => `${missed} · 下一班 ${next}${late ? `，${late}` : ''}`,
  onThe: (svc) => `在 ${svc} 上`,
  offAtTime: (stop, t) => `${t} 在 ${stop} 下车`,
  yourStop: '你的车站',
  offGlance: (t) => `${t} 下车`,
  fromGlance: (t) => `${t} 起`,
  doneToday: '今天结束',
  setUp: '去设置',
  noClasses: '没有课',
  home: '家',
  youreThere: '已到达',
  notGoing: '不去了',
  notOnCampus: '今天不在学校',
  backOnCampus: '回学校了',
  undoHome: '撤销：回家',
  undoTo: (label) => `撤销：去 ${label}`,

  dayStarts: (t) => `${t} 开始一天`,
  doneForToday: '今天结束了',
  timetableFor: (term) => `你的课表是 ${term} 的 · 请在设置中导入本学期的课表`,
  noClassesComing: '接下来没有课',
  nothingOnTimetable: '课表上没有课',
  today: '今天',
  tomorrow: '明天',
  dayNames: zhDays,
  shortDate: (dow, date, month) => `${month + 1}月${date}日（${zhDays[dow].replace('星期', '周')}）`,
  nextClass: (off, label, when, t) => `${off ? `${off} · ` : ''}下一节：${label}，${when} ${t}`,
  termSem: (n, ay) => `${ay} 第 ${n} 学期`,
  termSpecial: (roman, ay) => `${ay} 特别学期 ${roman}`,
  recessWeek: '休息周',
  readingWeek: '温书周',
  exams: '考试期间',
  vacation: '假期',
  holiday: (name) => {
    const observed = name.endsWith(' (Observed)');
    const base = observed ? name.slice(0, -' (Observed)'.length) : name;
    const zhName = HOLIDAYS_ZH[base] ?? base;
    return observed ? `${zhName}（补假）` : zhName;
  },

  youreHome: '你已到家',
  noTimetableYet: '还没有课表',
  noMoreClassesToday: '今天没有更多课了',
  noClassesToday: '今天没有课',
  addTimetableHint: '在设置里添加课表。附近的巴士在“附近”里。',
  addHomeStop: '添加家附近的车站',
  addHomeStopHint: '在设置里选择一天从哪里出发，或打开定位',
  lastBus: (svc, stop, n) => `${stop} 的末班 ${svc} 还有 ${n} 分钟`,
  it: '那里',
  offAtCap: (stop) => `在 ${stop} 下车`,
  arriveAt: (t) => `${t} 到达`,
  inClass: (label) => `正在上 ${label}`,
  atPlace: (label) => `在 ${label}`,
  startsAt: (label, t) => `${label} ${t} 开始`,
  till: (t) => `到 ${t}`,
  noStartPoint: '没有出发点',
  noStartPointHint: '发送你的位置，或选一个出发的车站',
  youreHere: '你已经在这里',
  destIsAt: (dest, stop) => `${dest} 在 ${stop}`,
  youreAt: (stop) => `你在 ${stop}`,
  setUpHint: '发送 lat/lon 查看附近的巴士，或用 ?to= 指定车站或地点',

  suggestQuiet: (label, n) => `你已经连续 ${n} 周没去 ${label}。要停止提醒吗？`,
  stopReminders: '停止提醒',
  keepThem: '继续提醒',
  suggestEarlier: (label, n) => `这个月你有 ${n} 次没赶上去 ${label} 的巴士。以后提早一班出发吗？`,
  leaveEarlier: '提早出发',
  noThanks: '不用了',
  oneEarlierNote: '按你为这节课的选择，提早一班',
  oftenBusy: (svc, stop) => `那个时间 ${stop} 的 ${svc} 经常很挤`,
  mayBeFull: (busy) => `${busy}，可能会满`,
  soOneEarlier: (busy) => `${busy}，所以提早一班`,

  nusmodsNoAnswer: (mods) => `NUSMods 没有回应 ${mods}。没有做任何改动，请一分钟后再试。`,
  modsNoClasses: (mods, _many, term) => `${mods} 在 ${term} 没有课`,
  linkNoClasses: (term) => `这个链接里没有在 ${term} 上的课`,
  nothingImported: (why) => `没有导入：${why}。你的课表没有改动。`,
  tooManyModules: (n, max) => `这个链接有 ${n} 个模块，最多 ${max} 个`,
  notAModule: (code) => `“${code}”不是模块代码`,
  noteTooLong: (n) => `说明请少于 ${n} 个字符`,
  tooManyOnce: (n) => `一次最多 ${n} 个单次行程`,
  tooManyKeys: (n) => `最多只能有 ${n} 个密钥，请先撤销一个`,
  needsKey: (site) => `这需要 API 密钥：在 ${site}/account 创建，并以 x-api-key 发送`,
  signalKinds: (kinds) => `kind 必须是以下之一：${kinds}`,

  checkEmail: '请查看邮箱里的登录验证码。',
  codeSubject: (code) => `你的 terminus 验证码：${code}`,
  codeIs: (code) => `你的 terminus 登录验证码是 ${code}`,
  codeIsHtml: '你的 terminus 登录验证码是',
  codeTypeWeb: '请在你要求登录的 terminus 页面输入它。验证码只能用一次，15 分钟后失效。不要告诉任何人。',
  codeOrLinkText: '也可以用这个链接登录：',
  codeOrLinkHtml: (href) => `也可以<a href="${href}">用这个链接登录</a>。`,
  codeWhyWeb: (site) => `你收到这封邮件，是因为有人在 ${site}（NUS 校园巴士时间应用）输入了这个地址。如果不是你，可以忽略这封邮件。没有验证码不会发生任何事。`,
  codeTypeApp: (device) => `请在 ${device} 上的 terminus 输入它。验证码只能用一次，15 分钟后失效。不要告诉任何人。`,
  codeOtherDeviceText: (device) => `在另一台设备上看这封邮件？打开这个链接，然后选择 ${device} 上显示的数字：`,
  codeOtherDeviceHtml: (href, device) => `在另一台设备上看这封邮件？<a href="${href}">打开这个链接</a>，然后选择 ${device} 上显示的数字。`,
  codeWhyApp: (site, device) => `你收到这封邮件，是因为有人在 ${device} 上的 terminus 应用（${site}，NUS 校园巴士时间）输入了这个地址。如果不是你，可以忽略这封邮件。没有验证码不会发生任何事。`,
  aDevice: '一台设备',
  singaporeTime: (when) => `新加坡时间 ${when}`,
  deviceAddedSubject: (device) => `terminus 已添加到 ${device}`,
  deviceRemovedSubject: (device) => `${device} 已从 terminus 移除`,
  deviceAddedText: (device, when, site) => `你的账户在 ${when} 把 terminus 添加到了 ${device}。\n\n如果不是你，请在账户页面（${site}/account）或你的任一设备上移除它，并在所有设备上退出登录。`,
  deviceRemovedText: (device, when, site) => `${device} 已在 ${when} 从你的 terminus 账户移除，并已退出登录。\n\n如果不是你，请在 ${site}/account 登录，并在所有设备上退出登录。`,

  pageLinkExpired: '链接已失效',
  linkExpiredHtml: '<h1>这个链接已失效</h1><p class="hint">登录链接只能用一次，有效 15 分钟。</p><a class="btn accent" href="/account">获取新链接</a>',
  pageSignIn: '登录',
  signInTitle: '登录 terminus',
  continueAs: (who) => `在这台设备上以 <strong>${who}</strong> 继续。如果这不是你的地址，或者这个链接是别人发给你的，请关闭此页面。继续会让你登录到对方的账户，你添加的任何内容都会归对方所有。`,
  signInButton: '登录',
  pageRequestExpired: '请求已失效',
  approveExpiredHtml: '<h1>这个请求已失效</h1><p class="hint">登录请求只能用一次，有效 15 分钟。请在你的设备上重新开始。</p>',
  pageApprove: '批准登录',
  approveTitle: (device) => `在 ${device} 上登录 terminus？`,
  approveHint: (when, device) => `请求时间 ${when}。请选择 ${device} 上显示的数字。`,
  notMe: '不是我',
  pageApproved: '已批准',
  approvedHtml: '<h1>已批准</h1><p class="hint">请回到你的设备，几秒内就会登录。你可以关闭此页面。</p>',
  pageCancelled: '已取消',
  cancelledHtml: (picked) => `<h1>已取消</h1><p class="hint">${picked ? '这个数字与设备上显示的不一致，因此请求已取消。' : '请求已取消，没有登录任何设备。'}如果你是在登录，请在你的设备上重新开始。</p>`,
};

const MSGS: Record<Lang, Msgs> = { en, zh };

/** The current request's messages. */
export function m(): Msgs {
  return MSGS[lang()];
}

/** One language's messages, for tests and the review sheet. */
export function msgsFor(l: Lang): Msgs {
  return MSGS[l];
}

/**
 * Error messages, which every route words in English (`json({ error })`),
 * translated where they're sent (http.ts). A test checks every literal
 * `error: '...'` in src has an entry, so a new one can't go untranslated.
 */
export const ERRORS_ZH: Record<string, string> = {
  'unknown destination: pass ?to= a stop or venue code': '未知的目的地：用 ?to= 指定车站或地点代码',
  'pass lat and lon, or ?from= a stop code': '请提供 lat 和 lon，或用 ?from= 指定车站代码',
  'unknown stop': '未知的车站',
  'unknown service': '未知的路线',
  'that request came from another site': '这个请求来自其他网站',
  'no such trip today': '今天没有这趟行程',
  'too many requests, slow down': '请求太多了，请慢一点',
  'too many requests for this key, slow down': '这个密钥的请求太多了，请慢一点',
  'not found': '找不到',
  internal: '服务器出错了',
  'delete the account from the account page': '请在账户页面删除账户',
  'send the profile as JSON': '请以 JSON 发送资料',
  "send place (a favourite's key) or to (a stop, place or room code)": '请发送 place（收藏的键）或 to（车站、地点或教室代码）',
  'atMin must be minutes past midnight, Singapore time': 'atMin 必须是新加坡时间午夜后的分钟数',
  'date must be today or within the next week (YYYY-MM-DD)': '日期必须是今天或接下来一周内（YYYY-MM-DD）',
  'that time has passed today': '今天这个时间已经过了',
  'not a valid NUSMods share link': '不是有效的 NUSMods 分享链接',
  'no modules found in that link': '这个链接里没有找到模块',
  'give the key a name, so you know what uses it': '给密钥起个名字，方便知道是谁在用',
  'no such key': '没有这个密钥',
  'no such device': '没有这台设备',
  'trip tracking is not available': '行程跟踪暂不可用',
  'no trip in progress to say that about': '目前没有进行中的行程',
  'web push is not set up on this server': '这台服务器没有设置网页推送',
  'send subscription: an https endpoint with keys.p256dh and keys.auth': '请发送 subscription：带 keys.p256dh 和 keys.auth 的 https 端点',
  'send token (the FCM registration token) or subscription': '请发送 token（FCM 注册令牌）或 subscription',
  "send id (from card.suggestion) or trip and pref ('earlier' or 'quiet'), and choice: accept, dismiss or undo": "请发送 id（来自 card.suggestion）或 trip 和 pref（'earlier' 或 'quiet'），以及 choice：accept、dismiss 或 undo",
  "that's a lot of reports for one day; thanks, try again tomorrow": '今天的反馈已经很多了，谢谢！请明天再试',
  'accounts are not configured': '账户功能未配置',
  'too many attempts, try again in a minute': '尝试次数太多，请一分钟后再试',
  'enter a valid email address': '请输入有效的邮箱地址',
  'the human check failed, try again': '人机验证没有通过，请再试一次',
  'sign-in is busy, try again in a minute': '登录繁忙，请一分钟后再试',
  'could not send the email, try again later': '邮件发送失败，请稍后再试',
  'enter the 6-character code from the email': '请输入邮件里的 6 位验证码',
  'that code is wrong or has expired': '验证码不对或已失效',
  'terminus is busy, try again in a minute': 'terminus 正忙，请一分钟后再试',
  'this device is already signed in': '这台设备已经登录了',
  'an email was sent to that address a moment ago; wait a minute and try again': '刚刚已经向这个地址发了邮件，请等一分钟再试',
  'send request and poll': '请发送 request 和 poll',
  'enter the 6-character code from the account page': '请输入账户页面上的 6 位代码',
  "send anon (the device's old token) and keep: 'account' or 'device'": "请发送 anon（设备的旧令牌）和 keep：'account' 或 'device'",
  'that token is not an anonymous account': '这个令牌不是匿名账户',
  'sign in first': '请先登录',
  'do this from the account page': '请在账户页面进行',
  'add an email to this account first': '请先给这个账户添加邮箱',
  'send lat and lon, or set a home': '请发送 lat 和 lon，或设置家',
  'profile must be an object': '资料必须是一个对象',
  "kind is 'wrong' or 'other'": "kind 必须是 'wrong' 或 'other'",
  "platform is 'android', 'mac' or 'web'": "platform 必须是 'android'、'mac' 或 'web'",
  "that code isn't right; check the email and try again": "验证码不对，请检查邮件后再试",
  "context is the answer object": "context 必须是答案对象",
  "context is too large": "context 太大了",
  "downloads are not configured": "下载未配置",
  "fullBusMargin must be true or false": "fullBusMargin 必须是 true 或 false",
  "publicBuses must be true or false": "publicBuses 必须是 true 或 false",
  "gapHours must be between 0.5 and 12": "gapHours 必须在 0.5 到 12 之间",
  "home must be {stops: [...]}": "home 必须是 {stops: [...]}",
  "homeWalkMin must be 0 to 30 minutes": "homeWalkMin 必须是 0 到 30 分钟",
  "lang must be auto, en or zh": "lang 必须是 auto、en 或 zh",
  "clock must be auto, 12 or 24": "clock 必须是 auto、12 或 24",
  "no release yet": "还没有发布版本",
  "release file missing": "找不到发布文件",
  "say what went wrong": "请说说哪里出了问题",
  "seen must be a short list of names": "seen 必须是一个简短的名称列表",
  "send the answer that was wrong, or a note": "请发送出错的答案，或写个说明",
  "share must be a NUSMods link": "share 必须是 NUSMods 链接",
  "term must be {acadYear: \"2026/2027\", semester: 1-4}": "term 必须是 {acadYear: \"2026/2027\", semester: 1-4}",
  "the day must start before it ends": "一天的开始时间必须早于结束时间",
  "walkPace must be slow, normal or fast": "walkPace 必须是 slow、normal 或 fast",
};

/** An error message in the current language. Unknown ones stay English. */
export function errorText(en: string): string {
  if (lang() === 'en') return en;
  return ERRORS_ZH[en] ?? en;
}
