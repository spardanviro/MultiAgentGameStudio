# Task manifest schema (tasks/task_manifest.yaml)

Paths are relative to the project root. A folder entry ends with `/`.

```yaml
version: 1
project:
  name: Card Game
  spec: docs/spec.md              # the implementation spec, inside the repo
  estimated_lines: 6000           # expected source lines, tests excluded; checks the module count
run:
  id: run-001                     # letters, digits, . _ - ; becomes branch multiagent-runs/run-001
  goal: One-sentence goal of this run
effort:                           # thinking effort per role: low | medium | high | xhigh | max
  preset: balanced                # economy | balanced | quality (default balanced); roles below override it
  module_implementer: medium      # one agent per module
  module_reviewer: medium         # one read-only reviewer per merged module
  integrator: medium              # writes the glue code
  system_reviewer: high           # reviews the integrated result against the spec
shared_layer:                     # required with two or more modules
  task: shared                    # the module that builds it; it runs first, every other module depends on it
  # existing: [src/shared/, tests/support/]   # instead of task: folders that already hold it
  rules: docs/cross_module_rules.md   # required with two or more modules: time, state, numbers, order, errors
diagnostics:
  compile_command: ["dotnet", "build"]   # argv list or a shell string; null if none
  test_command: ["dotnet", "test"]       # full test suite after modules merge; null if none
  timeout_ms: 300000                     # per command
generated_files:                  # tool output that may appear outside a task's scope
  - "*.uid"                       # file-name pattern ("*" only), matched anywhere
  - "*.import"
  - .godot/                       # a folder
tasks:
  - id: shared
    feature: Shared helpers, constants, theme values and test fixtures
    owned_folder: src/shared/
    test_folder: tests/shared/
    support_folder: tests/support/        # test fixtures other modules' tests import; shared_layer.task only
    prompt_file: work/prompts/shared.md
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

| Preset | module_implementer | module_reviewer | integrator | system_reviewer |
| --- | --- | --- | --- | --- |
| `economy` | low | low | low | medium |
| `balanced` (default) | medium | medium | medium | high |
| `quality` | high | high | high | xhigh |

Precedence, highest first: a task's own `effort`, the role under `effort:`,
the preset. The pipeline's own commands (prepare, merge, diagnostics) need no
agent: the session runs prepare and the diagnostics after the module stage,
each module reviewer runs its module's merge, and the system reviewer runs the
integration merge and its diagnostics. An old manifest's `pipeline_ops` is
ignored with a warning.

The Main Architect is the session running `/module-pipeline:plan` and
`/module-pipeline:rework`; those skills run on opus at `high` effort. The other
skills (`run`, `integrate`, `status`, `finish`, `clean`) only orchestrate and
run at `medium`.

## Shared layer

Without a shared layer every module agent writes its own copy of the same
helper, tolerance, color or test fixture, because it only sees the contracts,
not the other modules' code. With two or more modules the manifest must name
one:

- `shared_layer.task`: the module that builds it in this run. It may not have
  `depends_on`; every other module gets it as a dependency, so it runs alone
  in the first wave. Only it may have a `support_folder`, for the test
  fixtures other modules' tests import.
- `shared_layer.existing`: folders that already hold it, for rework runs and
  existing code bases. They must exist.

Implementers and reviewers are told the shared-layer folders; reviewers flag
code that duplicates what the shared layer provides.

## Cross-module rules

Helpers are only half of what modules share. The other half is decisions:
how time advances and is compared, where state lives and what resets it. An
agent that sees only contracts answers these alone, so one module sums time
step by step, another adds a tolerance, and a third keeps a switch on an
object a restart replaces. Each module passes its review; the defects sit
between them.

- `shared_layer.rules`: the file that settles them, written by the Main
  Architect (template: `cross-module-rules.md` next to this file). Required
  with two or more modules; optional in a patch manifest.
- It must have these headings, each with text under it (HTML comments do not
  count; a topic that does not apply says "Not applicable" and why):
  `Time`, `State`, `Numbers`, `Order`, `Errors`. Validate and prepare report
  what is missing.
- Each rule names the shared-layer export that carries it out and the test
  that pins it; `integration.acceptance` holds one end-to-end check per rule.
- Every agent's claim or merge output names the file as `rules`. Module
  reviewers block a module that sidesteps a rule. The system reviewer
  answers for every topic in `rule_checks` (`followed`, `violated`,
  `not_applicable`); one `violated` entry makes the integration result
  `rework_required`.

## Module size

Set `project.estimated_lines` to the expected source lines (tests excluded).
Validate then reports `sizing` and warns when the module count, not counting
the shared layer, falls outside this band:

| Estimated source lines | Modules |
| --- | --- |
| under 1,500 | 1-3 (one session is usually cheaper than the pipeline) |
| 1,500-5,000 | 2-6 |
| 5,000-15,000 | 4-12 |
| 15,000 and more | 8-20 |

## Patch runs

`/module-pipeline:rework` writes a patch manifest when every open item is a
small local fix. It has a `patch:` section instead of `tasks` and
`integration`:

```yaml
version: 1
project: { name: Card Game, spec: docs/spec.md }
run: { id: run-001-r1, goal: Fix the opening balance }
shared_layer: { existing: [src/shared/], rules: docs/cross_module_rules.md }   # optional, shown to the agents
patch:
  prompt_file: work/prompts/run-001-r1/patch.md   # every item quoted in full
  allowed_files: [src/data/, tests/data/, tests/enemies/]
  acceptance:                     # one line per item
    - Bats move at 85 px/s
    - The first wave spawns one bat every 1.5 s
  max_changed_lines: 300          # default; added plus deleted lines, tests included
  effort: medium                  # optional; default effort.module_implementer
  # patch_report / interface_request default to work/patches/<run>_*.md
```

One `patcher` agent applies every item in an isolated worktree, limited to
`allowed_files`, which may span several module folders. One reviewer then
merges it, runs the diagnostics and checks each item. There is no
integration stage and no system review. The merge refuses a patch whose
in-scope diff is larger than `max_changed_lines` (status `too_large`); its
worktree is kept, and the next rework takes the module path.

## Generated files

Engines and tools write files nobody asked for: Godot's `.uid` and `.import`
files, caches, build output. A generated file inside a task's own scope is
merged like any other file (Godot `.uid` files belong in git). One outside the
task's scope is dropped from the merge instead of rejecting the whole module.
List only files that really are machine-written; anything listed here can
never cause a scope violation.

## Rules the validator enforces

- Every module task has an `owned_folder` (legacy manifests may use `owned_script` for a single file).
- With two or more modules, `shared_layer` names a task (without `depends_on`) or existing folders,
  and `shared_layer.rules` names the cross-module rules file, which must exist and cover every topic.
- `project.estimated_lines`, when set, is a positive whole number.
- One module folder has one owner: no two modules may own the same folder or nested folders
  (`src/player/` and `src/player/ai/` clash; `src/player/` and `src/players/` do not). Test and support folders count too.
- No task, including integration, may list a path inside another module's owned folder or test folder.
- `depends_on` must name existing module ids and must not form a cycle. Modules run in waves:
  a module starts after everything it depends on is merged.
- Every `prompt_file` must exist.
- The owned folder, test folder, support folder, module report and interface request are always
  writable by that module; `allowed_files` only adds to them. Globs are rejected; use a folder ending in `/`.
- `generated_files` entries are a file-name pattern without `/` (only `*` as a wildcard), a folder
  ending in `/`, or one exact path.
- Effort levels are `low`, `medium`, `high`, `xhigh` or `max`; `effort.preset` is `economy`,
  `balanced` or `quality`; `effort:` accepts only the four role names above.
- `model` fields and the old `defaults:` section are rejected.
