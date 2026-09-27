# module-pipeline

A Claude Code plugin that runs a spec-driven, multi-agent build:

1. **`/module-pipeline:plan <spec> [run-id]`**: the current session acts as the
   Main Architect. It splits the spec into modules that each own one folder,
   writes contracts, scaffolds, per-module prompts and `tasks/task_manifest.yaml`,
   validates it, and (with your yes) commits it on branch `multiagent-runs/<run-id>`.
2. **`/module-pipeline:run [manifest]`**: a workflow implements every pending
   module in parallel, one agent per module in an isolated worktree, in
   dependency waves. Each module is audited against its scope, committed on the
   run branch, and reviewed by a read-only reviewer.
3. **`/module-pipeline:integrate [manifest]`**: an integration agent writes the
   glue code, diagnostics run, and a system reviewer checks the whole result
   against the spec.
4. **`/module-pipeline:rework <run-id>`**: the Main Architect decides every
   failure and blocking review item and writes the next run's manifest.
5. **`/module-pipeline:status [run-id]`**: where every run stands.

## Guarantees

- **One folder, one owner.** The manifest is rejected if two modules own the
  same or nested folders, or if any other task lists a path inside a module's
  folder.
- **Write scopes are enforced while agents work.** A `PreToolUse` hook blocks
  Edit/Write/MultiEdit/NotebookEdit by pipeline agents outside their task's
  allowed files, and blocks every write until the agent has claimed its
  worktree. Writes made through the shell are caught by the audit before
  merge: an out-of-scope module is not merged and its worktree is kept.
- **Every accepted module is a commit** on `multiagent-runs/<run-id>`, and
  later waves start from that branch, so they see earlier modules. Project git
  hooks still run; a rejected commit reverts the patch. Merging the run branch
  into your main branch is left to you.
- **Agents only see committed work.** Runs refuse to start while the project
  has uncommitted changes (outside `.multiagent/` and `.claude/worktrees/`,
  which are added to `.git/info/exclude`).
- **Reruns are incremental.** Merged modules are recorded in
  `.multiagent/pipeline/runs/<run-id>.json` and skipped next time.

The hook only acts on the plugin's own `module-implementer` and `integrator`
agents; other sessions and agents are never affected.

## Requirements

- Claude Code with dynamic workflows enabled (all paid plans; on Pro, turn on
  "Dynamic workflows" in `/config`).
- Node.js on `PATH`, and a git repository with `user.name`/`user.email` set.
- For agents to run your tests or build, allow those commands in the project's
  `.claude/settings.json` (for example `"Bash(npm test)"`); otherwise the
  agents are asked for permission during the run.

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
| `.multiagent/pipeline/` | Run state, worktree claims, patches, result JSON and reports (git-ignored) |

## Development

```
node --test plugins/module-pipeline/test/
```

The workflow tests run both workflow scripts with emulated runtime globals:
the ops agent executes the real CLI, and stand-in implementers act on real git
worktrees, so everything except the language models is exercised end to end.
