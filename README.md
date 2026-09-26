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
- Start Claude Code background agents with `claude --bg`.
- Sync status with `claude agents --json --all`.
- Inspect each node's prompt, allowed files, reports, diff, and policy violations.
- Open an embedded terminal drawer for `claude attach <id>` or `claude logs <id>`.
- Audit changed files after each agent finishes.
- Generate a patch for compliant work and apply it to the main project only when Apply Patch is clicked.
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
9. Send diagnostics reports back through the Main Architect before module review, integration, or system review.

The Main Architect creates the dispatch package from the supplied spec. It does not convert rough design notes into a spec and does not launch child agents itself.

## Manifest

The architect writes:

```text
tasks/task_manifest.yaml
```

Every module task must declare:

- `owned_script`
- `test_file`
- `prompt_file`
- `module_report`
- `interface_request`
- `allowed_files`

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
- Worktree base is the current local `HEAD`.
- The main project is changed only when Apply Patch succeeds.
- Accepted worktrees are kept by default and can be removed with Clean Accepted Worktrees.
- The main agent plans, dispatches, and makes decisions. Module review, integration, and system review are separate agents.
