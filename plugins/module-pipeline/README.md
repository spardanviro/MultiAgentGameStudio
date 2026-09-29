# module-pipeline

The full guide (walkthrough, manifest reference, statuses, troubleshooting) is
in the [repository README](../../README.md).

A Claude Code plugin that runs a spec-driven, multi-agent build:

1. **`/module-pipeline:plan <spec> [run-id]`**: the current session acts as the
   Main Architect. It sizes the project, designs a shared layer and splits the
   rest of the spec into modules that each own one folder, writes contracts,
   project conventions, scaffolds, per-module prompts and
   `tasks/task_manifest.yaml`, validates it, shows how many agents the run will
   start, and (with your yes) commits it on branch `multiagent-runs/<run-id>`.
2. **`/module-pipeline:run [manifest]`**: a workflow implements every pending
   module in parallel, one agent per module in an isolated worktree, in
   dependency waves. Each module's reviewer audits it against its scope,
   commits it on the run branch and reviews it read-only; then the build and
   test commands run on the run branch.
3. **`/module-pipeline:integrate [manifest]`**: an integration agent writes the
   glue code; the system reviewer commits it, runs diagnostics and checks the
   whole result against the spec.
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
- **One shared layer.** With two or more modules the manifest must name the
  shared layer: helpers, constants, theme values and test fixtures that more
  than one module needs. Its module is built first and every other module
  depends on it, so agents import it instead of each writing their own copy.
- **Module count fits the project size.** `project.estimated_lines` lets
  validate warn when a run has too many small modules (each one costs a full
  agent session and a review) or too few large ones.
- **Reruns are incremental.** Merged modules are recorded in
  `.multiagent/pipeline/runs/<run-id>.json` and skipped next time.

The hooks only act on the plugin's own `module-implementer` and `integrator`
agents; other sessions and agents are never affected.

## Model and thinking effort

Every agent runs on the strongest model (`opus`, always the newest Opus).
Roles differ only in thinking effort, set per role in the manifest:

```yaml
effort:
  preset: balanced          # economy | balanced | quality
  module_implementer: medium
  module_reviewer: medium
  integrator: medium
  system_reviewer: high
```

A module's own `effort` overrides `module_implementer` for that module. See
[manifest-schema.md](skills/plan/manifest-schema.md) for the preset table.

## Lean agents

The Main Architect is your own session. Every other agent has one narrow job
and starts lean:

- **No CLAUDE.md files.** The implementer, reviewers and integrator are
  defined with `omitClaudeMd: true`, so your global and project CLAUDE.md and
  rules are not loaded into each of them. The Main Architect copies the rules
  that matter for the code into `docs/conventions.md`, which they read.
- **No relay agents.** Your session runs `prepare` and the module-stage
  diagnostics itself; each module's reviewer runs its merge; the system
  reviewer commits the glue and runs the integration diagnostics.
- **Short prompts.** A workflow prompt only names the task; `claim` and the
  merge command print the task details to the agent that needs them.

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
/plugin marketplace add spardanviro/module-pipeline
/plugin install module-pipeline@multiagent-system
```

## What this plugin runs, reads and writes

Everything the plugin does happens on your machine, inside the project you run
it in. It has no server, sends no telemetry, and makes no network requests of
its own.

### Programs it starts

- **`node <plugin>/scripts/pipeline.mjs <command>`**, the pipeline CLI. The
  skills run it from your session; inside the workflows the implementers and
  the integrator run `claim`, the module reviewers run `integrate-task`, and
  the system reviewer runs `integrate-task` and `diagnostics`. Its only child
  processes are `git` (below) and the two commands you put in the manifest.
- **`git`** in the project, for these subcommands: `status`, `diff`, `log`,
  `ls-files`, `rev-parse`, `rev-list`, `merge-base`, `config` (reading your
  identity only), `switch -c` (creating the run branch), `add`, `commit`,
  `apply` (applying a module's audited patch), `update-ref` (moving the run
  branch), `branch` (listing; deleting agent branches and, in `clean`, run
  branches), `worktree add/list/prune/remove`, and `checkout`, `reset --hard`
  and `clean -fd` **only inside the plugin's own merge worktree** under
  `.multiagent/pipeline/merge/`.
- **Your `diagnostics.compile_command` and `diagnostics.test_command`**, exactly
  as written in the manifest, in a checkout of the run branch.
- **Claude Code agents** started by the workflows, all on the `opus` model:
  one implementer and one reviewer per module, an integrator and a system
  reviewer. They use Claude Code's normal
  tools under your permission settings; implementers and the integrator also
  run your project's build and tests.

### Hooks it installs

Both hooks run `node "${CLAUDE_PLUGIN_ROOT}/scripts/scope-hook.mjs"` and act
only on this plugin's own `module-implementer` and `integrator` agents. For
every other session and agent they exit immediately and change nothing.

- **`PreToolUse` on Edit, Write, MultiEdit and NotebookEdit**: reads the
  agent's claim file in `.multiagent/pipeline/claims/` and denies a write
  outside the files its task may change, or any write before the agent has
  claimed its worktree.
- **`PostToolUse` on Bash**: runs `git diff --name-only` and
  `git ls-files --others` in the agent's worktree and tells the agent about
  files it left outside its scope. It never blocks or changes the command.

### Files and branches it writes

| What | Where | In git? |
| --- | --- | --- |
| Architect output (written by your session in `plan` / `rework`) | `docs/`, `tasks/task_manifest*.yaml`, `work/prompts/**`, `reports/rework/` | committed on the run branch after you confirm |
| Module and integration reports | `work/modules/<id>/`, `work/integration/` | committed with the module |
| One branch per run, one commit per accepted module | `multiagent-runs/<run-id>` | yes; your main branch is only touched by `finish`, after you pick merge or squash |
| Run state, claims, patches, reports, diagnostics logs, PR drafts, merge worktree | `.multiagent/pipeline/` | no; added to `.git/info/exclude` |
| Two exclude lines | `.git/info/exclude` | no |
| Agent worktrees (created and locked by Claude Code, removed by the plugin after merging) | `.claude/worktrees/` | no |

### What it deletes

- An agent's worktree and branch, after its work is committed on the run
  branch or found empty. A worktree whose work was rejected for writing out of
  scope is kept for you to inspect.
- With `/module-pipeline:clean`, and only after showing a dry run and getting
  your confirmation: kept worktrees, stale claims, merge worktrees, and (with
  `--branches`) run branches already merged into your main branch, using
  `git branch -d`, which refuses unmerged branches.

### Pushing and pull requests

Nothing is pushed by default. `/module-pipeline:finish` offers
`git push -u origin <run branch>` and `gh pr create` as one of its choices,
and runs them only when you pick that choice and confirm the remote.

### Dependencies

None to install. `scripts/vendor/js-yaml.mjs` is a vendored copy of
[js-yaml](https://github.com/nodeca/js-yaml) 4.2.0 (MIT, license alongside it).

## Development

```
npm test
```

The workflow tests run both workflow scripts with emulated runtime globals:
stand-in implementers act on real git worktrees and stand-in reviewers run the
real merge and diagnostics commands, so everything except the language models
is exercised end to end.
