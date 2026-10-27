import { bindings, defineConfig, exports, triggers } from "cf/config";

// Secrets are declared below with bindings.secret(); their values live on the
// Worker (set with `cf workers secrets update`), locally in .dev.vars. Without
// the declarations, a cf deploy uploads a version with no secrets at all.
// D1 migrations are in ./migrations, the default for `cf d1 migrations`.
// The website directory (../web/public) is in wrangler.config.ts.
//
// Two Workers from one config. `cf deploy` is the stable site; `cf deploy
// --mode beta` (pnpm run deploy:beta) is the beta at beta.terminus.run,
// with its own database, KV, trips, downloads and analytics, so beta accounts
// and migrations never touch the stable ones (ids in BETA).

const BETA = {
	d1: "d7f309ef-6e3a-457f-a106-154fa797b933",
	kv: "5bd33589cdfc43c0bb324d158edd46ba",
};

// Pages opened on the old address go to terminus.run (MOVE_PAGES, site.ts
// movedPage), and emailed links use the site's own address. If a network
// refuses terminus.run, add LINK_ORIGIN set to the old address and drop
// MOVE_PAGES.
const moved = () => ({
	MOVE_PAGES: bindings.text("on"),
});

function site(mode: string | undefined) {
	if (mode === undefined || mode === "production") {
		return {
			name: "terminus",
			domain: "terminus.run",
			// The old address keeps answering: apps before 3.3.0 call it and
			// check for updates there, and ones before 3.6.0 fall back to it.
			oldDomain: "terminus.rcn.sh",
			d1: { name: "terminus", id: "27067356-8691-458f-bc69-fa5ca5bbc374" },
			kv: "1f88f570f6e04f78aa2888ee7aa78e6a",
			downloads: "terminus-downloads",
			dataset: "terminus",
			// Rate limit counters are per namespace; the beta has its own.
			rl: { auth: "1001", public: "1002", me: "1003", mail: "1004", anon: "1005", map: "1006", pair: "1007" },
			// The timelapse recorder polls NUS (src/map/timelapse.ts): on here, off on
			// the beta, so the two sites never poll twice.
			env: {
				TIMELAPSE_ENABLED: bindings.text("on"),
				// The arrival-time model scores each day in shadow (src/ops/etashadow.ts),
				// answering no one; it needs the eta collector on too. Off on the beta.
				ETA_MODEL: bindings.text("shadow"),
				// APNs's topic: the iPhone app's bundle id (src/push/apns.ts).
				APNS_TOPIC: bindings.text("sh.rcn.terminus"),
				// APPLE_TEAM_ID turns on iOS universal links:
				// /.well-known/apple-app-site-association (src/site/site.ts). The
				// stable Worker has it as a secret (though it isn't one); the beta has
				// none, so its universal links are off.
				...moved(),
			},
		};
	}
	if (mode !== "beta") throw new Error(`unknown mode ${mode}: use --mode beta, or none for the stable site`);
	if (!BETA.d1 || !BETA.kv) throw new Error("the beta's D1 and KV ids aren't in cloudflare.config.ts yet");
	return {
		name: "terminus-beta",
		domain: "beta.terminus.run",
		oldDomain: "beta.terminus.rcn.sh",
		d1: { name: "terminus-beta", id: BETA.d1 },
		kv: BETA.kv,
		downloads: "terminus-beta-downloads",
		dataset: "terminus_beta",
		rl: { auth: "2001", public: "2002", me: "2003", mail: "2004", anon: "2005", map: "2006", pair: "2007" },
		env: {
			PUBLIC_ORIGIN: bindings.text("https://beta.terminus.run"),
			AE_DATASET: bindings.text("terminus_beta"),
			TIMELAPSE_ENABLED: bindings.text("off"),
			APNS_TOPIC: bindings.text("sh.rcn.terminus.beta"),
			ETA_MODEL: bindings.text("off"),
			...moved(),
		},
	};
}

export default defineConfig(({ mode }) => {
	const s = site(mode);
	return {
		worker: {
			name: s.name,
			compatibilityDate: "2025-01-15",
			compatibilityFlags: [
				"nodejs_compat",
			],
			entrypoint: "src/index.ts",
			workersDev: false,
			observability: {
				enabled: true,
				logs: {
					enabled: true,
					invocationLogs: false,
				},
			},
			// The Worker runs first for the pages (security headers, the CSP, the
			// beta's badge) and everything it answers. Scripts, styles and images
			// skip it: static files are free, a Worker request is not, and a page
			// asks for a dozen or more of them. Their headers come from
			// ../web/public/_headers instead. `*` matches across `/`, so "/*.js"
			// is every script at any depth; nothing the Worker answers ends in
			// .js or .css (a test checks).
			assets: {
				runWorkerFirst: ["/*", "!/assets/*", "!/vendor/*", "!/*.js", "!/*.css", "!/favicon.*", "!/manifest.webmanifest"],
			},
			// Nothing here needs more than a fraction of this: it stops a bug
			// that loops from running up the bill, one request at a time.
			limits: {
				cpuMs: 5_000,
			},
			// Run every request in Singapore, wherever it came in. An answer is
			// several round trips in a row to D1 (in APAC), the feed gate (apac)
			// and NUS's feed (Singapore); from a far data centre (a student on
			// a VPN through Frankfurt, say) each costs a few hundred ms more,
			// against one hop for the request itself. Static files skip the
			// Worker and are still served near the user; the cron and the
			// Durable Objects aren't placed. Rate limits count per data centre,
			// so with nearly all requests in one, the ceilings are close to
			// worldwide, as RL_ANON and RL_PAIR mean them to be.
			placement: {
				region: "aws:ap-southeast-1",
			},
			domains: [
				s.domain,
				s.oldDomain,
			],
			// The trip engine: one Durable Object per user with today's trip signals,
			// the timelapse recorder, one per Singapore day (src/map/timelapsedo.ts),
			// and the feed gate, one per stop or service (src/feeds/feedgate.ts).
			exports: {
				Trip: exports.durableObject({ storage: "sqlite" }),
				TimelapseRecorder: exports.durableObject({ storage: "sqlite" }),
				FeedGate: exports.durableObject({ storage: "sqlite" }),
			},
			triggers: [
				triggers.scheduled({
					schedule: "*/15 * * * *",
				}),
			],
			env: {
				EMAIL_FROM: bindings.text("login@terminus.run"),
				TURNSTILE_SITE_KEY: bindings.text("0x4AAAAAAFHR71tKL907Buou"),
				// One widget for both sites; a pass counts only on this one's own addresses.
				TURNSTILE_HOSTNAMES: bindings.text(`${s.domain},${s.oldDomain}`),
				// For the dashboard's Analytics Engine queries (with the optional ANALYTICS_TOKEN secret).
				CF_ACCOUNT_ID: bindings.text("31e51704ff7169c03d7014c3a1e5f110"),
				TRIPS: bindings.durableObject({
					worker: s.name,
					exportName: "Trip",
				}),
				TIMELAPSE: bindings.durableObject({
					worker: s.name,
					exportName: "TimelapseRecorder",
				}),
				FEED_GATE: bindings.durableObject({
					worker: s.name,
					exportName: "FeedGate",
				}),
				AE: bindings.analyticsEngineDataset({
					name: s.dataset,
				}),
				DB: bindings.d1(s.d1),
				KV: bindings.kv({
					id: s.kv,
				}),
				DOWNLOADS: bindings.r2({
					name: s.downloads,
				}),
				EMAIL: bindings.sendEmail({
					// The old address stays allowed, so sending from it again is
					// only EMAIL_FROM.
					allowedSenderAddresses: [
						"login@terminus.run",
						"login@terminus.rcn.sh",
					],
				}),
				RL_AUTH: bindings.rateLimit({
					namespace: s.rl.auth,
					simple: {
						limit: 10,
						period: 60,
					},
				}),
				RL_PUBLIC: bindings.rateLimit({
					namespace: s.rl.public,
					simple: {
						limit: 60,
						period: 60,
					},
				}),
				RL_MAIL: bindings.rateLimit({
					namespace: s.rl.mail,
					simple: {
						limit: 30,
						period: 60,
					},
				}),
				// New anonymous accounts from apps, across everyone.
				RL_ANON: bindings.rateLimit({
					namespace: s.rl.anon,
					simple: {
						limit: 120,
						period: 60,
					},
				}),
				// Pairing-code lookups, across everyone. A guess is tried against
				// every live code at once, so a per-IP limit alone falls to an
				// attacker with many addresses (an IPv6 /48 is 65,536 /64s).
				// People pair a device rarely; 60 a minute is far above that.
				RL_PAIR: bindings.rateLimit({
					namespace: s.rl.pair,
					simple: {
						limit: 60,
						period: 60,
					},
				}),
				RL_ME: bindings.rateLimit({
					namespace: s.rl.me,
					simple: {
						limit: 120,
						period: 60,
					},
				}),
				// The map's reads from R2, per IP. A map open is dozens of pieces,
				// but nearly all come from the edge cache and don't count.
				RL_MAP: bindings.rateLimit({
					namespace: s.rl.map,
					simple: {
						limit: 300,
						period: 60,
					},
				}),
				ASSETS: bindings.assets(),
				ALERT_EMAIL: bindings.secret(),
				HEALTH_TOKEN: bindings.secret(),
				// TIMELAPSE_TOKEN, which opens /api/timelapse/* only for the VPS that renders
				// the videos (scripts/dev/render-timelapse.mjs), is an optional secret like
				// ANALYTICS_TOKEN: not declared, so a site without one (the beta) deploys.
				NEXTBUS_APP_API: bindings.secret(),
				NEXTBUS_APP_VERSION: bindings.secret(),
				NEXTBUS_AUTH_BASE: bindings.secret(),
				NEXTBUS_HTD_API: bindings.secret(),
				NEXTBUS_PROXY_API_KEY: bindings.secret(),
				NEXTBUS_PROXY_BASE: bindings.secret(),
				TURNSTILE_SECRET: bindings.secret(),
				FCM_SERVICE_ACCOUNT: bindings.secret(),
				// Web Push: the VAPID key, a P-256 JWK (scripts/deploy/vapid-key.mjs).
				VAPID_PRIVATE_KEY: bindings.secret(),
				// APNs (src/push/apns.ts): APNS_KEY (the .p8, PEM), APNS_KEY_ID and
				// APNS_TEAM_ID are optional secrets, not declared, so a site deploys
				// without them; until all three are set, iPhones aren't pushed.
				...s.env,
			},
		},
	};
});
