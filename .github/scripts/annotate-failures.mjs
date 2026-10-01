// Turns the failing tests in `node --test` output into GitHub annotations: one per test, with
// its name as the title and the start of its error as the text. GitHub keeps about ten
// annotations per step, so line-by-line greps lose the test names.
//   node .github/scripts/annotate-failures.mjs test-output.txt
import fs from 'node:fs';

const MAX_TESTS = 9;
const MAX_LINES = 14;

const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const summary = lines.findIndex((line) => /failing tests:/.test(line));
const tail = summary >= 0 ? lines.slice(summary + 1) : lines;
const starts = tail.map((line, index) => (/^test at /.test(line) ? index : -1)).filter((index) => index >= 0);

/** GitHub reads %, CR and LF in a workflow command as data only when they are escaped. */
const escape = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

for (const [position, start] of starts.slice(0, MAX_TESTS).entries()) {
  const end = starts[position + 1] ?? tail.length;
  const block = tail.slice(start, Math.min(end, start + MAX_LINES)).filter((line) => line.trim() && !/^\s+at /.test(line));
  const title = (block[1] || block[0] || 'failing test').replace(/^\S\s*/, '').replace(/\s*\([\d.]+ms\)\s*$/, '').replace(/[:,]/g, ' ');
  console.log(`::error title=${escape(title).slice(0, 180)}::${escape(block.join('\n')).slice(0, 3000)}`);
}
if (!starts.length) {
  console.log(`::error title=Tests failed::${escape(lines.slice(-25).join('\n')).slice(0, 3000)}`);
}
