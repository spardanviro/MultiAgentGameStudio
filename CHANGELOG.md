# Changelog

All notable changes to the module-pipeline plugin. Versions follow
`plugins/module-pipeline/.claude-plugin/plugin.json`.

## 0.4.2 - 2026-09-29

Directory submission feedback.

### Added

- A plugin icon, `.claude-plugin/icon.svg`.

### Changed

- Wording only, no behavior change: `manifest.mjs` no longer names loop
  variables `key` or mentions tokens, and the pipeline-ops agent no longer
  quotes a shell snippet. Together they made the directory scan report a
  credential leaving the machine; the plugin reads no credentials and makes no
  network requests.

## 0.4.1 - 2026-09-29

### Added

- `homepage` and `repository` in `plugin.json`.
- A "What this plugin runs, reads and writes" section in the plugin README:
  every program and git subcommand it starts, both hooks, the files and
  branches it writes, what it deletes and when, and that it makes no network
  requests of its own. Prepared for the Claude plugin directory, whose
  security scan checks that a plugin's behavior is disclosed.

## 0.4.0 - 2026-09-29

Fixes for what the first real end-to-end run (a 10-module browser game, 56
agents) exposed, and new default thinking efforts.

### Changed

- Default efforts: the system reviewer thinks at `high`; module implementers,
  module reviewers, the integrator and pipeline ops at `medium`. Presets are
  now `economy` (low, system reviewer medium), `balanced` (the default) and
  `quality` (high, system reviewer xhigh).
- Skills set their own model and effort: `plan` and `rework` (the Main
  Architect) run on opus at `high`; `run`, `integrate`, `status`, `finish` and
  `clean` on opus at `medium`.
- The CLI prints one line of compact JSON (`--pretty` indents it). The
  pipeline-ops agent copies stdout verbatim, and the indented output made
  `prepare` slow to relay.
- The pipeline-ops agent is told not to wrap the command (it had appended
  `; echo "EXIT:$?"`).
- The plan skill now asks for exact spec values in contracts and for
  behavior tests that read tuning values from the data module, so a balance
  change does not ripple into every module's tests.

### Fixed

- Workflow scripts could be refused at launch for "control characters": Git
  for Windows checked them out with CRLF. The repository now has a
  `.gitattributes` that keeps LF, and a test guards the scripts.
- An integration stage whose integrator had nothing to change (typical for a
  rework run) was reported as `integration_failed` and skipped diagnostics and
  the system review. `empty` now continues to both.
- `prepare` refuses to start when the session is not in the project: Claude
  Code creates agent worktrees from the session's repository, so a session
  that had wandered into another folder would have built the wrong ones.
- Missing `user.name` / `user.email` is reported up front by `commit-planning`
  and `prepare` instead of failing half way through a commit.
- Worktrees locked by Claude Code are removed after merging (`--force --force`).

## 0.3.0 - 2026-09-28

### Changed (breaking manifest change)

- Every agent now runs on the strongest model (`opus`, which resolves to the
  newest Opus), including the reviewers and the pipeline-ops relay that used
  Haiku. Roles differ only in thinking effort.
- The `defaults:` section is replaced by `effort:`, with one level per role:
  `module_implementer`, `module_reviewer`, `integrator`, `system_reviewer`
  and `pipeline_ops`, plus `preset`. Presets now set efforts only:
  `economy`, `balanced` (the default) and `quality`. A task's or the
  integration's own `effort` still overrides its role.
- `model` fields and the old `defaults:` section are rejected with a message
  that points to `effort:`. Effort levels are validated.
- `validate` reports agent counts by role and effort, plus the model.

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

### Fixed

- Windows paths are compared in their real long form. A project reached
  through an 8.3 short name (such as `C:\Users\RUNNER~1\...`) or a different
  letter case was treated as a different folder from what git reports, which
  broke `prepare`, claims and the scope hook.

## 0.1.0 - 2026-09-27

First release: planning, parallel module implementation in isolated
worktrees with a `PreToolUse` scope hook, audit and one commit per module on
a per-run branch, module and system reviews, integration, rework runs and
status.
