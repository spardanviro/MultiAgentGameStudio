# Changelog

All notable changes to the module-pipeline plugin. Versions follow
`plugins/module-pipeline/.claude-plugin/plugin.json`.

## 0.2.0 - 2026-09-28

### Added

- `generated_files` in the manifest: engine and tool output (Godot `.uid` and
  `.import` files, caches) that lands outside a task's scope is dropped from
  the merge instead of rejecting the whole module. Inside the scope it merges
  as usual.
- A `PostToolUse` hook on Bash: after every shell command a pipeline writer
  runs, its worktree is checked against its scope, and the agent is told
  immediately about out-of-scope files so it can undo them before the audit.
- `diagnostics.test_command`: runs the full test suite on the run branch after
  modules merge and after integration. It is skipped when the compile step
  fails; a failing suite makes the gate `diagnostics_failed`.
- `/module-pipeline:clean`: removes worktrees kept for inspection, stale
  claims, merge worktrees and, with `--branches`, run branches already merged
  into the main branch. Always shows a dry run first.
- `/module-pipeline:finish`: summarizes a run branch against the main branch,
  drafts a PR description, and merges, squashes or opens a PR only with an
  explicit yes.
- `defaults.preset` (`economy`, `balanced`, `quality`) for model and effort
  defaults, and an agent count per role and model in `validate`, shown at the
  end of planning.
- GitHub Actions: tests on Linux, Windows and macOS, and
  `claude plugin validate` for the marketplace and the plugin.

### Changed

- The main checkout no longer has to stay on the run branch during a run.
  Agents are moved to the run branch tip when they claim their worktree, and
  when the main checkout is on another branch, modules are committed through
  a detached merge worktree (`.multiagent/pipeline/merge/<run>`) and
  diagnostics run there. Uncommitted work on other branches no longer blocks
  a run.
- Rework run ids no longer nest: rework of `run-001-r1` is `run-001-r2`.
- `status` no longer lists the `*-result.json` files as runs, and reports the
  main checkout's branch and test failures.

## 0.1.0 - 2026-09-27

First release: planning, parallel module implementation in isolated
worktrees with a `PreToolUse` scope hook, audit and one commit per module on
a per-run branch, module and system reviews, integration, rework runs and
status.
