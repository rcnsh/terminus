# The two addresses

ADR 0006 has the decision; this is how it's built.

terminus.run is the address people see and the one the apps call (from
3.3.0, or 3.2.1-beta.2 among the betas; beta.terminus.run for the beta), with the Mac's update feed and the
release scripts: it's the project's own domain, the one that goes with it
if someone else takes it over. terminus.rcn.sh (and beta.terminus.rcn.sh),
the owner's, is the old address: apps before 3.3.0 (betas before
3.2.1-beta.2) call it, and apps before 3.6.0 fall back to it once when
they can't reach terminus.run at all (`Servers.order`). From 3.6.0 the
apps have only terminus.run built in.
Both addresses stay attached to each Worker (`test/deploy.test.js`) until
no app that uses the old one is left. The
apps' developer menu (Settings, About: always in debug and beta builds,
after seven taps on the version in a stable release) shows diagnostics and
the recent requests, for a bug report, and in debug builds switches to the
dev stub, never a typed server (`Servers.kt`, `Servers` in `Api.swift`).

Pages opened on the old address go to the same page on terminus.run
(`movedPage` in `src/site/site.ts`, on with `MOVE_PAGES`), and emailed links use
terminus.run (`linkOrigin`). If a network refuses terminus.run,
`cloudflare.config.ts` says how to switch both off. The
privacy contact is privacy@terminus.run, through Email Routing's catch-all,
so it goes with the domain.
