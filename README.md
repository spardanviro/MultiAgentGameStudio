# MultiAgentSystem

A local Claude Code plugin marketplace containing one plugin:
[**module-pipeline**](plugins/module-pipeline/README.md), a spec-driven multi-agent build pipeline.
A Main Architect splits a spec into module folders with one owner each; module agents implement
them in parallel isolated worktrees under enforced write scopes; every accepted module is committed
on a per-run branch; reviewers gate each stage; rework runs close the loop.

## Install

In Claude Code:

```
/plugin marketplace add C:/Users/Nero/Desktop/MultiAgentSystem
/plugin install module-pipeline@multiagent-system
```

Then, in the project you want to build: `/module-pipeline:plan <spec>`, `/module-pipeline:run`,
`/module-pipeline:integrate`, `/module-pipeline:rework <run-id>`, `/module-pipeline:status`.
See the [plugin README](plugins/module-pipeline/README.md) for details.

## Layout

```
.claude-plugin/marketplace.json   marketplace listing
plugins/module-pipeline/          the plugin (skills, agents, workflows, hooks, scripts, tests)
```

## Test

```
npm test
```

The plugin has no runtime dependencies (js-yaml is vendored), so no install step is needed.

The earlier Electron manager app lives in the git history up to commit `31a2875`.
