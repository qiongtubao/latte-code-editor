# Proposal: add `--json` NDJSON output to `@latte-graph/cli build`

## Why
- Editor needs streaming progress for builds >1s.
- Current stdout is human-readable; parsing requires regex.
- NDJSON is the de-facto standard for CLI streaming consumers (ripgrep --json, jest --json, esbuild --log-level).

## Shape
```
{"type":"start","job":"build","files":1240}
{"type":"progress","file":"src/a.ts","done":42,"total":1240}
{"type":"log","level":"info","msg":"linking edges"}
{"type":"done","stats":{"files":1240,"nodes":8732,"edges":12450,"ms":4321}}
{"type":"error","message":"parse failed: src/x.ts"}
```

## Compatibility
- Default unchanged. `--json` opts in.
- Errors on stderr stay text (humans read CI logs).
- Exit codes unchanged.

## Rollout
- v0.4: behind `--json` flag.
- v0.5: also expose `done.stats.ms` and `progress.pct`.
- v0.6: deprecate the human format when TTY is not attached.

## Status

This document is a **dry-run scaffolding** of a future upstream PR against
`latte-code-review-graph`. It is being kept inside the editor repo
(`latte-code-editor`) on purpose: from this working copy we do not have write
access to the upstream `latte-code-review-graph` repository, so we cannot open
the real PR from here. Storing the proposal locally lets the design be reviewed
and iterated on without round-tripping through a fork, and it makes the
intent, shape, and rollout plan easy to find when someone is ready to file
the real PR.

The actual PR will be filed by the user (or a future contributor) once the
design is reviewed and accepted. At that point the contents of this file —
plus the illustrative diff in `ndjson-patch.diff` — should be moved into the
upstream repo as a single `docs:` + `feat:` commit pair, with the proposal
copied into the PR description and the diff applied against
`packages/cli/src/commands/build.ts`.

On the editor side, this proposal is motivated by two existing commands
that already follow streaming-friendly patterns: `cmd_semantic_search`
(landed in T22) shells out to `rg` via `Command::new("rg")` in `rg_search`,
and `cmd_user_hook` (landed in T26) executes user-defined hook scripts
that may themselves want to stream progress. A first-party
`latte build --json` invocation would let the editor replace the `rg`
shelling with a single, native streaming source, and would give
`cmd_user_hook` a stable, documented event format to forward to the
renderer over IPC.
