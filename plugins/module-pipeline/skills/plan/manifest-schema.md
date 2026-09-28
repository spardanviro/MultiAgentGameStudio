# Task manifest schema (tasks/task_manifest.yaml)

Paths are relative to the project root. A folder entry ends with `/`.

```yaml
version: 1
project:
  name: Card Game
  spec: docs/spec.md              # the implementation spec, inside the repo
run:
  id: run-001                     # letters, digits, . _ - ; becomes branch multiagent-runs/run-001
  goal: One-sentence goal of this run
effort:                           # thinking effort per role: low | medium | high | xhigh | max
  preset: balanced                # economy | balanced | quality (default balanced); roles below override it
  module_implementer: medium      # one agent per module
  module_reviewer: medium         # one read-only reviewer per merged module
  integrator: medium              # writes the glue code
  system_reviewer: high           # reviews the integrated result against the spec
  pipeline_ops: medium            # relays pipeline CLI commands
diagnostics:
  compile_command: ["dotnet", "build"]   # argv list or a shell string; null if none
  test_command: ["dotnet", "test"]       # full test suite after modules merge; null if none
  timeout_ms: 300000                     # per command
generated_files:                  # tool output that may appear outside a task's scope
  - "*.uid"                       # file-name pattern ("*" only), matched anywhere
  - "*.import"
  - .godot/                       # a folder
tasks:
  - id: player-health             # unique; "integration" is reserved
    feature: Player health and damage
    owned_folder: src/player/health/     # REQUIRED: the one folder this module owns
    test_folder: tests/player/health/    # optional; owned exclusively too
    prompt_file: work/prompts/player-health.md
    module_report: work/modules/player-health/module_report.md          # default shown
    interface_request: work/modules/player-health/interface_request.md  # default shown
    allowed_files: []             # extra files/folders outside the module, rarely needed
    depends_on: []                # module ids whose public API this module uses
    acceptance:
      - Taking damage lowers health and emits health_changed(old, new)
      - Health never drops below 0; reaching 0 emits died once
    effort: xhigh                 # optional: this module's implementer only
integration:                      # optional glue stage, run by /module-pipeline:integrate
  prompt_file: work/prompts/integration.md
  allowed_files:
    - src/game/                   # glue/composition only, never inside a module folder
  acceptance:
    - The game starts, spawns the player and enemies, and the HUD tracks health
  effort: xhigh                   # optional: same as effort.integrator
```

## Model and thinking effort

Every agent runs on the strongest model (`opus`, which always resolves to the
newest Opus). Roles differ only in how hard they think. There is no `model`
field; a manifest that sets one is rejected.

| Preset | module_implementer | module_reviewer | integrator | system_reviewer | pipeline_ops |
| --- | --- | --- | --- | --- | --- |
| `economy` | low | low | low | medium | low |
| `balanced` (default) | medium | medium | medium | high | medium |
| `quality` | high | high | high | xhigh | medium |

Precedence, highest first: a task's own `effort`, the role under `effort:`,
the preset. The first command of each workflow (reading the manifest) runs at
`medium`, the default `pipeline_ops` effort, because the manifest has not been
read yet.

The Main Architect is the session running `/module-pipeline:plan` and
`/module-pipeline:rework`; those skills run on opus at `high` effort. The other
skills (`run`, `integrate`, `status`, `finish`, `clean`) only orchestrate and
run at `medium`.

## Generated files

Engines and tools write files nobody asked for: Godot's `.uid` and `.import`
files, caches, build output. A generated file inside a task's own scope is
merged like any other file (Godot `.uid` files belong in git). One outside the
task's scope is dropped from the merge instead of rejecting the whole module.
List only files that really are machine-written; anything listed here can
never cause a scope violation.

## Rules the validator enforces

- Every module task has an `owned_folder` (legacy manifests may use `owned_script` for a single file).
- One module folder has one owner: no two modules may own the same folder or nested folders
  (`src/player/` and `src/player/ai/` clash; `src/player/` and `src/players/` do not). Test folders count too.
- No task, including integration, may list a path inside another module's owned folder or test folder.
- `depends_on` must name existing module ids and must not form a cycle. Modules run in waves:
  a module starts after everything it depends on is merged.
- Every `prompt_file` must exist.
- The owned folder, test folder, module report and interface request are always writable by that
  module; `allowed_files` only adds to them. Globs are rejected; use a folder ending in `/`.
- `generated_files` entries are a file-name pattern without `/` (only `*` as a wildcard), a folder
  ending in `/`, or one exact path.
- Effort levels are `low`, `medium`, `high`, `xhigh` or `max`; `effort.preset` is `economy`,
  `balanced` or `quality`; `effort:` accepts only the five role names above.
- `model` fields and the old `defaults:` section are rejected.
