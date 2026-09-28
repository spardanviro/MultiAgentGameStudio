---
name: plan
description: Act as the Main Architect - turn a finished implementation spec into module folders, contracts, per-module prompts and a validated task manifest for /module-pipeline:run.
argument-hint: "<spec-path> [run-id]"
arguments: [spec, run]
disable-model-invocation: true
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
   build tooling, and any existing code conventions.
2. **Design the module map.** Split the work into modules, each owning one
   folder:
   - One cohesive feature per folder that one agent can finish in one session:
     a handful of closely related scripts, not a whole subsystem and not a
     single helper.
   - Modules that interact often live in neighboring folders under the same
     feature folder, so integration seams are obvious.
   - One module folder has one owner; folders never nest across modules.
   - Separate data from code and simulation from presentation. No universal
     manager module; composition belongs to the integration stage.
   - Order modules with `depends_on` only where a module really uses another
     module's API. Independent modules run in parallel.
3. **Write the docs** (create or update):
   - `docs/architecture.md`: the module map, data flow, and execution order.
   - `docs/module_layout.md`: the folder tree, what each module owns, and the
     integration seams.
   - `docs/module_contracts.md`: for every module, its public API, signals or
     events, data inputs and outputs, and forbidden dependencies. This is what
     agents and reviewers hold each other to, so make it precise.
   - If the spec is outside the repository, copy it to `docs/spec.md`; agents
     work in worktrees and only see files committed in the repo.
4. **Scaffold** every module folder (and test folder) with stub files for the
   public API: signatures, types, TODO markers naming the acceptance criteria.
   No real logic.
5. **Write one prompt per module** at `work/prompts/<task-id>.md`: the
   feature, the owned folder and existing stubs, the relevant contract section
   (quoted, not just referenced), the modules it depends on and their APIs,
   the acceptance criteria, and how to run its tests. If the project has glue
   to write, add `work/prompts/integration.md` for the integration agent.
6. **Write the manifest** at `tasks/task_manifest.yaml` following
   `${CLAUDE_SKILL_DIR}/manifest-schema.md`. Set:
   - `project.spec` to the in-repo spec path.
   - `diagnostics.compile_command` to the project's terminal build/typecheck
     command if it has one (for example `["npm", "run", "build"]`,
     `["dotnet", "build"]`, `["cargo", "check"]`); otherwise null.
   - `diagnostics.test_command` to the command that runs the whole test suite
     headlessly, if the project has one; otherwise null.
   - `generated_files` to what the engine or tools write on their own. For
     Godot use `["*.uid", "*.import", ".godot/"]`; for Unity
     `["*.meta", "Library/", "Temp/", "Logs/"]`. Leave it out when nothing
     applies.
   - `defaults.preset` to `balanced` unless the user asked for something
     cheaper (`economy`) or stronger (`quality`).
7. **Validate** and fix until it passes:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" validate tasks/task_manifest.yaml
   ```

8. **Hand over.** Show the user a table of modules (id, owned folder, depends
   on, acceptance count) and the waves from the validate output. Then show
   the cost picture from `estimate` in the validate output: how many agents
   `/module-pipeline:run` and `/module-pipeline:integrate` will start, by
   role and model, and the preset in use. Say plainly that every implementer
   and reviewer is a full agent session, and that switching `defaults.preset`
   to `economy` or giving simple modules `model: haiku` lowers the cost. Then
   ask whether to commit the planning output. Only if they agree, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" commit-planning tasks/task_manifest.yaml
   ```

   It switches the project to branch `multiagent-runs/<run-id>` and commits
   everything uncommitted there. Agents start from the last commit, so
   uncommitted planning output would be invisible to them. Finish by telling
   the user the next step is `/module-pipeline:run`.
