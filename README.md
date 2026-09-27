# Claude MultiAgent Manager

Local Electron control surface for Claude Code background-agent workflows.

项目介绍（中文）：[docs/project-introduction.md](docs/project-introduction.md)

## Current Capabilities

- Pick a git project folder.
- Choose a finished AI implementation spec and start a persistent Main Architect background agent.
- Save the architect prompt under `.multiagent/planning/<run_id>/architect_prompt.md`.
- Auto-watch `tasks/task_manifest.yaml` after planning starts.
- Import or watch a generated `tasks/task_manifest.yaml`.
- Show the persistent main agent as the root node.
- Show module agents, module review, integration glue, and system review as separate pipeline stages.
- Create one independent git worktree per background agent.
- Run every agent through the Claude Agent SDK in a detached runner process (`src/agentRunner.mjs`) that survives the app closing and reports through `.multiagent/runs/<run_id>/agents/<task_id>/status.json` and `agent.log`.
- Block out-of-scope file writes while the agent runs (SDK `PreToolUse` hook on Edit/Write/MultiEdit/NotebookEdit), with the post-run audit as a backstop for writes made through Bash.
- Resume a blocked or interrupted agent in the same Claude session.
- Inspect each node's prompt, allowed files, reports, diff, and policy violations.
- Stream an agent's log into the terminal drawer, or continue a stopped session with `claude --resume <session>` in a terminal window.
- Audit changed files after each agent finishes.
- Generate a patch for compliant work; Apply Patch (or auto-apply) commits it on the run branch `multiagent-runs/<run_id>`.
- Run terminal-based compile diagnostics and capture errors/warnings into reports for the Main Architect.
- Configure model and effort separately for main architect, module agents, review agents, integration, and system review.

## Install And Run

```bash
npm install
npm start
```

## Recommended Workflow

1. Choose the game project folder.
2. In Planning, choose the final AI implementation spec.
3. Start Main Architect.
4. Attach to the architect session if you want to answer questions or watch progress.
5. Let the app watch for `tasks/task_manifest.yaml`.
6. Review the generated docs, scaffold files, prompts, and manifest.
7. Start module agents and apply compliant patches.
8. Run Capture Diagnostics to execute the configured compile command and capture errors/warnings.
9. When a review gate or diagnostics fails, dispatch a rework round to the Main Architect (or waive the gate), review the rework manifest it writes, and import it as the next run.

The Main Architect creates the dispatch package from the supplied spec. It does not convert rough design notes into a spec and does not launch child agents itself.

## Review Gates And Rework Rounds

After a `module_review` or `system_review` patch is applied, the manager parses the `rework_items` YAML block in its report. The gate closes when any item has `blocks_integration` / `blocks_release` set or severity `critical` / `blocker`, when the report is missing, or when it has no `rework_items` block. A closed gate keeps dependent agents from starting, from Advance Workflow and from Start buttons alike.

From the main node's Rework Loop panel you can:

- **Waive** a gate or a failed diagnostics stage to continue anyway.
- **Dispatch Rework to Main Architect**: the manager writes `.multiagent/runs/<run_id>/rework/<next_run_id>_prompt.md` with the blocking items, diagnostics reports, and interface requests, then starts the architect in the background. The architect writes one of:
  - `tasks/task_manifest.<run_id>-rework-<n>.yaml` for the next run,
  - `work/requests/<next_run_id>_user_decisions.md` when it needs your decision,
  - only `reports/rework/<next_run_id>_decisions.md` when every item is deferred.
- **Import Rework Manifest** once it is ready; the new run records which run it reworks.

Auto Dispatch Rework dispatches the architect at most once per run when Advance Workflow hits a closed gate or failed diagnostics. Auto Advance keeps polling while agents or the architect are working and stops whenever a decision is needed.

## Manifest

The architect writes:

```text
tasks/task_manifest.yaml
```

Every module task owns one module folder:

```yaml
tasks:
  - id: player-health
    owned_folder: src/player/health/     # the agent may create, edit and delete files here
    test_folder: tests/player/health/    # optional, owned exclusively as well
    prompt_file: work/prompts/player-health.md
    module_report: work/modules/player-health/module_report.md
    interface_request: work/modules/player-health/interface_change_request.md
    allowed_files: []                    # extra files or folders (ending in /) outside the module
```

The owned folder, test folder, report and request are always allowed. One module folder has one owner: the manifest is rejected when two modules own nested or identical folders, or when any other task (including integration) lists a path inside a module's folder. `owned_script` is still accepted for older manifests and owns a single file.

Model routing can be configured per layer:

```yaml
defaults:
  sub_agent_model: sonnet
  sub_agent_effort: medium
  review_agent_model: opus
  review_agent_effort: high
  integration_agent_model: opus
  integration_agent_effort: high
  system_review_agent_model: opus
  system_review_agent_effort: high
```

Individual tasks may override both:

```yaml
tasks:
  - id: player-health
    model: sonnet
    effort: low
```

The app appends execution constraints to every prompt. Module agents may only edit their allowed files. If a new script is needed, the agent must write an interface change request instead of creating the script directly.

Compile diagnostics are configured in the manifest and run from the project root:

```yaml
diagnostics:
  # Set explicitly, or leave null for language/tool auto-detection.
  compile_command:
    - dotnet
    - build
  log_files: []
  include_unity_editor_log: false
  timeout_ms: 300000
```

If `compile_command` is null, the manager detects common project tooling:

- `package.json`: `npm run build`, `npm run typecheck`, or `npm test`
- `.sln` / `.csproj`: `dotnet build`
- `Cargo.toml`: `cargo check`
- `go.mod`: `go test ./...`
- `pyproject.toml` / `requirements.txt`: `python -m compileall .`
- `tsconfig.json`: `npx tsc --noEmit`

The manager writes:

```text
reports/diagnostics/<run_id>_latest.md
.multiagent/runs/<run_id>/diagnostics/latest.json
```

Optional pipeline agents:

```yaml
module_review:
  prompt_file: work/prompts/module_review.md
  review_report: reports/reviews/run-001/module_review.md
  interface_request: work/requests/module_review_request.md

integration:
  prompt_file: work/prompts/integration.md
  integration_report: work/integration/integration_report.md
  interface_request: work/requests/integration_interface_request.md
  allowed_files:
    - src/bootstrap/game_composition.gd
    - tests/integration/test_game_loop.gd
    - work/integration/integration_report.md
    - work/requests/integration_interface_request.md

system_review:
  prompt_file: work/prompts/system_review.md
  system_review_report: reports/reviews/run-001/system_review.md
  interface_request: work/requests/system_review_request.md
```

## Constraints

- V1 supports git projects only.
- Each run works on its own branch `multiagent-runs/<run_id>`, created from the current `HEAD` when the first agent starts. Rework runs branch from their parent run.
- Every applied patch is one commit on the run branch (project git hooks still run; if the commit is rejected the patch is reverted). Agent worktrees start from the run branch tip, so later agents see earlier accepted work. Merging the run branch back is up to you.
- Agents cannot see uncommitted changes, so starting agents requires a clean working tree. Commit Working Tree commits the Main Architect's scaffold, docs and prompts on the run branch.
- `.multiagent/` is added to `.git/info/exclude` so run data never shows up in `git status`.
- Accepted worktrees are kept by default and can be removed with Clean Accepted Worktrees.
- The main agent plans, dispatches, and makes decisions. Module review, integration, and system review are separate agents.
- Machine-local app data (logs, app state, provider profiles) lives in `.multiagent-manager/`; set `MULTIAGENT_MANAGER_HOME` to move it. `npm test` points it at a temp dir.
