'use strict';

/**
 * The brief: the agent's understanding, confirmed by the human before any
 * deep research or planning.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');
const core = require('./theseus');
const { startServer } = require('./server');

function env() {
  const copy = { ...process.env };
  delete copy.CLAUDE_PROJECT_DIR;
  delete copy.THESEUS_STATE;
  return copy;
}

function theseus(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: env() });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function ok(dir, ...args) {
  const r = theseus(dir, ...args);
  assert.strictEqual(r.code, 0, `theseus ${args.join(' ')} failed: ${r.err}`);
  return r;
}

function refused(dir, pattern, ...args) {
  const r = theseus(dir, ...args);
  assert.strictEqual(r.code, 1, `expected theseus ${args.join(' ')} to fail, got ${r.code}: ${r.out}`);
  assert.match(r.err, pattern);
  return r;
}

function file(dir, name, value) {
  const full = path.join(path.dirname(dir), `${name}-${path.basename(dir)}.json`);
  fs.writeFileSync(full, JSON.stringify(value));
  return full;
}

const BRIEF = {
  goal: 'Port the leave request screen to SwiftUI',
  understanding: 'Rebuild the RN screen with identical behaviour',
  areas: ['balance rule', 'form states', 'manager approval'],
  out_of_scope: ['the calendar view'],
  questions: ['keep the half-day option?'],
};
const PLAN = [{ title: 'Balance rule', done: 'd', ui: false, tests: ['t'] }];

function run(extra = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  ok(dir, 'init', '--key', 'B', '--reference', 'r', '--test-cmd', 'c', ...extra);
  return dir;
}

test('plan is refused until the brief is confirmed, and works after', () => {
  const dir = run();
  assert.match(ok(dir, 'status').out, /next: write the brief \(light recon only — no deep research yet\): theseus\.js brief --file F/);
  refused(dir, /confirm the brief first/, 'plan', '--file', file(dir, 'plan', PLAN));
  assert.match(ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF)).out, /brief saved \(3 area\(s\)\) — the human confirms it or asks for changes in the viewer/);
  assert.match(ok(dir, 'status').out, /next: human confirms the brief in the viewer; agent runs: theseus\.js wait/);
  refused(dir, /confirm the brief first/, 'plan', '--file', file(dir, 'plan', PLAN));
  refused(dir, /approve in the viewer/, 'approve-brief', '--by', 'me');
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'plan', '--file', file(dir, 'plan', PLAN));
  const stored = JSON.parse(ok(dir, 'status', '--json', '--full').out).run.brief;
  assert.deepStrictEqual([stored.status, stored.areas, stored.out_of_scope, stored.confirmedBy.source], ['confirmed', BRIEF.areas, ['the calendar view'], 'viewer']);
});

test('a brief without goal, understanding or areas is refused', () => {
  const dir = run();
  refused(dir, /the brief has no 'goal'/, 'brief', '--file', file(dir, 'b1', { understanding: 'u', areas: ['a'] }));
  refused(dir, /the brief has no 'understanding'/, 'brief', '--file', file(dir, 'b2', { goal: 'g', areas: ['a'] }));
  refused(dir, /the brief has no 'areas' — list what you will create checkpoints for/, 'brief', '--file', file(dir, 'b3', { goal: 'g', understanding: 'u', areas: [] }));
});

test('requested changes send the brief back to draft and into the inbox; a new brief resets it', () => {
  const dir = run();
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  core.addFeedback(core.resolvePaths(dir), { brief: true, text: 'you missed the notifications' });
  assert.match(ok(dir, 'status').out, /next: revise the brief from the human's feedback/);
  assert.match(ok(dir, 'inbox').out, /you missed the notifications/);
  assert.throws(() => core.approveBrief(core.resolvePaths(dir), { by: 'h', source: 'viewer' }), /the brief has changes requested/);
  ok(dir, 'brief', '--file', file(dir, 'brief2', { ...BRIEF, areas: [...BRIEF.areas, 'notifications'] }));
  assert.strictEqual(JSON.parse(ok(dir, 'status', '--json', '--full').out).run.brief.status, 'pending');
});

test('once checkpoints exist, a new brief is refused', () => {
  const dir = run(['--approvals', 'any']);
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  ok(dir, 'approve-brief', '--by', 'h');
  ok(dir, 'plan', '--file', file(dir, 'plan', PLAN));
  refused(dir, /the checkpoints are already planned — change direction through feedback and theseus\.js add/, 'brief', '--file', file(dir, 'brief', BRIEF));
});

test('a run made before briefs existed plans without one', () => {
  const dir = run();
  const runFile = path.join(dir, '.theseus', 'current', 'run.json');
  const data = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  delete data.briefRequired;
  fs.writeFileSync(runFile, JSON.stringify(data));
  ok(dir, 'plan', '--file', file(dir, 'plan', PLAN));
});

test('wait wakes when the human confirms the brief', async () => {
  const dir = run();
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  const waiting = spawn(process.execPath, [SCRIPT, 'wait', '--timeout', '20'], { cwd: dir, env: env() });
  let out = '';
  waiting.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => setTimeout(resolve, 700));
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  assert.strictEqual(await new Promise(resolve => waiting.on('exit', resolve)), 0);
  assert.match(out, /brief confirmed — now do the research and plan the checkpoints/);
  assert.match(out, /next: plan the checkpoints/);
});

test('the viewer confirms the brief or requests changes on it', async () => {
  const dir = run();
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  const server = await startServer(core.resolvePaths(dir), { port: 0 });
  const post = (route, body) => fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-theseus-token': server.token },
    body: JSON.stringify(body || {}),
  });
  try {
    assert.match((await (await post('/api/feedback', { brief: true, text: 'add notifications' })).json()).message, /Changes requested on the brief/);
    ok(dir, 'brief', '--file', file(dir, 'brief2', BRIEF));
    assert.match((await (await post('/api/approve-brief')).json()).message, /Brief confirmed — the agent can now research and plan/);
    const again = await post('/api/approve-brief');
    assert.strictEqual(again.status, 409);
    assert.match((await again.json()).error, /the brief is already confirmed/);
  } finally {
    await server.close();
  }
});
