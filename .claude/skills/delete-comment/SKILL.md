---
name: delete-comment
description: Clear the comments from a slice of terminus (a file, a directory, a client) under ADR 0018, saving what each one knew in an ADR, internals.md or an issue first, then lowering the comment baseline. Use for /delete-comment, or when asked to prune, triage or remove comments.
---

# Delete comments

ADR 0018 bans comments; `scripts/comments.mjs` counts them and `pnpm lint` holds each file to `scripts/comments-baseline.json`. This skill clears one slice and leaves the baseline lower. Read ADR 0018 and the repo's `CLAUDE.md` first.

## 1. Pick the slice

Take the slice the user named. With none, take the top of `node scripts/comments.mjs --list` (files with the most comment lines) and stop near 2,000 comment lines, so the diff stays reviewable. Work on a branch in a fresh `git worktree` from `origin/main`; other sessions edit the main checkout.

## 2. Triage every comment

Read each file whole. Every comment gets exactly one verdict:

| Verdict | Test | Action |
| --- | --- | --- |
| **Tautology** | The name and the next line already say it. | Delete. |
| **Stale** | It describes code, a file or a behaviour that is no longer so, or repeats docs that already say it (`rg` internals.md, `docs/agents/`, the ADRs). | Delete. |
| **Excuse** | It explains away a workaround: a swallowed error, a test-only hook, a magic number, a copy of logic, a "for now". | Delete, and file one issue per workaround (step 4). |
| **Decision record** | A non-obvious choice with a reason, which a later session would undo without it. | Move it (step 3), then delete. |

A comment that only says what a value means (units, a field's shape) is a sign the name is weak: rename when the change stays inside the slice and its tests; otherwise record the fact as a decision record would be.

Done when every comment in the slice has a verdict. Keep the tally per verdict for the report.

## 3. Move the decision records

- A design choice with alternatives rejected: a new ADR in `docs/adr/`, numbered after the last, titled with the decision, in the style of the others (prose, the reason, what was rejected). Several small choices in one area go in one ADR.
- How something works, or what an outside feed (NUS, LTA, NUSMods) was seen to do, with when and how it was measured: the matching section of `docs/internals.md`, or the `docs/agents/` page that owns the area.
- Check the target first: much of it is often there already, which makes the comment Stale.

Done when every decision-record fact is findable in a doc by its function or file name.

## 4. File the excuses

One GitHub issue per workaround, `gh issue create` against the repo's origin, titled `type(scope): what to fix` as the commit rules say, with the file and line, what the hack is, and what a fix looks like. Group the same hack repeated across files into one issue. Link each with `link_issue` when that tool is there.

## 5. Delete and ratchet

```bash
node scripts/comments.mjs --strip <file>...   # removes every counted comment and the lines it stood on
pnpm format                                   # and pnpm format:kotlin / format:swift for those clients
node scripts/comments.mjs --update            # lowers the baseline to the new counts
```

Read the diff: `--strip` removes text, so an empty `catch {}` or block may need a real body, and oxlint may flag it. Then `pnpm lint` and `pnpm check` (and the client's own build and tests from `docs/agents/apps.md` for Android, Mac or iPhone files).

Done when lint and check pass and `git diff --stat scripts/comments-baseline.json` shows only falling numbers.

## 6. Report

Commit as `refactor(<scope>): drop comments from <slice>`, with the ADRs and doc moves in the same commit. Report the tally per verdict, the issues filed, the ADRs written, the lines shed (`node scripts/comments.mjs`, before and after), and what's left in the baseline.
