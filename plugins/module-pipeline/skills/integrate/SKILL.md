---
name: integrate
description: After every module is merged, write the integration glue in an isolated worktree, commit it on the run branch, run diagnostics, and review the whole system against the spec.
argument-hint: "[manifest-path]"
arguments: [manifest]
disable-model-invocation: true
---

# Run the integration stage

Manifest: `$manifest` (if empty, use `tasks/task_manifest.yaml`). Resolve it
to an absolute path; call that MANIFEST below.

## 1. Check before launching

Read `.multiagent/pipeline/runs/<runId>-modules-result.json` if it exists
(run id from the manifest). If its status is not `passed`, tell the user
which blocking items or failures are open and ask whether to integrate
anyway. Stop unless they say yes.

Make sure nothing outside `.multiagent/` and `.claude/worktrees/` is
uncommitted (`git status --porcelain`); if something is, handle it as
/module-pipeline:run does: ask, and commit only with a yes via
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" commit-planning "MANIFEST"`.

## 2. Launch the workflow

This command invocation is the user's authorization:

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/integrate-system.js",
  args: { pluginRoot: "${CLAUDE_PLUGIN_ROOT}", manifest: "MANIFEST" }
})
```

## 3. Record and report

Write the result verbatim as JSON to
`.multiagent/pipeline/runs/<runId>-integration-result.json`, and a readable
report to `.multiagent/pipeline/runs/<runId>-integration-report.md`: the
integration outcome, diagnostics, the spec coverage table, and the system
reviewer's `rework_items` as a YAML block.

Tell the user the status:

- `passed`: the run branch `multiagent-runs/<runId>` is ready for them to
  review and merge. Do not merge it yourself.
- `rework_required`, `integration_failed`, `diagnostics_failed`,
  `review_missing`: summarize what is open; next step
  `/module-pipeline:rework <runId>`.
- `blocked`: the prepare errors.
