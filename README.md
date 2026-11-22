# mend

One command-line tool that applies the edits AI models write, in four formats, to a tree of files:

| `--format=` | Shape of a patch |
| --- | --- |
| `unified` | `diff --git` hunks, often with wrong line numbers |
| `search-replace` | `<<<<<<< SEARCH` / `>>>>>>> REPLACE` blocks, path on the line above |
| `v4a` | `*** Begin Patch` … `*** Add/Update/Delete File:` sections |
| `json` | text-editor tool calls: `create`, `str_replace`, `insert` |
| `auto` | the default: guess the format from the first lines |

Each patch is read exactly as [SPEC.md](SPEC.md) says, every edit's target lines are found at the first
of three matching tiers (exact, trailing whitespace ignored, then leading too — with re-indentation at
the third), and every file is changed or nothing is.

Run as `node main.ts [options] [PATCH]` (Node 22, standard library alone); the working directory is the
root of the tree, and the patch is the file named or stdin. `--format=NAME` forces a format, `--check`
reports without writing, `--strict` matches lines exactly. Exit 0 prints one `A`/`D`/`M`/`R` line per
changed path and `ok: n files`; exit 1 prints one `error: <code> <path>` line per failed edit and
`failed: k of n edits`, and nothing is written; exit 2 is a usage or parse error.

Entered in make.fun's [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
competition.

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jlele12/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Jlele12/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
