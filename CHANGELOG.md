# Changelog

All notable changes to the module-pipeline plugin. Versions follow
`plugins/module-pipeline/.claude-plugin/plugin.json`.

## 0.9.1 - 2026-10-02

`plan`, `rework`, `finish` and `clean` were run for real under the Bash
sandbox (WSL2, Claude Code 2.1.286): a spec was planned, built, reworked
once, merged both ways and cleaned up, with the project writable and with
its sources denied for writing. What that turned up:

### Fixed

- In the planning session `git status` lists the sandbox's placeholder
  entries. Told only that `commit-planning` commits everything uncommitted,
  the session expected the commit to fail on them and wrote 22 lines into
  `.git/info/exclude`, which would later hide real files (`.mcp.json`,
  `.vscode/`, `.claude/skills`). `validate` and `commit-planning` now carry
  a `sandboxNote`: the entries are skipped and must be left alone. The plan
  and rework skills say the same.
- With the sources denied for writing, a sandboxed `git switch` or
  `git merge` moves the branch and exits with 0 while the files stay as they
  were ("unable to unlink …: Read-only file system" is only a warning), so
  `finish` would have left the main checkout half switched. `finish` and
  `status --run` now report `readOnly` and a `readOnlyNote` when the switch
  or merge would write a path this shell cannot write, and the finish and
  rework skills hand the user the commands for their own terminal instead.
  `commit-planning` says when the checkout it just put on the run branch
  cannot be written, so the user switches it back before the run.
- `prepare` called a checkout read-only when any tracked top-level entry
  could not be written. The sandbox keeps its own list read-only in every
  project (`.vscode/`, `.idea/`, `.mcp.json`), so a project that tracks one
  of them could not start a run with the sandbox on. Only the paths the
  stages write are looked at now.
- A patch's size counted the report the patcher writes about its own work.
  A two-line fix with a 28-line report was refused as `too_large` against a
  limit of 20. The patch report and the interface request no longer count,
  and a merged patch reports its `changedLines` too.
- `finish` suggested `clean <run> --branches` with the rework run's id,
  which leaves the earlier branches of the chain behind. It now names the
  run family (`family` in the summary).
- `finish` had the session read `git status` for uncommitted work, which
  under the sandbox is a list of placeholders. The summary now carries
  `uncommitted`, without them.

### Added

- `clean` lists `prunable` worktree records. Inside the sandbox git cannot
  delete them; the skill tells the user to run `git worktree prune` in
  their own terminal.
- README: what each stage needs from the user in the strict setup, the
  sandbox's own read-only list, pushing from the sandbox, and what to do
  when a session has no Workflow tool.

## 0.9.0 - 2026-10-02

The pipeline runs under Claude Code's Bash sandbox. Found by probing the
sandbox in WSL2 and then running the module and integration stages there for
real, with the project writable and with its sources denied for writing.

### Fixed

- The lock told a live holder by its process id. Every sandboxed command has
  its own process namespace, so a waiting merge saw the holder as gone and
  took its lock. A holder now touches the lock every 2 seconds from a worker
  thread; a holder that cannot be seen (another sandbox, another machine) is
  judged by that heartbeat, and its lock is free after 30 silent seconds. A
  holder that can be seen is still asked directly.
- The sandbox binds device nodes over protected paths in the working
  directory (`.mcp.json`, `.claude/commands`, `.bashrc` and others). They
  were taken for uncommitted files, so `prepare` refused to start, a claim
  could not move its worktree to the run branch, and they could count as
  out-of-scope changes. Entries git cannot track are now ignored everywhere.
- With the main checkout on another branch, the manifest, the prompts and
  the rules file were still looked for in the working tree, where planning
  output committed on the run branch does not exist. They are now read from
  the run branch, by `validate`, `prepare` and every command of a running
  stage.
- A worktree that git removed but could not finish cleaning (the sandbox
  holds entries in its metadata folder) is treated as removed, and its
  branch is deleted.

### Added

- `prepare` stops with a clear message, and a `readOnly` list, when the main
  checkout is on the run branch but cannot be written
  (`sandbox.filesystem.denyWrite`), instead of failing in the middle of a
  merge.
- A claim made inside the sandbox carries a `sandboxNote`: `git add -A`
  fails there, so name the paths or do not commit.
- README: "Running under the Bash sandbox", with the open and the strict
  setup and what to expect in each.

## 0.8.1 - 2026-10-01

Fixes from an outside review of the gates.

### Fixed

- The integration status could be `passed` while the system review listed a
  feature as `partial` or `missing`, when no blocking item was written for
  it. The status now counts such rows (`coverageGaps`) as blocking. A row is
  exempt only when the reviewer marks it `deferred` and names where the spec
  or a rework decision puts it off.
- The pipeline lock was deleted after 10 minutes whatever its holder was
  doing, so a merge whose git hooks ran longer could be joined by a second
  merge. A lock is now stale only when the process that holds it is gone;
  age decides only for a lock from another machine or an unreadable one. A
  crashed holder's lock is taken over at once instead of after 10 minutes,
  and a process releases only its own lock.
- Build output such as `1 error, 0 warnings` or `0 errors, 2 warnings` was
  skipped whole, because any line with a zero count was ignored. A summary
  line is now judged by its numbers.

### Changed

- A pipeline writer's shell command is refused before it runs
  (`PreToolUse` on Bash) when its text shows a write into the main checkout
  or another agent's worktree: a redirection, a file-changing command, or a
  mutating git command aimed there by absolute path, through `..`, or after
  a `cd`. Reading there is never refused, and neither is a command that
  only mentions the path (in a string, a here-document, a comment).
- `record` lists files left uncommitted in the main checkout
  (`strayChanges`), which no pipeline merge writes.
- The docs say what the scope guard guarantees: only in-scope changes are
  merged. It is not a sandbox; a program can still write outside the
  worktree in ways a command's text does not show. They also say what a
  probe on Claude Code 2.1.284 (Windows) and 2.1.286 (WSL2, sandbox on)
  showed: Claude Code refuses a worktree agent's Write tool and `git -C` on
  the main checkout but not its shell writes there; the Bash sandbox (macOS,
  Linux and WSL2 only) stops writes outside the project; and
  `sandbox.filesystem.denyWrite` makes listed paths of the main checkout
  read-only while agents keep their worktrees.

## 0.8.0 - 2026-10-01

Less waste, from measuring where the benchmark run spent its tokens and time:
the main session cost more than a whole single-session build (101 calls, each
carrying the full conversation), the plan overestimated the project by almost
two times and split it into seven small modules, a usage-limit interruption
made five finished modules be built again, and tests restating the spec made
a four-number change cost up to 80 test lines.

### Added

- `record --from <workflow output file>`: finishes a stage in one call. It
  runs the module stage's diagnostics, writes `<run>-<stage>-result.json` and
  `<run>-<stage>-report.md`, and prints the status, the blocking items, the
  diagnostics line and the next command. The report holds every review item,
  the spec coverage, the seam audit and the source lines each module built
  against the plan's estimate. The session no longer writes these by hand.
- `prepare` is the only check a stage needs: it returns the uncommitted
  files to ask about, the warnings, `sizing` and `estimate`, and for the
  integration stage `modulesStatus`.
- Resume after an interruption: `prepare` lists as `resumable` the modules
  whose implementer had written its report but whose merge never ran, and
  the workflow sends them straight to their reviewer. A module whose merge
  was already refused is rebuilt instead.
- `skills/plan/test-rules.md`: test rules the plan copies into
  `docs/conventions.md` (numbers from the data module, assert only what the
  test is about, fixtures call production code, one rule in one place, no
  dependence on balance or a lucky seed). Module reviewers check them.

### Changed

- Module sizing: about 700-2,000 source lines per module. The bands are now
  under 2,000 lines: 1-2 modules, 2,000-6,000: 2-4, 6,000-15,000: 4-10,
  above: 8-20. The plan skill tells the architect to estimate low and why.
- `/module-pipeline:run` and `/module-pipeline:integrate` are three steps:
  prepare, workflow, record.
- `/module-pipeline:rework` reads the stage reports instead of the result
  JSON.
- Module prompts name the contract sections instead of copying them, and
  the plan stores each tuning value once.
- Agents keep the summaries in their structured result to a few sentences;
  the detail stays in the reports they write to files.

## 0.7.0 - 2026-10-01

Cross-module rules, from the phase-1 benchmark: the plugin's build passed
every acceptance test but had the most defects in blind review, nearly all of
them between modules (a debug switch reset by a new game, time summed to
599.9999 so the result screen showed 09:59, weapon state rebuilt on upgrade).
Each module looked right alone. The shared layer held helpers, but nobody had
decided how time is counted or where state lives.

### Added

- `shared_layer.rules`: the cross-module rules file, required with two or more
  modules. It must have the headings `Time`, `State`, `Numbers`, `Order` and
  `Errors`, each with text under it; `validate` and `prepare` report a missing
  file, heading or empty topic. HTML comments do not count as text.
- `skills/plan/cross-module-rules.md`: the template, with what to settle
  under each heading. It fails validation until it is filled in.
- `/module-pipeline:plan` has a new step that writes the rules. Each rule has
  a decision with exact values, the shared-layer export that carries it out,
  what modules must not do instead, and an exact-number check (a shared-layer
  test and a line in `integration.acceptance`). The architect lists the rules
  it decided itself before the plan is committed.
- The system reviewer returns `rule_checks`, one entry per topic
  (`followed`, `violated`, `not_applicable`, with evidence). A violated rule
  makes the integration result `rework_required`, and the result carries
  `ruleViolations`.

### Changed

- The shared layer now holds the code behind the rules (clock, number
  comparison, state containers, shared formulas), not only helpers.
- Claim and merge output, and the workflow args, carry `rules`; every agent
  prompt names the file.
- Implementers and the patcher may not settle a cross-module question locally
  (own tolerance, own running total, private copy of state, rebuilding state
  the rules say to update) or pin a workaround in a test. Module reviewers
  check the rules topic by topic and block a module that sidesteps one. The
  integrator keeps state where the rules put it.
- `/module-pipeline:rework` looks for seam defects first and fixes them at the
  cause on the module path: rule, then shared layer, then the modules that
  worked around it. A seam defect never goes to a patch run. A project
  planned before 0.7.0 gets its rules file written at its next rework.

### Upgrading

A manifest with two or more modules and no `shared_layer.rules` is now
rejected. Write the rules file from the template and add the field.

## 0.6.1 - 2026-09-30

### Fixed

- `finish` and `status` failed after a patch run: the `<run>-patch-result.json` file the
  run skill writes was listed as a run of its own. Result files of every stage
  are now recognized from one list, and a JSON file that is not a run state is
  never loaded as one.
- The Workflow tool refused to start the plugin's workflow scripts from the
  plugin cache (it only runs scripts from folders the session can read).
  `prepare` now copies the stage's script into `.multiagent/pipeline/workflows/`
  (git-ignored) and returns its path as `workflowScript`; `run` and `integrate`
  start the workflow from there.

## 0.6.0 - 2026-09-30

### Added

- Patch runs for small rework. `/module-pipeline:rework` now picks a path: when
  every open item is a local fix (no contract change, no new module, at most 4
  module folders, about 300 changed lines or fewer), it writes a patch
  manifest (`patch:` instead of `tasks` and `integration`). `/module-pipeline:run`
  then starts the new `patch-run` workflow: one `patcher` agent applies every
  item in one worktree, and one reviewer merges it, runs the diagnostics and
  checks each item. Two agents instead of an implementer and a reviewer per
  module plus the integration stage.
- The merge counts a patch's changed lines and refuses one over its
  `max_changed_lines` (default 300) with status `too_large`, keeping the
  worktree; the next rework takes the module path.
- The scope hooks cover the `patcher` agent; `finish` and `status` know patch
  results.

## 0.5.0 - 2026-09-29

Cheaper agents and better-organized code, from the token analysis of the first
real run.

### Changed

- The implementer, reviewers and integrator are defined with
  `omitClaudeMd: true`: your CLAUDE.md files and rules are no longer loaded into
  every agent (they were about two thirds of each agent's ~33k-token start-up).
  The Main Architect writes the rules that matter for the code into
  `docs/conventions.md`, which the agents read.
- The `pipeline-ops` relay agent is gone. The session runs `prepare` and the
  module-stage diagnostics; each module reviewer runs its module's merge; the
  system reviewer commits the glue and runs the integration diagnostics. The
  workflows take the `workflowArgs` printed by `prepare`. `effort.pipeline_ops`
  is ignored with a warning.
- Workflow prompts only name the task; `claim` and `integrate-task` print the
  task details (and the shared-layer folders) to the agent.

### Added

- `shared_layer` (required with two or more modules): the module that builds
  shared helpers, constants, theme values and test fixtures (`task`, runs first,
  every other module depends on it, may own a `support_folder`), or folders that
  already hold them (`existing`). Reviewers flag code that duplicates it.
- `project.estimated_lines`: validate reports `sizing` and warns when the module
  count does not fit the project's size. The plan skill sizes modules from it.

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
