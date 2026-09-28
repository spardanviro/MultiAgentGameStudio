# module-pipeline

The full guide (walkthrough, manifest reference, statuses, troubleshooting) is
in the [repository README](../../README.md).

A Claude Code plugin that runs a spec-driven, multi-agent build:

1. **`/module-pipeline:plan <spec> [run-id]`**: the current session acts as the
   Main Architect. It splits the spec into modules that each own one folder,
   writes contracts, scaffolds, per-module prompts and `tasks/task_manifest.yaml`,
   validates it, shows how many agents the run will start, and (with your yes)
   commits it on branch `multiagent-runs/<run-id>`.
2. **`/module-pipeline:run [manifest]`**: a workflow implements every pending
   module in parallel, one agent per module in an isolated worktree, in
   dependency waves. Each module is audited against its scope, committed on the
   run branch, and reviewed by a read-only reviewer; then the build and test
   commands run on the run branch.
3. **`/module-pipeline:integrate [manifest]`**: an integration agent writes the
   glue code, diagnostics run, and a system reviewer checks the whole result
   against the spec.
4. **`/module-pipeline:rework <run-id>`**: the Main Architect decides every
   failure and blocking review item and writes the next run's manifest.
5. **`/module-pipeline:status [run-id]`**: where every run stands.
6. **`/module-pipeline:finish <run-id> [base]`**: summarizes the run branch
   against the main branch, drafts a PR description, and merges, squashes or
   opens a PR only with your yes.
7. **`/module-pipeline:clean [run-id] [--branches]`**: removes kept worktrees,
   stale claims, merge worktrees and merged run branches, after a dry run.

## Guarantees

- **One folder, one owner.** The manifest is rejected if two modules own the
  same or nested folders, or if any other task lists a path inside a module's
  folder.
- **Write scopes are enforced while agents work.** A `PreToolUse` hook blocks
  Edit/Write/MultiEdit/NotebookEdit by pipeline agents outside their task's
  allowed files, and blocks every write until the agent has claimed its
  worktree. A `PostToolUse` hook checks the worktree after every shell command
  and tells the agent about out-of-scope files so it can undo them. Whatever is
  still out of scope at merge time is caught by the audit: the module is not
  merged and its worktree is kept.
- **Generated files do not fail modules.** Files matching `generated_files`
  (such as Godot `.uid` and `.import` files) are dropped when they land outside
  a task's scope, and merged normally inside it.
- **Every accepted module is a commit** on `multiagent-runs/<run-id>`. Agents
  start from that branch's tip (claiming moves the worktree there), so later
  waves see earlier modules. Project git hooks still run; a rejected commit
  reverts the patch. Merging the run branch into your main branch happens only
  through `finish` with your yes, or by hand.
- **Your checkout stays yours.** While a run is in progress the main checkout
  may be on any branch. When it is not on the run branch, commits and
  diagnostics use a detached merge worktree under
  `.multiagent/pipeline/merge/<run-id>/`.
- **Reruns are incremental.** Merged modules are recorded in
  `.multiagent/pipeline/runs/<run-id>.json` and skipped next time.

The hooks only act on the plugin's own `module-implementer` and `integrator`
agents; other sessions and agents are never affected.

## Requirements

- Claude Code with dynamic workflows enabled (all paid plans; on Pro, turn on
  "Dynamic workflows" in `/config`).
- Node.js on `PATH`, and a git repository with `user.name`/`user.email` set.
- For agents to run your tests or build, allow those commands in the project's
  `.claude/settings.json` (for example `"Bash(npm test)"`); otherwise the
  agents are asked for permission during the run.
- Project git hooks run when modules are committed. If the main checkout is on
  another branch, they run in the merge worktree, which has no installed
  dependencies (such as `node_modules`); keep the main checkout on the run
  branch if your hooks need them.

## Install from this repository

```
/plugin marketplace add spardanviro/MultiAgentGameStudio
/plugin install module-pipeline@multiagent-system
```

## Files it writes in your project

| Path | What |
| --- | --- |
| `docs/architecture.md`, `docs/module_layout.md`, `docs/module_contracts.md` | Architect output (committed) |
| `tasks/task_manifest*.yaml`, `work/prompts/**` | Manifest and per-module prompts (committed) |
| `work/modules/<id>/module_report.md`, `interface_request.md` | Written by module agents (committed with the module) |
| `.multiagent/pipeline/` | Run state, worktree claims, patches, merge worktrees, result JSON, reports, PR drafts (git-ignored) |

## Development

```
npm test
```

The workflow tests run both workflow scripts with emulated runtime globals:
the ops agent executes the real CLI, and stand-in implementers act on real git
worktrees, so everything except the language models is exercised end to end.
