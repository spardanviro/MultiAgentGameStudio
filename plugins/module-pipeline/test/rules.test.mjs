// 0.7.0: the shared layer owns the cross-module rules (time, state, numbers, order, errors).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RULE_TOPICS, checkRulesFile, validateManifest } from '../scripts/lib/manifest.mjs';
import yaml from '../scripts/vendor/js-yaml.mjs';
import { DEFAULT_MANIFEST, PLUGIN_ROOT, RULES_TEXT, cli, git, makeAgentWorktree, makeProject, write } from './helpers.mjs';
import { prepareArgs, runWorkflow } from './workflow-harness.mjs';

const RULES = 'docs/cross_module_rules.md';
const RULES_LINE = `  rules: ${RULES}\n`;
const parse = (text) => validateManifest(yaml.load(text), path.resolve('/p/tasks/task_manifest.yaml'));
const PASS = { verdict: 'pass', summary: 'Looks right.', rework_items: [] };

function implementer({ taskId, write: writeFile }) {
  writeFile(`src/${taskId}/${taskId}_impl.gd`, `class_name ${taskId}\n`);
  writeFile(`work/modules/${taskId}/module_report.md`, `${taskId} done.\n`);
  return { summary: `${taskId} built`, testsRun: 'none', blockers: [] };
}

/** A project whose rules file has the given text, committed. */
function projectWithRules(text) {
  const project = makeProject();
  write(project.root, RULES, text);
  git(project.root, 'add', '.');
  git(project.root, 'commit', '-q', '-m', 'rules');
  return project;
}

test('a run with two or more modules must name its cross-module rules file', () => {
  assert.throws(() => parse(DEFAULT_MANIFEST.replace(RULES_LINE, '')), /shared_layer\.rules is required when a run has two or more modules.*time, state, numbers, order, errors/);
  assert.equal(parse(DEFAULT_MANIFEST).sharedLayer.rules, RULES);

  const single = DEFAULT_MANIFEST.replace(RULES_LINE, '').split('  - id: enemy')[0] +
    'integration:\n  prompt_file: work/prompts/integration.md\n  allowed_files:\n    - src/game/\n';
  assert.equal(parse(single).sharedLayer.rules, null, 'one module has no seams to rule on');

  const patch = `version: 1\nrun:\n  id: run-001-r1\nshared_layer:\n  existing: [src/common/]\n${RULES_LINE}patch:\n  prompt_file: work/prompts/patch.md\n  allowed_files: [src/player/]\n`;
  assert.equal(parse(patch).sharedLayer.rules, RULES, 'a patch manifest passes the rules on to its agents');
  assert.equal(parse(patch.replace(RULES_LINE, '')).sharedLayer.rules, null, 'but does not need them');
});

test('the rules file needs every topic, with text under each heading', () => {
  assert.deepEqual(checkRulesFile(RULES_TEXT), []);
  assert.deepEqual(RULE_TOPICS.map((topic) => topic.heading), ['Time', 'State', 'Numbers', 'Order', 'Errors']);

  const loose = '# Rules\n\n## 1. Time and clocks\n### Steps\nCount whole steps.\n## State ownership\n| State | Owner |\n## numbers\nPixels.\n## Order of work\n1. input\n## Errors\nNot applicable: pure functions, nothing to reject.\n';
  assert.deepEqual(checkRulesFile(loose), [], 'numbered, longer and lower-case headings count; so does "Not applicable"');

  const gaps = checkRulesFile('## Time\n\n<!-- who advances it? -->\n\n## State\nOne table.\n## Timeouts\nNot a topic.\n## Order\nx\n## Errors\nx\n');
  assert.equal(gaps.length, 2);
  assert.match(gaps[0], /says nothing under "Time".*write the rule, or "Not applicable" and why/);
  assert.match(gaps[1], /has no "Numbers" heading \(units, rounding/);
});

test('the plan skill ships a template that names every topic and fails until it is filled in', () => {
  const template = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'plan', 'cross-module-rules.md'), 'utf8');
  const problems = checkRulesFile(template);
  assert.equal(problems.length, RULE_TOPICS.length);
  assert.ok(problems.every((problem) => /^says nothing under/.test(problem)), problems.join('\n'));
});

test('validate and prepare report a missing or incomplete rules file', () => {
  const missing = makeProject(DEFAULT_MANIFEST.replace(RULES, 'docs/nope.md'));
  assert.deepEqual(cli(missing.root, 'validate', missing.manifest).json.errors, ['shared_layer.rules does not exist: docs/nope.md']);

  const { root, manifest } = projectWithRules(RULES_TEXT.replace('## State\n\nRule: decided.\n', ''));
  const validated = cli(root, 'validate', manifest).json;
  assert.equal(validated.ok, false);
  assert.equal(validated.errors.length, 1);
  assert.match(validated.errors[0], /^shared_layer\.rules \(docs\/cross_module_rules\.md\) has no "State" heading/);
  assert.equal(cli(root, 'prepare', manifest).json.ok, false, 'no agent starts on incomplete rules');
});

test('every agent is told where the rules are: workflow args, claim and merge output, and prompts', async () => {
  const { root, manifest } = makeProject();
  const args = prepareArgs(root, manifest);
  assert.equal(args.rules, RULES);

  const prompts = {};
  let merged = null;
  await runWorkflow('implement-modules', {
    root,
    args,
    scenario: {
      implement: (ctx) => {
        prompts.implement = ctx.prompt;
        assert.equal(ctx.claimed.rules, RULES);
        return implementer(ctx);
      },
      review: (taskId, prompt, merge) => {
        prompts.review = prompt;
        merged = merge;
        return PASS;
      },
    },
  });
  assert.match(prompts.implement, /docs\/module_contracts\.md, docs\/cross_module_rules\.md \(the cross-module rules\)/);
  assert.match(prompts.review, /docs\/cross_module_rules\.md \(the cross-module rules; a module that sidesteps one blocks integration\)/);
  assert.equal(merged.rules, RULES);

  cli(root, 'prepare', manifest, '--stage', 'integration');
  const worktree = makeAgentWorktree(root, 'rules-integration');
  assert.equal(cli(worktree, 'claim', '--run', 'run-001', '--task', 'integration').json.rules, RULES);
});

test('integrate workflow: the system reviewer audits every rule, and one violated rule requires rework', async () => {
  const { root, manifest } = makeProject();
  await runWorkflow('implement-modules', { root, args: prepareArgs(root, manifest), scenario: { implement: implementer, review: () => PASS } });

  const followed = RULE_TOPICS.map((topic) => ({ topic: topic.heading, status: 'followed', evidence: 'git grep found one clock' }));
  let reviewPrompt = '';
  const { result } = await runWorkflow('integrate-system', {
    root,
    args: prepareArgs(root, manifest, '--stage', 'integration'),
    scenario: {
      integrate: ({ write: writeFile, prompt }) => {
        assert.match(prompt, /docs\/cross_module_rules\.md \(the cross-module rules\)/);
        writeFile('src/game/main.gd', 'extends Node\n');
        return { summary: 'wired', testsRun: 'none', blockers: [] };
      },
      systemReview: (prompt) => {
        reviewPrompt = prompt;
        return {
          verdict: 'pass',
          summary: 'Meets the spec.',
          spec_coverage: [],
          rule_checks: [{ topic: 'Time', status: 'violated', evidence: 'src/enemy/enemy_impl.gd:1 sums dt itself' }, ...followed.slice(1)],
          rework_items: [],
        };
      },
    },
  });
  assert.match(reviewPrompt, /Audit the seams against docs\/cross_module_rules\.md\. For every topic heading/);
  assert.equal(result.status, 'rework_required', 'a violated rule blocks even without a blocking item');
  assert.deepEqual(result.ruleViolations.map((check) => check.topic), ['Time']);
  assert.equal(result.review.rule_checks.length, RULE_TOPICS.length);
  assert.equal(result.next, 'rework');

  // The glue is merged now; the rerun reviews again and passes once every rule holds.
  const rerun = await runWorkflow('integrate-system', {
    root,
    args: prepareArgs(root, manifest, '--stage', 'integration'),
    scenario: { systemReview: () => ({ verdict: 'pass', summary: 'ok', spec_coverage: [], rule_checks: followed, rework_items: [] }) },
  });
  assert.equal(rerun.result.status, 'passed', JSON.stringify(rerun.result, null, 2));
  assert.deepEqual(rerun.result.ruleViolations, []);
});

test('the writer and reviewer agents each carry the cross-module rules in their instructions', () => {
  for (const name of ['module-implementer', 'module-reviewer', 'integrator', 'patcher', 'system-reviewer']) {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', `${name}.md`), 'utf8');
    assert.match(text, /cross-module rules/, `${name} knows the rules file`);
  }
});
