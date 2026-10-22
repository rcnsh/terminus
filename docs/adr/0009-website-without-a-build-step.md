# The website is Preact and htm with no build step

The website is served by the Worker straight from `apps/web/public`: every module loads as written, and Preact, htm, MapLibre and Mediabunny are vendored by pinned scripts, with no CDN and no bundler (bfe316cc). This keeps the CSP strict (htm needs no eval), keeps what users run identical to what's in the repo, and leaves nothing to build in CI or on deploy. The costs are accepted: modulepreload lists kept by hand (and tested), `import()` for lazy parts, and no TypeScript or JSX on the website. Emails are the exception and use react-email.
