# Cross-module rules

<!--
Template for docs/cross_module_rules.md. Copy it, answer every topic for this
project, and delete these comments. Validate rejects a topic that has only a
comment under it.

Every module agent reads this file and none of them sees another module's
code. Whatever is left open here is answered again in each module, each time
differently, and no single-module review can notice.

Write each rule as four short parts:
  Rule:      the decision, with exact values.
  Use:       the one shared-layer export (file and signature) that carries it
             out. A rule without code behind it is reimplemented per module.
  Never:     what a module must not do instead.
  Checked by: the shared-layer test that pins it, and the integration
             acceptance line that checks it end to end.

A topic that does not apply keeps its heading and says "Not applicable" and
why. Keep the whole file to one or two pages.
-->

## Time

<!--
- The unit, and the single owner that advances time. Everyone else reads it.
- A representation that cannot drift: count whole steps (or whole
  milliseconds) and derive seconds from the count. Summing a fractional step
  600 times does not give 600.
- How "has t been reached", cooldowns and "every n seconds" are computed:
  shared functions on the clock, never a comparison with a local tolerance.
- What stops time (pause, menus) and what a schedule does about the time it
  missed while it was switched off.
- For services: where "now" comes from (an injected clock), time zone, units.
-->

## State

<!--
One table row for every piece of state that outlives a single call or that
more than one module reads. Settings, debug switches and caches are state.

| State | Owner (module, object) | Lives for | Written by | Reset by / when |
| --- | --- | --- | --- | --- |
| debug switches | session object in glue | the whole session | testing API | never; a new game keeps them |
| cooldown timers | weapons, per weapon instance | one game | weapons | new game; an upgrade keeps them |

- Lifetimes to tell apart: process, session, one game or request, one entity.
  State that must survive a restart cannot sit on an object the restart
  replaces.
- Update or rebuild: say which fields an upgrade, reload or restart keeps.
- Other modules change state only through the owner's API.
-->

## Numbers

<!--
- Units and coordinate system (pixels, seconds, radians; where the origin is).
- Rounding: where it happens (display only?) and how (floor, round, digits).
- Comparing fractional numbers: the one shared function, or integers instead.
- The one home of every formula or derived value that more than one module
  needs, presentation included (a HUD that shows a simulation value calls the
  same function, it does not restate the formula).
- Shared names: state names, event names, ids. One list, imported.
-->

## Order

<!--
- The order of work inside one step, frame or request, as a numbered list.
- When readers (rendering, snapshots, API responses) observe: before or after
  the step, and which values they see.
- Whether an event raised during a step takes effect in the same step or the
  next one.
- Ids and randomness: who hands them out, in which order, from which seed.
-->

## Errors

<!--
- Invalid input at a module boundary: throw, return a result value, or
  ignore. Pick one per kind of boundary.
- Who validates: the caller or the callee.
- What a module does when a dependency fails, and where failures are logged.
-->
