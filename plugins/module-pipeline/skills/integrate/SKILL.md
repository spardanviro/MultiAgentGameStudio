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

Every call you make carries the whole conversation, so keep this stage to the
few calls below. The CLI checks the project and writes the result and the
report; do not repeat its work with git or file commands.

## 1. Prepare

Run `CLI prepare "MANIFEST" --stage integration` from the project root.

- `ok: false` with `uncommitted` files: handle it as /module-pipeline:run
  does: ask, and commit only with a yes via `CLI commit-planning "MANIFEST"`,
  then prepare again.
- `ok: false` with `readOnly` paths: the sandbox keeps the main checkout
  read-only while it is on the run branch. Show the error and stop: the user
  switches the main checkout to another branch from their own terminal and
  runs this again.
- Any other error (modules not merged yet, the session is not in the
  project): show it and stop (status `blocked`). Do not `cd` elsewhere.
- `modulesStatus` is not `passed`: tell the user the module stage did not
  pass (its report is `.multiagent/pipeline/runs/<runId>-modules-report.md`)
  and ask whether to integrate anyway. Stop unless they say yes.

## 2. Launch the workflow

This command invocation is the user's authorization. Start the workflow with
the `workflowScript` and `workflowArgs` from the prepare output, exactly as
printed:

```
Workflow({
  scriptPath: <workflowScript from prepare>,
  args: <workflowArgs from prepare>
})
```

The integrator writes the glue in an isolated worktree. The system reviewer
then commits it on the run branch, runs diagnostics, reviews the whole
result against the spec, and audits every cross-module rule.

## 3. Record and report

When the workflow finishes, its completion notice names an output file. Run:

```
CLI record --from "<that output file>"
```

(If there is no output file, write the object the workflow returned to a
file under `.multiagent/pipeline/runs/` and pass that.) It writes
`<runId>-integration-result.json` and `<runId>-integration-report.md` (the
integration outcome, diagnostics, spec coverage, the seam audit and the
rework items) under `.multiagent/pipeline/runs/` and prints the summary.

Tell the user, briefly, from that output alone: `status`, the `diagnostics`
line, `ruleViolations` if any, the blocking `items` (one line each), where
the report is, and the next step (`nextCommand`):

- `passed`: the run branch `multiagent-runs/<runId>` is ready for
  `/module-pipeline:finish <runId>`. Do not merge it yourself here.
- `rework_required` (blocking items; or, even without one, a violated
  cross-module rule or a feature in `coverageGaps` that the review found
  partial or missing and not deferred), `integration_failed`,
  `diagnostics_failed`, `review_missing`: `/module-pipeline:rework <runId>`.

If the output has `strayChanges`, list them: files left uncommitted in the
main checkout that no pipeline merge wrote (a build or test command, an
agent's shell, or the user's own edits). Ask the user to look at them; do
not delete or commit them yourself.
