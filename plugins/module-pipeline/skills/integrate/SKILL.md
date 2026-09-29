---
name: integrate
description: After every module is merged, write the integration glue in an isolated worktree, commit it on the run branch, run diagnostics, and review the whole system against the spec.
argument-hint: "[manifest-path]"
arguments: [manifest]
disable-model-invocation: true
model: opus
effort: medium
---

# Run the integration stage

Manifest: `$manifest` (if empty, use `tasks/task_manifest.yaml`). Resolve it
to an absolute path; call that MANIFEST below. CLI below means
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs"`.

## 1. Check before launching

Read `.multiagent/pipeline/runs/<runId>-modules-result.json` if it exists
(run id from the manifest). If its status is not `passed`, tell the user
which blocking items or failures are open and ask whether to integrate
anyway. Stop unless they say yes.

Check that `git rev-parse --show-toplevel` is the project root (the folder
above the manifest's `tasks/`); agent worktrees come from the session's
repository. If not, stop and ask the user to move the session there. Do not
`cd` elsewhere until the workflow finishes.

If the current branch is the run branch, make sure nothing outside
`.multiagent/` and `.claude/worktrees/` is uncommitted
(`git status --porcelain`); if something is, handle it as
/module-pipeline:run does: ask, and commit only with a yes via
`CLI commit-planning "MANIFEST"`. On any other branch, uncommitted files are
the user's own work.

## 2. Prepare and launch the workflow

Run `CLI prepare "MANIFEST" --stage integration` from the project root. If
`ok` is false, show the errors and stop (status `blocked`).

This command invocation is the user's authorization. Pass the
`workflowArgs` object from the prepare output as `args`, exactly as printed:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/integrate-system.js",
  args: <workflowArgs from prepare>
})
```

The integrator writes the glue in an isolated worktree. The system reviewer
then commits it on the run branch, runs diagnostics, and reviews the whole
result against the spec.

## 3. Record and report

Write the result as JSON to
`.multiagent/pipeline/runs/<runId>-integration-result.json`, and a readable
report to `.multiagent/pipeline/runs/<runId>-integration-report.md`: the
integration outcome, diagnostics (the full result is in the run state, see
`CLI status --run <runId>`, and in the log file it names), the spec coverage
table, and the system reviewer's `rework_items` as a YAML block.

Tell the user the status:

- `passed`: the run branch `multiagent-runs/<runId>` is ready. Next:
  `/module-pipeline:finish <runId>` to review and merge it. Do not merge it
  yourself here.
- `rework_required`, `integration_failed`, `diagnostics_failed`,
  `review_missing`: summarize what is open; next step
  `/module-pipeline:rework <runId>`.
- `blocked`: the prepare errors.
