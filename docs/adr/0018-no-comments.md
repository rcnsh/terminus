# Code carries no comments; knowledge lives in names, docs and ADRs

Comments had grown to about 27,000 lines, roughly one in seven of the code, and they drifted: many restated the line below, repeated a paragraph of internals.md, or described code that had since changed. Others let a workaround stand by explaining it, and the next session copied the workaround along with its excuse. A comment is read by nobody who doesn't open that file, and checked by nothing.

So the code says what it does through its names and its shape, and what it can't say goes where it is kept current: a decision that looks odd but is deliberate in an ADR here; how something works, and what the outside feeds were seen to do (NUS, LTA, NUSMods), in docs/internals.md, whose "What the feed looks like" section holds the feed evidence that comments in `src/feeds/` used to; a hack in a GitHub issue, so it gets fixed rather than explained.

`scripts/comments.mjs` counts comment lines in every language the repo writes (TypeScript, JavaScript, Kotlin, Swift, CSS, HTML, SQL, shell, Python, YAML), and `pnpm lint` fails when a file has more than `scripts/comments-baseline.json` allows. The 27,000 lines were removed in one pass, so the baseline is empty and every file is allowed none. It stays a ratchet rather than a flat ban so that a large import (a vendored file brought in by hand, a generated one) can be let in at its count and cleared later; `--update` only ever lowers it.

Not counted, because a tool reads them: directives (`oxlint-disable`, `@ts-expect-error`, `shellcheck`, `swiftlint:`, `noinspection`), shebangs, the version after a pinned action's SHA (Dependabot reads it), and the SQL migrations, whose `-- contract:` lines `test/deploy.test.js` reads and whose applied files are locked by hash.

We considered keeping "why" comments, and a ban that exempted the feed readers. Both leave the line between a good comment and a bad one to each session's judgement, which is how the 27,000 lines built up; a count anyone can run does not drift.
