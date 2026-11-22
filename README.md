# mend

One command-line tool that applies the edits AI models write, in four formats, to a tree of files: unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. Each patch
is read as [SPEC.md](SPEC.md) says, every edit's target lines are found at the first of three matching tiers, and
every file is changed or nothing is.

Run as `node main.ts [options] [PATCH]` (Node 22, standard library alone); the working directory is the root of the
tree. `--format=NAME` forces a format (`unified`, `search-replace`, `v4a`, `json`, or `auto`), `--check` reports
without writing, `--strict` matches lines exactly. Exit 0 prints one `A`/`D`/`M`/`R` line per changed path and
`ok: n files`; failures print one `error: <code> <path>` line each and `failed: k of n edits`, and nothing is written.

Entered in make.fun's [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
competition.

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jlele12/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jlele12/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
