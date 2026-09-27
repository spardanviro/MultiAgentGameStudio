---
name: run
description: Implement every pending module of a task manifest in parallel isolated worktrees, commit in-scope work on the run branch, review each module, and report the gate.
argument-hint: "[manifest-path]"
arguments: [manifest]
disable-model-invocation: true
---

# Run the module stage

Manifest: `$manifest` (if empty, use `tasks/task_manifest.yaml`). Resolve it
to an absolute path; call that MANIFEST below.

## 1. Check before launching

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" validate "MANIFEST"
```

If it fails, show the errors and stop.

Then run `git status --porcelain`. If anything outside `.multiagent/` and
`.claude/worktrees/` is uncommitted, list it and ask the user whether to
commit it as planning output. Only with a yes, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" commit-planning "MANIFEST"`.
Without a yes, stop: agents start from the last commit and would not see it.

## 2. Launch the workflow

Tell the user how many modules will run and in how many waves (from the
validate output), then start the workflow. This command invocation is the
user's authorization:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/implement-modules.js",
  args: { pluginRoot: "${CLAUDE_PLUGIN_ROOT}", manifest: "MANIFEST" }
})
```

Each module runs in its own isolated worktree and may only write inside its
own folder. Each finished module is audited, committed on branch
`multiagent-runs/<run-id>`, and reviewed by a read-only reviewer. A rerun
skips modules that are already merged.

## 3. Record and report

When the workflow returns, write its result verbatim as JSON to
`.multiagent/pipeline/runs/<runId>-modules-result.json`, and a readable
report to `.multiagent/pipeline/runs/<runId>-modules-report.md` with, per
module: status, commit, tests the implementer ran, interface requests, and
the reviewer's `rework_items` as a YAML block. Both paths are git-ignored.

Then tell the user, briefly:

- A table of modules with their status.
- `status` and what it means:
  - `passed`: every module merged, no blocking review item, diagnostics clean.
    Next: `/module-pipeline:integrate MANIFEST` (if the manifest has an
    integration section), or review and merge the run branch.
  - `rework_required`: blocking review items (list them).
  - `modules_failed`: modules that did not merge, with the reason. A
    `violation` lists the files written outside scope; its worktree is kept
    for inspection.
  - `diagnostics_failed`: the first compile errors.
  - `blocked`: the prepare errors.
- For anything other than `passed`, the next step is
  `/module-pipeline:rework <runId>`. Do not fix module code yourself here.
