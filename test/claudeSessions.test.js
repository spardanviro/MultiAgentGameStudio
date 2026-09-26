const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  extractTextContent,
  listProjectSessions,
  parseJsonl,
  readSessionTranscript,
  summarizeRecords,
} = require('../src/claudeSessions');

test('parseJsonl keeps valid records and counts invalid lines', () => {
  const result = parseJsonl('{"type":"user"}\nnope\n{"type":"assistant"}\n');
  assert.equal(result.records.length, 2);
  assert.equal(result.invalidLines, 1);
});

test('extractTextContent supports Claude text and tool content arrays', () => {
  const text = extractTextContent([
    { type: 'text', text: 'hello' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'a.js' } },
  ]);

  assert.match(text, /hello/);
  assert.match(text, /\[tool: Read\]/);
});

test('summarizeRecords builds useful session metadata', () => {
  const raw = [
    JSON.stringify({
      type: 'user',
      sessionId: 'session-1',
      cwd: 'C:\\work\\demo',
      timestamp: '2026-01-01T10:00:00.000Z',
      message: { role: 'user', content: 'Build the thing' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'session-1',
      timestamp: '2026-01-01T10:01:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    }),
  ].join('\n');

  const summary = summarizeRecords('session-1.jsonl', 'demo', raw, {
    birthtime: new Date('2026-01-01T09:59:00.000Z'),
    mtime: new Date('2026-01-01T10:02:00.000Z'),
    size: raw.length,
  });

  assert.equal(summary.id, 'session-1');
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.title, 'Build the thing');
  assert.equal(summary.preview, 'Done');
});

test('listProjectSessions matches sessions by cwd and reads transcript safely', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-manager-'));
  const selectedProject = path.join(tempRoot, 'project');
  const projectsRoot = path.join(tempRoot, '.claude', 'projects');
  const encodedProject = path.join(projectsRoot, '-project');
  const sessionFile = path.join(encodedProject, 'session-2.jsonl');

  await fs.mkdir(selectedProject, { recursive: true });
  await fs.mkdir(encodedProject, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-2',
        cwd: selectedProject,
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { role: 'user', content: 'Hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-2',
        cwd: selectedProject,
        timestamp: '2026-01-01T10:01:00.000Z',
        message: { role: 'assistant', content: 'Hello' },
      }),
    ].join('\n'),
  );

  const list = await listProjectSessions(selectedProject, { projectsRoot });
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].id, 'session-2');

  const transcript = await readSessionTranscript(sessionFile, { projectsRoot });
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[1].text, 'Hello');
});

test('readSessionTranscript preserves valid messages when a jsonl line is malformed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-manager-'));
  const projectsRoot = path.join(tempRoot, '.claude', 'projects');
  const encodedProject = path.join(projectsRoot, '-project');
  const sessionFile = path.join(encodedProject, 'session-malformed.jsonl');

  await fs.mkdir(encodedProject, { recursive: true });
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-malformed',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: { role: 'user', content: 'Still valid' },
      }),
      '{not valid json',
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-malformed',
        timestamp: '2026-01-01T10:01:00.000Z',
        message: { role: 'assistant', content: 'Still readable' },
      }),
    ].join('\n'),
  );

  const transcript = await readSessionTranscript(sessionFile, { projectsRoot });
  assert.equal(transcript.invalidLines, 1);
  assert.equal(transcript.messages.length, 2);
  assert.equal(transcript.messages[0].text, 'Still valid');
  assert.equal(transcript.messages[1].text, 'Still readable');
});
