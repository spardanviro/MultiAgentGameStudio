---
name: run
description: Implement every pending module of a task manifest in parallel isolated worktrees, commit in-scope work on the run branch, review each module, and report the gate.
argument-hint: "[manifest-path]"
arguments: [manifest]
disable-model-invocation: true
model: opus
effort: medium
---

# Run the module stage

Manifest: `$manifest` (if empty, use `tasks/task_manifest.yaml`). Resolve it
to an absolute path; call that MANIFEST below. CLI below means
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs"`.

## 1. Check before launching

Run `CLI validate "MANIFEST"`. If it fails, show the errors and stop. Show
any `warnings` (for example a module count that does not fit the project
size) and ask whether to continue anyway.

Then check where the session is: `git rev-parse --show-toplevel` must be the
`projectRoot` from the validate output. Claude Code creates the agents'
worktrees from the session's repository, so if it differs, stop and ask the
user to move the session into the project folder. From here until the
workflow finishes, do not `cd` anywhere else in the shell.

Then check the checkout. If the current branch is the run branch
`multiagent-runs/<runId>` (or that branch does not exist yet), run
`git status --porcelain`; if anything outside `.multiagent/` and
`.claude/worktrees/` is uncommitted, list it and ask the user whether to
commit it as planning output. Only with a yes, run
`CLI commit-planning "MANIFEST"`. Without a yes, stop: agents start from the
run branch and would not see it. If the main checkout is on another branch,
its uncommitted files are the user's own work; leave them alone.

## 2. Prepare and launch the workflow

Run `CLI prepare "MANIFEST"` from the project root. If `ok` is false, show
the errors and stop (status `blocked`).

Tell the user how many modules will run, in how many waves, and how many
agents that starts with which thinking effort (from `estimate.run` in the
validate output; every agent runs on `estimate.model`), then start the
workflow. Mention that they may switch the main checkout to another branch
and keep working while it runs. This command invocation is the user's
authorization. Pass the `workflowArgs` object from the prepare output as
`args`, exactly as printed:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/implement-modules.js",
  args: <workflowArgs from prepare>
})
```

Each module runs in its own isolated worktree and may only write inside its
own folder. Its reviewer then audits and commits it on branch
`multiagent-runs/<run-id>` and reviews it read-only. A rerun skips modules
that are already merged.

**Patch manifests.** When validate reports `mode: patch` (a small rework
written by `/module-pipeline:rework`), tell the user the patch starts 2
agents (a patcher and a reviewer, from `estimate.run`) and its line limit,
then start `${CLAUDE_PLUGIN_ROOT}/workflows/patch-run.js` with the same
`workflowArgs`. Skip step 3: the patch reviewer already ran the diagnostics.
In step 4 use `<runId>-patch-result.json` and `<runId>-patch-report.md`
(items, what the patcher changed, the merge, the diagnostics, the
reviewer's `rework_items`), and these statuses:

- `passed`: every item resolved, diagnostics clean. Next:
  `/module-pipeline:finish <runId>`.
- `patch_too_large`: the patch changed more lines than its limit; nothing
  was merged and its worktree is kept. Next: `/module-pipeline:rework <runId>`,
  which then takes the module path.
- `patch_failed` (with the merge status and reason), `rework_required`,
  `diagnostics_failed`, `review_missing`: next `/module-pipeline:rework <runId>`.

## 3. Diagnostics

When the workflow returns and at least one module merged in this or an
earlier invocation, run `CLI diagnostics --run <runId>`. Add its output to
the result as `diagnostics`. If the workflow status is `passed` and
diagnostics `failed` is true, change the status to `diagnostics_failed`.

## 4. Record and report

Write the result as JSON to
`.multiagent/pipeline/runs/<runId>-modules-result.json`, and a readable
report to `.multiagent/pipeline/runs/<runId>-modules-report.md` with, per
module: status, commit, tests the implementer ran, interface requests,
generated files that were dropped, and the reviewer's `rework_items` as a
YAML block, plus the diagnostics (compile errors and the test result). Both
paths are git-ignored.

Then tell the user, briefly:

- A table of modules with their status.
- `status` and what it means:
  - `passed`: every module merged, no blocking review item, diagnostics clean.
    Next: `/module-pipeline:integrate MANIFEST` (if the manifest has an
    integration section), or `/module-pipeline:finish <runId>`.
  - `rework_required`: blocking review items (list them).
  - `modules_failed`: modules that did not merge, with the reason. A
    `violation` lists the files written outside scope; its worktree is kept
    for inspection. `error` means an agent did not return; `CLI status --run
    <runId>` shows whether its module merged anyway.
  - `diagnostics_failed`: the first compile errors, or the failing test
    command and the tail of its output.
  - `blocked`: the prepare errors.
- For anything other than `passed`, the next step is
  `/module-pipeline:rework <runId>`. Do not fix module code yourself here.
