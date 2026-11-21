import { bindings, defineConfig, exports, triggers } from "cf/config";

const BETA = {
	d1: "d7f309ef-6e3a-457f-a106-154fa797b933",
	kv: "5bd33589cdfc43c0bb324d158edd46ba",
};

const moved = () => ({
	MOVE_PAGES: bindings.text("on"),
});

function site(mode: string | undefined) {
	if (mode === undefined || mode === "production") {
		return {
			name: "terminus",
			domain: "terminus.run",
			oldDomain: "terminus.rcn.sh",
			d1: { name: "terminus", id: "27067356-8691-458f-bc69-fa5ca5bbc374" },
			kv: "1f88f570f6e04f78aa2888ee7aa78e6a",
			bucket: "terminus",
			dataset: "terminus",
			rl: { auth: "1001", public: "1002", me: "1003", mail: "1004", anon: "1005", map: "1006", pair: "1007" },
			env: {
				TIMELAPSE_ENABLED: bindings.text("on"),
				ETA_MODEL: bindings.text("shadow"),
				APNS_TOPIC: bindings.text("sh.rcn.terminus"),
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
		bucket: "terminus-beta",
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
			assets: {
				runWorkerFirst: ["/*", "!/assets/*", "!/vendor/*", "!/*.js", "!/*.css", "!/favicon.*", "!/manifest.webmanifest"],
			},
			limits: {
				cpuMs: 5_000,
			},
			placement: {
				region: "aws:ap-southeast-1",
			},
			domains: [
				s.domain,
				s.oldDomain,
			],
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
				TURNSTILE_HOSTNAMES: bindings.text(`${s.domain},${s.oldDomain}`),
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
				FILES: bindings.r2({
					name: s.bucket,
				}),
				EMAIL: bindings.sendEmail({
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
				RL_ANON: bindings.rateLimit({
					namespace: s.rl.anon,
					simple: {
						limit: 120,
						period: 60,
					},
				}),
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
				NEXTBUS_APP_API: bindings.secret(),
				NEXTBUS_APP_VERSION: bindings.secret(),
				NEXTBUS_AUTH_BASE: bindings.secret(),
				NEXTBUS_HTD_API: bindings.secret(),
				NEXTBUS_PROXY_API_KEY: bindings.secret(),
				NEXTBUS_PROXY_BASE: bindings.secret(),
				TURNSTILE_SECRET: bindings.secret(),
				FCM_SERVICE_ACCOUNT: bindings.secret(),
				VAPID_PRIVATE_KEY: bindings.secret(),
				...s.env,
			},
		},
	};
});
