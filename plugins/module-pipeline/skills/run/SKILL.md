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
to an absolute path; call that MANIFEST below. The file need not be in the
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
and how many agents that starts at which thinking effort (`estimate.run`;
every agent runs on `estimate.model`). Mention that they may switch the main
checkout to another branch and keep working while it runs. This command
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

Statuses of the module stage: `passed` (every module merged, no blocking
review item, diagnostics clean), `rework_required` (blocking review items),
`modules_failed` (a module did not merge: `violation` lists files written
outside its scope and keeps its worktree; `error` means an agent did not
return, and `CLI status --run <runId>` shows whether it merged anyway),
`diagnostics_failed`, `blocked` (prepare errors).

Statuses of a patch run: `passed`, `patch_too_large` (over its line limit,
nothing merged, worktree kept; the next rework takes the module path),
`patch_failed`, `rework_required`, `diagnostics_failed`, `review_missing`.
