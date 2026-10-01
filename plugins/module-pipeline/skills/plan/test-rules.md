# Test rules for docs/conventions.md

Copy these into the `## Tests` section of `docs/conventions.md`, replacing the
bracketed parts with the project's own names. They come from measuring what a
change request cost afterwards: four changed numbers took 4 source lines and
up to 80 test lines, and most of that was tests restating the spec.

## Tests

- **Numbers come from [the data module].** A behavior test imports the value
  it expects (`CONFIG.enemies.bat.speed`), or computes it from imported
  values. Only [the data module]'s own test pins the spec's numbers, once.
  No copied spec tables, no hand-computed results of several values.
- **Assert what the test is about.** Check the fields the rule changes.
  Comparing a whole shared object (the world, a snapshot, a list of keys)
  belongs in one shape test per shape, not in behavior tests: otherwise
  every new field breaks tests that have nothing to do with it.
- **Fixtures call production code.** A helper that rebuilds an index, steps
  the simulation or creates an object calls the real function. A fixture
  that reimplements a rule tests the copy, and the two drift apart silently.
- **One rule, one place.** Test a rule in the module that owns it. Modules
  that use it test their own behavior, not the rule again.
- **Build the situation directly.** Set up state with fixtures or debug
  hooks. A test must not depend on balance ("the scripted run survives 60
  seconds") or on a particular random seed happening to work out.
- **No numbers in test names** that a tuning change would make false.
- **Stop when the criteria are covered.** Every acceptance criterion and its
  edge cases have a test; more tests than that are more to update on every
  change. As a guide, a module's tests should not be longer than its source
  unless its criteria demand it.
