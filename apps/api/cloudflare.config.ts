import { bindings, defineConfig, triggers } from "cf/config";

// Secrets are declared below with bindings.secret(); their values live on the
// Worker (set with `cf workers secrets update`), locally in .dev.vars. Without
// the declarations, a cf deploy uploads a version with no secrets at all.
// D1 migrations are in ./migrations, the default for `cf d1 migrations`.
// The website directory (../web/public) is in wrangler.config.ts.

export default defineConfig({
	worker: {
		name: "terminus",
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
			runWorkerFirst: true,
		},
		domains: [
			"terminus.rcn.sh",
		],
		triggers: [
			triggers.scheduled({
				schedule: "*/15 * * * *",
			}),
		],
		env: {
			EMAIL_FROM: bindings.text("login@terminus.rcn.sh"),
			TURNSTILE_SITE_KEY: bindings.text("0x4AAAAAAFHR71tKL907Buou"),
			AE: bindings.analyticsEngineDataset({
				name: "terminus",
			}),
			DB: bindings.d1({
				name: "terminus",
				id: "27067356-8691-458f-bc69-fa5ca5bbc374",
			}),
			KV: bindings.kv({
				id: "1f88f570f6e04f78aa2888ee7aa78e6a",
			}),
			DOWNLOADS: bindings.r2({
				name: "terminus-downloads",
			}),
			EMAIL: bindings.sendEmail({
				allowedSenderAddresses: [
					"login@terminus.rcn.sh",
				],
			}),
			RL_AUTH: bindings.rateLimit({
				namespace: "1001",
				simple: {
					limit: 10,
					period: 60,
				},
			}),
			RL_PUBLIC: bindings.rateLimit({
				namespace: "1002",
				simple: {
					limit: 60,
					period: 60,
				},
			}),
			RL_MAIL: bindings.rateLimit({
				namespace: "1004",
				simple: {
					limit: 30,
					period: 60,
				},
			}),
			RL_ME: bindings.rateLimit({
				namespace: "1003",
				simple: {
					limit: 120,
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
		},
	},
});
