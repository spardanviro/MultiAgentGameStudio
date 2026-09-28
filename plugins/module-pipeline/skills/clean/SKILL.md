---
name: clean
description: Remove module-pipeline leftovers - worktrees kept for inspection, stale worktree claims, merge worktrees, and (optionally) run branches already merged into the main branch.
argument-hint: "[run-id] [--branches]"
disable-model-invocation: true
model: opus
effort: medium
---

# Clean up after pipeline runs

Arguments: `$ARGUMENTS`. A word starting with `--` is a flag; any other word
is the run id filter. With no run id every run is covered; a run id also
covers its rework runs, so `run-001` includes `run-001-r1`. Include merged
run branches only if `--branches` was given.

Do not clean while a `/module-pipeline:run` or `/module-pipeline:integrate`
workflow is still running in this project: its worktrees would be removed
under the agents. If `/workflows` shows one running, stop and say so.

## 1. Dry run

Build the command:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" clean --dry-run [--run <run>] [--branches]
```

Show the user what it would remove:

- **Kept worktrees and claims** (`claims`): worktrees kept after a
  `violation` or `merge_failed`, and claims whose worktree is already gone.
  Removing them deletes the rejected agent work in them for good; mention any
  the user may still want to inspect, with their paths.
- **Merge worktrees** (`mergeWorktrees`): detached checkouts the pipeline
  used while the main checkout was on another branch. Nothing is lost.
- **Run branches** (`branches.deleted`), only with `--branches`: run branches
  already merged into `branches.into`. `branches.kept` lists the ones left
  alone and why (not merged yet, or checked out somewhere).

If there is nothing to remove, say so and stop.

## 2. Confirm and clean

Ask the user to confirm. Only with a yes, run the same command without
`--dry-run`, and report what was removed. Run branches are deleted with
`git branch -d`, so git itself refuses any branch that is not fully merged.
