/**
 * Every email's HTML, built with react-email: the sign-in codes, a device
 * added, and the operator's alerts. Each still goes with its plain text,
 * written where it's sent; this only dresses it.
 *
 * Mail clients keep little CSS (Gmail drops <style> in places, Outlook
 * renders with Word), so the components inline every style and lay out with
 * tables, and the look is the site's: its warm off-white page, white card,
 * ink and orange (site.css). Written with htm rather than JSX, so the
 * sources stay erasable TypeScript that Node runs as is.
 */
import { Children, createElement, type ReactElement, type ReactNode } from 'react';
import htm from 'htm';
import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text, render } from 'react-email';

import { lang, m } from './i18n.ts';

const html = htm.bind(createElement) as (strings: TemplateStringsArray, ...values: unknown[]) => ReactElement;

/** site.css's light colours: mail is read on white more often than not. */
const C = {
  bg: '#fafaf9',
  surface: '#ffffff',
  ink: '#1c1917',
  muted: '#6b6560',
  line: '#e7e5e2',
  accent: '#c2410c',
  accentBright: '#fb923c',
  accentSoft: '#fff1e6',
};
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif';
const DISPLAY = `"Space Grotesk", ${FONT}`;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const s = {
  body: { backgroundColor: C.bg, margin: 0, fontFamily: FONT, color: C.ink },
  container: { maxWidth: '480px', margin: '0 auto', padding: '32px 12px' },
  brand: { padding: '0 4px 16px' },
  wordmark: { fontFamily: DISPLAY, fontSize: '20px', fontWeight: 700, letterSpacing: '-0.02em', color: C.ink, verticalAlign: 'middle', textDecoration: 'none' },
  beta: { fontFamily: FONT, fontSize: '11px', fontWeight: 600, color: C.accent, backgroundColor: C.accentSoft, borderRadius: '6px', padding: '2px 6px', marginLeft: '8px', verticalAlign: 'middle' },
  card: { backgroundColor: C.surface, border: `1px solid ${C.line}`, borderRadius: '14px', padding: '32px 28px 16px' },
  h1: { fontFamily: DISPLAY, fontSize: '22px', lineHeight: '28px', fontWeight: 700, letterSpacing: '-0.01em', margin: '0 0 16px', color: C.ink },
  p: { fontSize: '15px', lineHeight: '23px', margin: '0 0 16px', color: C.ink },
  code: { fontFamily: MONO, fontSize: '34px', lineHeight: '40px', fontWeight: 700, letterSpacing: '8px', textAlign: 'center' as const, color: C.ink, backgroundColor: C.accentSoft, border: `1px solid #fcd9bd`, borderRadius: '12px', padding: '18px 8px 18px 16px', margin: '0 0 20px' },
  button: { backgroundColor: C.accent, color: '#ffffff', fontSize: '15px', fontWeight: 600, borderRadius: '11px', padding: '13px 20px', textDecoration: 'none', display: 'inline-block' },
  hr: { border: 'none', borderTop: `1px solid ${C.line}`, margin: '24px 0 20px' },
  small: { fontSize: '13px', lineHeight: '20px', margin: '0 0 16px', color: C.muted },
  footer: { fontSize: '12px', lineHeight: '18px', color: C.muted, textAlign: 'center' as const, padding: '20px 12px 0', margin: 0 },
  pre: { fontFamily: MONO, fontSize: '13px', lineHeight: '19px', whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, backgroundColor: '#f5f4f2', border: `1px solid ${C.line}`, borderRadius: '8px', padding: '12px 14px', margin: '0 0 16px', color: C.ink },
};

interface Frame {
  /** Where the site is, for the logo, its fonts and the links. */
  origin: string;
  beta: boolean;
  /** The line an inbox shows after the subject. */
  preview: string;
  children: ReactNode;
}

/** The page every email shares: the wordmark, a white card, a footer. */
function Layout({ origin, beta, preview, children }: Frame): ReactElement {
  const zh = lang() === 'zh';
  return html`<${Html} lang=${zh ? 'zh-Hans' : 'en'}>
    <${Head}>
      <meta name="color-scheme" content="light only" />
      <meta name="supported-color-schemes" content="light only" />
      <style>${`@font-face { font-family: 'Space Grotesk'; font-weight: 700; src: url(${origin}/assets/fonts/space-grotesk-latin.woff2) format('woff2'); }`}</style>
    <//>
    <${Preview}>${preview}<//>
    <${Body} style=${s.body}>
      <${Container} style=${s.container}>
        <${Section} style=${s.brand}>
          <${Link} href=${origin} style=${{ textDecoration: 'none' }}>
            <${Img} src=${`${origin}/assets/icons/apple-touch-icon.png`} width="28" height="28" alt=""
              style=${{ display: 'inline-block', borderRadius: '7px', verticalAlign: 'middle', marginRight: '10px' }} />
            <span style=${s.wordmark}>terminus</span>
          <//>
          ${beta ? html`<span style=${s.beta}>beta</span>` : null}
        <//>
        <${Section} style=${s.card}>${Children.toArray(children)}<//>
        <${Text} style=${s.footer}>${m().mailFooter}<//>
      <//>
    <//>
  <//>`;
}

const cta = (href: string, label: string) => html`<${Section} style=${{ margin: '0 0 16px' }}><${Button} href=${href} style=${s.button}>${label}<//><//>`;

/** Plain-text paragraphs, blank-line separated, as cards' paragraphs. */
const paragraphs = (text: string) => text.split(/\n{2,}/).map((p, i) => html`<${Text} key=${i} style=${s.p}>${p}<//>`);

export interface SignIn {
  origin: string;
  beta: boolean;
  code: string;
  link: string;
  /** The device an app asked from; none for the website. */
  device?: string;
  /** Why they got it, already worded. */
  why: string;
}

/** The sign-in email: the code, big; the link as a second way in. */
export function signInHtml(p: SignIn): Promise<string> {
  const t = m();
  const app = p.device !== undefined;
  return render(html`<${Layout} origin=${p.origin} beta=${p.beta} preview=${app ? t.codeTypeApp(p.device!) : t.codeTypeWeb}>
    <${Heading} as="h1" style=${s.h1}>${t.codeHeading}<//>
    <${Text} style=${s.code}>${p.code}<//>
    <${Text} style=${s.p}>${app ? t.codeTypeApp(p.device!) : t.codeTypeWeb}<//>
    ${app ? html`<${Text} style=${s.p}>${t.codeOtherDevice(p.device!)}<//>` : html`<${Text} style=${s.p}>${t.codeOrLinkText}<//>`}
    ${cta(p.link, app ? t.codeOtherDeviceButton : t.codeLinkButton)}
    <${Hr} style=${s.hr} />
    <${Text} style=${s.small}>${p.why}<//>
  <//>`);
}

/** "terminus was added to MacBook Air", with the way to undo it. */
export function deviceAddedHtml(p: { origin: string; beta: boolean; device: string; when: string; site: string }): Promise<string> {
  const t = m();
  const subject = t.deviceAddedSubject(p.device);
  const text = t.deviceAddedText(p.device, p.when, p.site);
  return render(html`<${Layout} origin=${p.origin} beta=${p.beta} preview=${text.split('\n')[0]}>
    <${Heading} as="h1" style=${s.h1}>${subject}<//>
    ${paragraphs(text)}
    ${cta(`${p.site}/account`, t.deviceAddedButton)}
  <//>`);
}

/** The text's indent marks it as a command; the box says that already. */
const dedent = (text: string) => {
  const lines = text.split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
};

/** "terminus: NUS bus feed is down" -> "NUS bus feed is down": the wordmark is above it. */
const heading = (subject: string) => subject.replace(/^terminus:?\s*/, '').replace(/^./, (c) => c.toUpperCase());

/**
 * An email to the operator, from its plain text: a paragraph that's code
 * (indented lines, JSON, a response body) keeps its spacing in a box.
 */
export function operatorHtml(p: { origin: string; beta: boolean; subject: string; text: string }): Promise<string> {
  const prose = (b: string, i: number | string) => html`<${Text} key=${i} style=${{ ...s.p, whiteSpace: 'pre-wrap' }}>${b}<//>`;
  const blocks = p.text.split(/\n{2,}/).map((b, i) => {
    const at = b.search(/^( {2}|[{["<])/m);
    if (at < 0) return prose(b, i);
    // "To undo it, from apps/api:" stays a sentence; only what follows is code.
    const code = html`<pre key=${`${i}c`} style=${s.pre}>${dedent(b.slice(at))}</pre>`;
    return at === 0 ? code : [prose(b.slice(0, at).trimEnd(), i), code];
  });
  return render(html`<${Layout} origin=${p.origin} beta=${p.beta} preview=${p.text.split('\n')[0]}>
    <${Heading} as="h1" style=${s.h1}>${heading(p.subject)}<//>
    ${blocks}
  <//>`);
}

export interface Report {
  origin: string;
  beta: boolean;
  id: string;
  /** "A wrong answer", "Feedback", "A better stop for a building". */
  what: string;
  /** "android 3.1.0". */
  from: string;
  at: number;
  /** The reason they picked, in words. */
  reason: string | null;
  note: string;
  /** A stop suggestion's lines, label and value, and the entry to paste. */
  details: [string, string][];
  entry: string | null;
  /** Whether the dashboard has the answer they saw. */
  withAnswer: boolean;
}

const chip = { display: 'inline-block', fontSize: '13px', fontWeight: 600, color: C.accent, backgroundColor: C.accentSoft, border: '1px solid #fcd9bd', borderRadius: '999px', padding: '4px 12px', margin: '0 0 16px' };
const quote = { fontSize: '16px', lineHeight: '24px', color: C.ink, borderLeft: `3px solid ${C.accentBright}`, padding: '2px 0 2px 14px', margin: '0 0 20px', whiteSpace: 'pre-wrap' as const };
const label = { fontSize: '13px', color: C.muted, padding: '6px 12px 6px 0', verticalAlign: 'top', whiteSpace: 'nowrap' as const };
const value = { fontSize: '14px', color: C.ink, padding: '6px 0', verticalAlign: 'top' };

/** "11 Oct 2026, 09:30 Singapore time": where the operator and the riders are. */
const sgTime = (ms: number) => {
  const d = new Date(ms + 8 * 3_600_000);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)} Singapore time`;
};

/** A report from a rider ("This was wrong", feedback, a better stop), for the operator. */
export function feedbackHtml(r: Report): Promise<string> {
  const when = `${r.from} · ${sgTime(r.at)}`;
  return render(html`<${Layout} origin=${r.origin} beta=${r.beta} preview=${r.note || r.reason || r.what}>
    <${Heading} as="h1" style=${{ ...s.h1, margin: '0 0 6px' }}>${r.what}<//>
    <${Text} style=${{ ...s.small, margin: '0 0 20px' }}>${when}<//>
    ${r.reason ? html`<span style=${chip}>${r.reason}</span>` : null}
    ${r.note ? html`<${Text} style=${quote}>${r.note}<//>` : null}
    ${r.details.length ? html`<table role="presentation" cellPadding="0" cellSpacing="0" style=${{ margin: '0 0 16px' }}><tbody>
      ${r.details.map(([k, v]) => html`<tr key=${k}><td style=${label}>${k}</td><td style=${value}>${v}</td></tr>`)}
    </tbody></table>` : null}
    ${r.entry ? html`<${Text} style=${s.p}>If it's right, add this to apps/api/data/src/venue-stops.json and run scripts/walk_routes.py:<//>` : null}
    ${r.entry ? html`<pre style=${s.pre}>${r.entry}</pre>` : null}
    ${cta(`${r.origin}/admin`, 'Open the dashboard')}
    <${Text} style=${s.small}>${`Report ${r.id}. ${r.withAnswer ? 'Who sent it and the answer they saw are' : 'Who sent it is'} on the dashboard, not in this email.`}<//>
  <//>`);
}
