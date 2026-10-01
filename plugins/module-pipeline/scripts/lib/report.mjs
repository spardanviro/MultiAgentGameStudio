// Turns a stage workflow's result into the readable report and the short
// summary the session shows the user. The session used to write both by hand,
// one model call (and its whole context) at a time.
import yaml from '../vendor/js-yaml.mjs';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function cell(value) {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
}

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)];
}

function yamlBlock(items) {
  return items && items.length ? ['```yaml', yaml.dump(items, { lineWidth: 100 }).trimEnd(), '```'] : ['None.'];
}

function list(title, items) {
  return items && items.length ? [`${title}:`, ...items.map((item) => `- ${item}`), ''] : [];
}

/** One or two lines on what the build and the tests did. */
export function diagnosticsLine(diagnostics) {
  if (!diagnostics) {
    return 'Diagnostics did not run.';
  }
  if (diagnostics.summary) {
    return `Diagnostics ${diagnostics.failed ? 'failed' : 'passed'}: ${diagnostics.summary}`;
  }
  if (diagnostics.ran === false) {
    return `Diagnostics: nothing to run (${diagnostics.reason || 'no commands in the manifest'}).`;
  }
  const parts = [];
  if (diagnostics.command) {
    parts.push(`build: ${diagnostics.errorCount || 0} error(s), ${diagnostics.warningCount || 0} warning(s)`);
  }
  if (diagnostics.tests) {
    parts.push(`tests: ${diagnostics.tests.skipped ? 'skipped' : diagnostics.tests.failed ? 'failed' : 'passed'}`);
  }
  return `Diagnostics ${diagnostics.failed ? 'failed' : 'passed'} (${parts.join('; ') || 'no output'}).`;
}

function diagnosticsSection(diagnostics) {
  const lines = ['## Diagnostics', '', diagnosticsLine(diagnostics), ''];
  if (diagnostics?.errors?.length) {
    lines.push('```', ...diagnostics.errors.slice(0, 20), '```', '');
  }
  if (diagnostics?.tests?.failed && diagnostics.tests.tail?.length) {
    lines.push('Tail of the test output:', '', '```', ...diagnostics.tests.tail.slice(-20), '```', '');
  }
  if (diagnostics?.logPath) {
    lines.push(`Full log: ${diagnostics.logPath}`, '');
  }
  return lines;
}

function sizeSection(size) {
  if (!size) {
    return [];
  }
  const estimate = size.estimatedLines ? `; the plan estimated ${size.estimatedLines} for the finished project` : '';
  return [
    '## Size',
    '',
    `${size.builtLines} source line(s) changed in the module folders on this run${estimate}.`,
    '',
    ...table(['Module', 'Source lines'], size.perModule.map((entry) => [entry.id, entry.lines])),
    '',
  ];
}

function modulesReport(result) {
  const modules = result.modules || [];
  const lines = [
    ...table(
      ['Module', 'Status', 'Commit', 'Review', 'Open items'],
      modules.map((module) => [
        module.task,
        module.status,
        module.commit ? String(module.commit).slice(0, 10) : '-',
        module.review?.verdict || '-',
        module.review?.rework_items?.length || 0,
      ]),
    ),
    '',
  ];
  if (result.alreadyMerged?.length) {
    lines.push(`Merged in an earlier invocation: ${result.alreadyMerged.join(', ')}.`, '');
  }
  for (const module of modules) {
    lines.push(`## ${module.task}`, '', `Status: ${module.status}${module.reason || module.error ? ` (${module.reason || module.error})` : ''}`, '');
    if (module.summary) {
      lines.push(`Implementer: ${module.summary}`, '');
    }
    if (module.testsRun) {
      lines.push(`Tests the implementer ran: ${module.testsRun}`, '');
    }
    lines.push(
      ...list('Blockers', module.blockers),
      ...list('Interface requests', module.interfaceRequests),
      ...list('Written outside the scope', module.violations),
      ...list('Generated files dropped', module.dropped),
    );
    if (module.worktree && module.status !== 'merged') {
      lines.push(`Worktree kept for inspection: ${module.worktree}`, '');
    }
    if (module.review) {
      lines.push(`Review (${module.review.verdict}): ${module.review.summary || ''}`, '', ...yamlBlock(module.review.rework_items), '');
    }
  }
  return [...lines, ...diagnosticsSection(result.diagnostics), ...sizeSection(result.size)];
}

function integrationReport(result) {
  const merge = result.integration;
  const review = result.review;
  const lines = [
    `Integration: ${merge ? merge.status : 'no result'}${merge?.commit ? ` (${String(merge.commit).slice(0, 10)})` : ''}${merge?.error ? `: ${merge.error}` : ''}`,
    '',
    ...list('Written outside the scope', merge?.violations),
  ];
  if (result.integrator) {
    lines.push(`Integrator: ${result.integrator.summary || ''}`, '', `Tests the integrator ran: ${result.integrator.testsRun || '-'}`, '');
    lines.push(...list('Interface requests', result.integrator.interfaceRequests), ...list('Blockers', result.integrator.blockers));
  }
  lines.push(...diagnosticsSection(result.diagnostics));
  if (!review) {
    return [...lines, 'The system reviewer did not return.', ''];
  }
  lines.push(`## System review (${review.verdict})`, '', review.summary || '', '');
  if (review.spec_coverage?.length) {
    const state = (row) => (row.status !== 'done' && row.deferred === true ? `${row.status} (deferred)` : row.status);
    lines.push(
      '### Spec coverage',
      '',
      ...table(['Feature', 'Status', 'Owner', 'Note'], review.spec_coverage.map((row) => [row.feature, state(row), row.owner, row.note])),
      '',
    );
    if (result.coverageGaps?.length) {
      lines.push(`${result.coverageGaps.length} feature(s) are partial or missing and not deferred; that alone makes the status \`rework_required\`.`, '');
    }
  }
  if (review.rule_checks?.length) {
    lines.push('### Seam audit', '', ...table(['Rule topic', 'Status', 'Evidence'], review.rule_checks.map((row) => [row.topic, row.status, row.evidence])), '');
  }
  return [...lines, '### Rework items', '', ...yamlBlock(review.rework_items), ''];
}

function patchReport(result) {
  const merge = result.merge;
  const lines = [
    `Patch: ${merge ? merge.status : 'no result'}${merge?.commit ? ` (${String(merge.commit).slice(0, 10)})` : ''}${merge?.changedLines != null ? `, ${merge.changedLines} changed line(s)` : ''}${merge?.error ? `: ${merge.error}` : ''}`,
    '',
    ...list('Files', merge?.files),
    ...list('Written outside the scope', merge?.violations),
  ];
  if (result.patcher) {
    lines.push(`Patcher: ${result.patcher.summary || ''}`, '', `Tests the patcher ran: ${result.patcher.testsRun || '-'}`, '', ...list('Blockers', result.patcher.blockers));
  }
  lines.push(...diagnosticsSection(result.diagnostics));
  if (result.review) {
    lines.push(`## Review (${result.review.verdict})`, '', result.review.summary || '', '', ...yamlBlock(result.review.rework_items), '');
  }
  return lines;
}

const REPORTS = { modules: modulesReport, integration: integrationReport, patch: patchReport };

function straySection(files) {
  if (!files?.length) {
    return [];
  }
  return [
    '## Uncommitted files in the main checkout',
    '',
    'No pipeline merge wrote these. They come from a build or test command, from an agent\'s shell command, or from your own edits; check them before the next stage.',
    '',
    ...files.slice(0, 50).map((file) => `- ${file}`),
    ...(files.length > 50 ? [`- … and ${files.length - 50} more`] : []),
    '',
  ];
}

/** The readable report of one stage. */
export function reportMarkdown(result) {
  const body = [...REPORTS[result.stage](result), ...straySection(result.strayChanges)];
  return [`# ${result.runId}: ${result.stage} stage`, '', `Status: **${result.status}**. Next: ${result.next}.`, '', ...body].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Every review item of a stage, most severe first, with what the session needs to list it. */
export function openItems(result) {
  const fromModules = (result.modules || []).flatMap((module) => (module.review?.rework_items || []).map((item) => ({ task: module.task, ...item })));
  const fromReview = (result.review?.rework_items || []).map((item) => ({ task: item.scope || result.stage, ...item }));
  return [...fromModules, ...fromReview]
    .map((item) => ({
      issue_id: item.issue_id,
      task: item.task,
      severity: item.severity,
      blocking: item.blocks_integration === true || item.blocks_release === true || item.severity === 'critical',
      problem: item.problem,
    }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}
