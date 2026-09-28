---
name: status
description: Show module-pipeline runs in this project - task outcomes, diagnostics, open worktree claims, and the suggested next step.
argument-hint: "[run-id]"
arguments: [run]
disable-model-invocation: true
model: opus
effort: medium
---

Run (add `--run $run` if a run id was given):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" status
```

Summarize for the user, per run: branch, each task's status (merged,
violation, merge_failed, unclaimed, empty), diagnostics (compile errors and
whether tests failed), and any active claims (worktrees still waiting to be
merged or inspected). Say which branch the main checkout is on. Mention the
result files in `.multiagent/pipeline/runs/` if they exist, and suggest the
next command:

- modules pending or failed: `/module-pipeline:run <manifest>` or
  `/module-pipeline:rework <run-id>`
- all modules merged and an integration section exists but is not merged:
  `/module-pipeline:integrate <manifest>`
- everything merged: `/module-pipeline:finish <run-id>`
- leftover claims or worktrees from finished runs: `/module-pipeline:clean`
