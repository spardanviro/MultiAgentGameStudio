---
name: run
description: Implement every pending module of a task manifest in parallel isolated worktrees, commit in-scope work on the run branch, review each module, report the gate, and go straight on to the integration when it passes.
argument-hint: "[manifest-path] [--modules-only]"
disable-model-invocation: true
model: opus
effort: medium
---

# Run the module stage

Arguments: `$ARGUMENTS`. A word starting with `--` is a flag; the other word
is the manifest (if there is none, use `tasks/task_manifest.yaml`). Resolve it
to an absolute path; call that MANIFEST below. `--modules-only` stops after
the module stage instead of going on to the integration (step 4). The file need not be in the
working tree: when the main checkout is on another branch, the CLI reads it
from the run branch. CLI below means
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs"`.

Every call you make carries the whole conversation, so keep this stage to the
few calls below. The CLI checks the project, runs the diagnostics and writes
the result and the report; do not repeat its work with git or file commands,
and do not read the result files back.

## 1. Prepare

Run `CLI prepare "MANIFEST"` from the project root. It validates the manifest,
checks the session and the checkout, and returns what the workflow needs.

- `ok: false` with `uncommitted` files: list them and ask the user whether to
  commit them as planning output. Only with a yes, run
  `CLI commit-planning "MANIFEST"`, then prepare again. Without a yes, stop:
  agents start from the run branch and would not see them.
- `ok: false` with `readOnly` paths: the sandbox keeps the main checkout
  read-only while it is on the run branch. Show the error and stop: the user
  switches the main checkout to another branch from their own terminal (a
  sandboxed `git switch` cannot change those files) and runs this again.
- Any other error (the session is not in the project, a missing prompt, an
  incomplete rules file, a manifest error): show it and stop (status
  `blocked`). Do not `cd` elsewhere to work around it; Claude Code creates the
  agents' worktrees from the session's repository.
- `warnings` (for example a module count that does not fit the project size):
  show them and ask whether to continue anyway.

## 2. Launch the workflow

Tell the user in two or three lines how many modules run in how many waves,
and how many agents that starts on which model at which thinking effort
(`estimate.run`). When `estimate.integrate` is not empty and
`--modules-only` was not given, add that the integration (those agents)
starts by itself if the module stage passes. Mention that they may switch the
main checkout to another branch and keep working while it runs. This command
invocation is the user's authorization. Start the workflow with the
`workflowScript` and `workflowArgs` from the prepare output, exactly as
printed:

```
Workflow({
  scriptPath: <workflowScript from prepare>,
  args: <workflowArgs from prepare>
})
```

Each module runs in its own isolated worktree and may only write inside its
own folder. Its reviewer then audits and commits it on branch
`multiagent-runs/<run-id>` and reviews it read-only. A rerun skips modules
that are already merged. Modules listed in `resumable` were finished by
their implementer before an earlier invocation was interrupted; they go
straight to their reviewer, so say so instead of counting an implementer
for them.

**Patch manifests.** When prepare reports `mode: patch` (a small rework
written by `/module-pipeline:rework`), tell the user the patch starts 2
agents (a patcher and a reviewer) and its line limit, then start the
workflow the same way.

## 3. Record and report

When the workflow finishes, its completion notice names an output file. Run:

```
CLI record --from "<that output file>"
```

(If there is no output file, write the object the workflow returned to a
file under `.multiagent/pipeline/runs/` and pass that.) For the module stage
it runs the diagnostics on the run branch; for every stage it writes
`<runId>-<stage>-result.json` and `<runId>-<stage>-report.md` under
`.multiagent/pipeline/runs/` and prints the summary.

Tell the user, briefly, from that output alone:

- A table of modules with their status (for a patch: the merge status and
  changed lines).
- `status`, the `diagnostics` line, and the blocking `items` (id, module,
  one line each). Say where the full report is (`reportPath`).
- `size`, when present: the source lines built against the plan's estimate.
- `strayChanges`, when present: files left uncommitted in the main checkout
  that no pipeline merge wrote (a build or test command, an agent's shell,
  or the user's own edits). List them and ask the user to look; do not
  delete or commit them yourself.
- The next step: `nextCommand`. For anything other than `passed` that is
  `/module-pipeline:rework <runId>`; do not fix module code yourself here.
  When the output has `continueWith`, the next step is step 4 instead.

Statuses of the module stage: `passed` (every module merged, no blocking
review item, diagnostics clean), `rework_required` (blocking review items),
`modules_failed` (a module did not merge: `violation` lists files written
outside its scope and keeps its worktree; `error` means an agent did not
return, and `CLI status --run <runId>` shows whether it merged anyway),
`diagnostics_failed`, `blocked` (prepare errors).

Statuses of a patch run: `passed`, `patch_too_large` (over its line limit,
nothing merged, worktree kept; the next rework takes the module path),
`patch_failed`, `rework_required`, `diagnostics_failed`, `review_missing`.

## 4. Go on to the integration

Only when the record output has `continueWith` and `--modules-only` was not
given. `continueWith` is there when the module stage passed, the manifest has
an integration stage and its checks found nothing to ask about; the CLI has
already made them, so do not run prepare again. Keep the report of step 3 to
the module table and one line, then start the integration with what
`continueWith` holds, exactly as printed:

```
Workflow({
  scriptPath: <continueWith.workflowScript>,
  args: <continueWith.workflowArgs>
})
```

The integrator writes the glue in an isolated worktree. The system reviewer
then commits it on the run branch, runs diagnostics, reviews the whole
result against the spec, and audits every cross-module rule.

When it finishes, run `CLI record --from "<its output file>"` again and tell
the user from that output alone: `status`, the `diagnostics` line,
`ruleViolations` and `coverageGaps` if any, the blocking `items` (one line
each), where the report is, `strayChanges` if any, and `nextCommand`
(`/module-pipeline:finish <runId>` when it passed, otherwise
`/module-pipeline:rework <runId>`). Do not merge the run branch yourself here.

Without `continueWith` after a passed module stage (stray changes, or
`--modules-only`), the user starts the integration with `nextCommand`.
