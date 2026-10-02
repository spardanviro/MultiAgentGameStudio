---
name: finish
description: Wrap up a module-pipeline run - summarize the run branch against the main branch, draft a PR description, and merge or open a PR only with the user's explicit yes.
argument-hint: "<run-id> [base-branch]"
arguments: [run, base]
disable-model-invocation: true
model: opus
effort: medium
---

# Finish run $run

## 1. Summarize

Run (add `--base $base` if a base branch was given):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" finish --run $run
```

Use the last rework run of the chain (for example `run-001-r2`, not
`run-001`): its branch holds everything. If `runs` in the output shows a
later rework run than `$run`, point that out and suggest finishing that one
instead.

Tell the user:

- The run branch, the base branch, how many commits it adds, and the
  `shortstat`.
- Every run in the chain with its task statuses and diagnostics.
- Warnings, if any:
  - `latest.integration` is missing or not `passed` (or, without an
    integration section, `latest.modules` is not `passed`; for a patch run,
    `latest.patch` is not `passed`), with the open `blockingItems`.
  - `behind` is above 0: the base branch has moved on, so merging may
    conflict. Offer to merge the base branch into the run branch first.
- The PR description draft at `prDraftPath`. Read it, tighten it into a
  readable description (what was built, per module, known gaps), and save
  your version back to the same path.

## 2. Ask what to do

Offer these, and do only the one the user picks, after an explicit yes:

1. **Merge locally, keeping the module commits:**
   `git switch <base>` then `git merge --no-ff <runBranch>`.
2. **Squash into one commit:** `git switch <base>`,
   `git merge --squash <runBranch>`, then
   `git commit -F <prDraftPath>`.
3. **Push and open a pull request:** `git push -u origin <runBranch>`, then,
   if the `gh` CLI is available, `gh pr create --base <base> --head <runBranch>
   --title "<title>" --body-file <prDraftPath>`. Pushing publishes the code, so
   confirm the remote first (`git remote -v`).
4. **Nothing for now.**

Before switching branches, look at `uncommitted` in the summary (it leaves
out the placeholder entries the Bash sandbox shows in `git status`); if the
main checkout has uncommitted work, ask the user how to handle it instead of
switching. If a merge conflicts, stop and show the conflicting files; do not
resolve conflicts on your own.

If the summary has `readOnly`, this shell cannot write those paths of the
main checkout (Claude Code's sandbox denies them). Do not run `git switch`
or `git merge` here for options 1 and 2: git would move the branch and
report success while leaving the files as they were. Print the exact
commands for the user to run in their own terminal instead, and stop there.
Option 3 changes no file in the checkout and can run here; a push from the
sandbox needs the remote's host allowed in the sandbox's network settings
(for GitHub: `github.com`, and `api.github.com` for `gh`).

Under the sandbox, with or without `readOnly`, git cannot write
`.git/config`. `git push -u` then publishes the branch and fails only at
recording the upstream: check with `git ls-remote origin <runBranch>` that
the branch arrived instead of pushing again, and give the user
`git branch --set-upstream-to=origin/<runBranch> <runBranch>` for their own
terminal. If the push is refused because the connection is blocked, do not
look for another way to reach the remote: say which host has to be allowed,
and give the user the push command for their own terminal. Do the same when
the push fails at signing in ("could not read Username/Password", "Permission
denied (publickey)", "Host key verification failed"): the sandbox cannot
start a Windows credential manager from WSL and cannot add a host key to
`~/.ssh/known_hosts`. Do not retry, and do not go looking for credentials.
A warning from `gh pr create` about uncommitted changes counts the sandbox's
placeholder entries; go by `uncommitted` in the summary instead.

## 3. Afterwards

Once the run is merged, suggest `/module-pipeline:clean <family> --branches`
(`family` in the summary: the run id without its `-r<N>` suffix, so the
branches of the whole chain are covered) to remove the run branches and
leftover worktrees.
