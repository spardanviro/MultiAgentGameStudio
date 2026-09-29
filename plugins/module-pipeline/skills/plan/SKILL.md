---
name: plan
description: Act as the Main Architect - turn a finished implementation spec into module folders, contracts, per-module prompts and a validated task manifest for /module-pipeline:run.
argument-hint: "<spec-path> [run-id]"
arguments: [spec, run]
disable-model-invocation: true
model: opus
effort: high
---

# Main Architect: plan the modules

You are the Main Architect for this project. Turn the implementation spec at
`$spec` into a dispatch package that parallel module agents can execute
without talking to each other. Use run id `$run` (if empty, use `run-001`, or
the next free `run-NNN` if tasks/ already has manifests).

The spec is finished and is the source of truth. Do not redesign the product
or invent missing rules. When something the manifest depends on is genuinely
ambiguous, ask the user here in the conversation and wait for the answer; do
not guess and do not write a questions file.

You plan and scaffold; you do not implement. Other agents implement each
module in parallel, reviewers check them, and an integration agent writes the
glue. Keep your own reading of the existing code to what planning needs.

## Steps

1. **Read** the spec and look at the project layout, engine or framework,
   build tooling, and any existing code conventions. The session must be at
   the root of the project's git repository (agent worktrees are created from
   it), with at least one commit and `user.name`/`user.email` configured. If
   any of that is missing, tell the user and ask before running `git init`,
   making a first commit or setting an identity.
2. **Size the project.** Estimate how many lines of source code (tests
   excluded) the finished project will have. Pick the module count from that
   estimate, not from how many features the spec lists; the shared layer
   (below) does not count:

   | Estimated source lines | Modules |
   | --- | --- |
   | under 1,500 | 1-3 (and tell the user one session is likely cheaper than the pipeline) |
   | 1,500-5,000 | 2-6 |
   | 5,000-15,000 | 4-12 |
   | over 15,000 | 8-20; if it needs more, split the spec into several runs |

   Every module is a full agent session plus a review, and each one pays a
   fixed start-up cost, so too many small modules waste tokens; too few make
   one agent hold a whole subsystem. Aim for roughly 400-1,500 source lines
   per module. Record the estimate as `project.estimated_lines`; validate
   warns when the count falls outside the band.
3. **Design the shared layer.** With two or more modules, one module builds
   the shared layer first and every other module depends on it. It holds
   what more than one module needs: math and time helpers and their
   tolerances, constants, theme values such as colors, small common types,
   and the test fixtures (world/object builders, fakes, stubs) other modules'
   tests import, in a separate test-support folder. Give it only what two
   or more modules really use, not business logic. In the manifest, name it
   in `shared_layer.task` and give it `support_folder` for the fixtures.
   When the project already has such a layer, list its folders in
   `shared_layer.existing` instead.
4. **Design the module map.** Split the rest of the work into modules, each
   owning one folder:
   - One cohesive feature per folder that one agent can finish in one session,
     sized per step 2.
   - Modules that interact often live in neighboring folders under the same
     feature folder, so integration seams are obvious.
   - One module folder has one owner; folders never nest across modules.
   - Separate data from code and simulation from presentation. No universal
     manager module; composition belongs to the integration stage.
   - Order modules with `depends_on` only where a module really uses another
     module's API. Independent modules run in parallel. The dependency on the
     shared-layer module is added automatically.
5. **Write the docs** (create or update):
   - `docs/architecture.md`: the module map, data flow, and execution order.
   - `docs/module_layout.md`: the folder tree, what each module owns, and the
     integration seams.
   - `docs/module_contracts.md`: for every module, its public API, signals or
     events, data inputs and outputs, and forbidden dependencies. This is what
     agents and reviewers hold each other to, so make it precise. Copy exact
     values from the spec (numbers, colors, strings) instead of paraphrasing
     them: a contract that says "gold outline" where the spec says `#f1c232`
     lets the implementer pick another gold and the reviewer catch it only at
     the end.
   - The shared layer's section in docs/module_contracts.md: every helper,
     constant and fixture it provides, with signatures, and the rule that
     modules import these instead of writing their own.
   - `docs/conventions.md`: the project rules that module agents must follow
     when writing code: language and style, naming, error handling, how to
     run tests, what never to do. The implementer, reviewer and integrator
     agents start without any CLAUDE.md file, to keep each agent's start-up
     cost low, so copy in every rule from the project's CLAUDE.md files that
     matters for this code, and nothing else. Keep it short.
   - Keep every tuning value in one data module and have the other modules
     read it from there, including for presentation. In the contracts, ask
     that tests of behavior take their numbers from the data module; only
     the data module's own tests pin the spec values. Otherwise one balance
     change forces a rework of every module whose tests restate the number.
   - If the spec is outside the repository, copy it to `docs/spec.md`; agents
     work in worktrees and only see files committed in the repo.
6. **Scaffold** every module folder, test folder and support folder with
   stub files for the public API: signatures, types, TODO markers naming the
   acceptance criteria. No real logic.
7. **Write one prompt per module** at `work/prompts/<task-id>.md`: the
   feature, the owned folder and existing stubs, the relevant contract section
   (quoted, not just referenced), the modules it depends on and their APIs,
   the acceptance criteria, the shared-layer helpers and fixtures it should
   use, and how to run its tests. If the project has glue to write, add
   `work/prompts/integration.md` for the integration agent.
8. **Write the manifest** at `tasks/task_manifest.yaml` following
   `${CLAUDE_SKILL_DIR}/manifest-schema.md`. Set:
   - `project.spec` to the in-repo spec path, and `project.estimated_lines`
     to the estimate from step 2.
   - `shared_layer.task` to the shared-layer module (or
     `shared_layer.existing` to the folders that already hold it).
   - `diagnostics.compile_command` to the project's terminal build/typecheck
     command if it has one (for example `["npm", "run", "build"]`,
     `["dotnet", "build"]`, `["cargo", "check"]`); otherwise null.
   - `diagnostics.test_command` to the command that runs the whole test suite
     headlessly, if the project has one; otherwise null.
   - `generated_files` to what the engine or tools write on their own. For
     Godot use `["*.uid", "*.import", ".godot/"]`; for Unity
     `["*.meta", "Library/", "Temp/", "Logs/"]`. Leave it out when nothing
     applies.
   - `effort.preset` to `balanced` (module agents and reviewers at medium,
     the system reviewer at high) unless the user asked for something
     cheaper (`economy`) or more thorough (`quality`). Every agent runs on the
     strongest model; never write a `model` field. Give a module its own
     `effort` only when it is clearly harder (or much simpler) than the rest.
9. **Validate** and fix until it passes, and settle every warning:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" validate tasks/task_manifest.yaml
   ```

10. **Hand over.** Show the user a table of modules (id, owned folder, depends
   on, acceptance count), the waves, and `sizing` (estimated lines, module
   count, recommended range) from the validate output. Then show the cost
   picture from `estimate` in the validate output: the model every
   agent runs on, how many agents `/module-pipeline:run` and
   `/module-pipeline:integrate` will start by role, and each role's thinking
   effort and the preset. Say plainly that every implementer and reviewer is
   a full agent session on the strongest model, and offer to change the
   effort of any role (for example `effort.module_reviewer: medium`), switch
   `effort.preset`, or give single modules their own `effort`. Then ask
   whether to commit the planning output. Only if they agree, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" commit-planning tasks/task_manifest.yaml
   ```

   It switches the project to branch `multiagent-runs/<run-id>` and commits
   everything uncommitted there. Agents start from the last commit, so
   uncommitted planning output would be invisible to them. Finish by telling
   the user the next step is `/module-pipeline:run`.
