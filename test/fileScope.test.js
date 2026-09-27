const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createScopeMatcher,
  entriesOverlap,
  normalizeScopeEntry,
  toRootRelative,
} = require('../src/fileScope');

test('normalizeScopeEntry keeps files, marks folders, and rejects unsafe paths', () => {
  assert.equal(normalizeScopeEntry('src\\player\\health.gd'), 'src/player/health.gd');
  assert.equal(normalizeScopeEntry('./src/player/'), 'src/player/');
  assert.equal(normalizeScopeEntry('src/player/**'), 'src/player/');
  assert.equal(normalizeScopeEntry('src/player', 'owned_folder', { folder: true }), 'src/player/');
  assert.throws(() => normalizeScopeEntry('../outside.gd'), /inside the project root/);
  assert.throws(() => normalizeScopeEntry('src/../../x'), /inside the project root/);
  assert.throws(() => normalizeScopeEntry('C:/abs/file.gd'), /relative/);
  assert.throws(() => normalizeScopeEntry('src/*.gd'), /not a glob/);
  assert.throws(() => normalizeScopeEntry(''), /required/);
});

test('createScopeMatcher matches exact files and everything under folders', () => {
  const allows = createScopeMatcher(['src/player/', 'work/report.md']);
  assert.equal(allows('src/player/health.gd'), true);
  assert.equal(allows('src/player/sub/deep.gd'), true);
  assert.equal(allows('SRC/Player/Health.gd'), true);
  assert.equal(allows('work/report.md'), true);
  assert.equal(allows('src/players/other.gd'), false);
  assert.equal(allows('work/report.md.bak'), false);
});

test('entriesOverlap detects equal and nested entries only', () => {
  assert.equal(entriesOverlap('src/player/', 'src/player/'), true);
  assert.equal(entriesOverlap('src/player/', 'src/player/ai/'), true);
  assert.equal(entriesOverlap('src/player/', 'src/player/health.gd'), true);
  assert.equal(entriesOverlap('src/player/', 'src/players/'), false);
  assert.equal(entriesOverlap('src/a.gd', 'src/b.gd'), false);
});

test('toRootRelative resolves tool paths and rejects escapes', () => {
  const root = path.resolve('/work/project');
  assert.equal(toRootRelative(root, path.join(root, 'src', 'a.gd')), 'src/a.gd');
  assert.equal(toRootRelative(root, 'src/a.gd'), 'src/a.gd');
  assert.equal(toRootRelative(root, path.resolve(root, '..', 'x.gd')), null);
  assert.equal(toRootRelative(root, root), null);
  assert.equal(toRootRelative(root, null), null);
});
