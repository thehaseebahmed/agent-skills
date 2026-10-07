'use strict';

/** Requirements discovery briefs are complete, resolved, and viewer-approved. */

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
  assert.strictEqual(r.code, 1, `expected refusal: ${r.out}`);
  assert.match(r.err, pattern);
  return r;
}
function file(dir, name, value) {
  const full = path.join(path.dirname(dir), `${name}-${path.basename(dir)}.json`);
  fs.writeFileSync(full, JSON.stringify(value));
  return full;
}

const BRIEF = {
  task: 'Port the leave request screen to SwiftUI',
  goal: 'Deliver the leave-request workflow with the agreed behavior.',
  change_type: 'feature',
  expected_behavior: 'People can submit a valid leave request and understand invalid states.',
  acceptance_criteria: ['A valid request is accepted.', 'Invalid dates explain how to correct them.'],
  user_proposed_approach: 'Copy the React Native component structure in SwiftUI.',
  reviewed_approach: 'The legacy component couples validation and display state.',
  recommended_approach: 'Extract the validation model, then render it in SwiftUI.',
  approach_rationale: 'It preserves behavior while fitting the project convention.',
  checkpoint_areas: ['balance rule', 'form states', 'manager approval'],
  scope_boundaries: ['Do not change the calendar view.'],
  assumptions: [],
  risks: ['The legacy half-day rule needs regression coverage.'],
  resolved_decisions: ['Keep the existing half-day behavior.'],
  unresolved_questions: [],
};
const BUG_BRIEF = { ...BRIEF, task: 'Fix leave validation message', change_type: 'bug', current_behavior: 'A request beyond the balance is accepted without an error.' };
const PLAN = [{ title: 'Balance rule', done: 'd', ui: false, tests: ['t'] }];

function run(extra = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  ok(dir, 'init', '--key', 'B', '--reference', 'r', '--test-cmd', 'c', ...extra);
  return dir;
}

test('planning is blocked until a viewer-confirmed requirements brief exists', () => {
  const dir = run();
  assert.match(ok(dir, 'status').out, /finish requirements discovery in chat/);
  refused(dir, /finish and submit the requirements brief/, 'serve');
  refused(dir, /confirm the brief first/, 'plan', '--file', file(dir, 'plan', PLAN));
  assert.match(ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF)).out, /requirements brief saved/);
  assert.match(ok(dir, 'status').out, /human confirms the requirements brief in the viewer/);
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'plan', '--file', file(dir, 'plan', PLAN));
});

test('feature and bug briefs enforce the requirements schema', () => {
  const feature = run();
  ok(feature, 'brief', '--file', file(feature, 'feature', BRIEF));
  const bug = run();
  ok(bug, 'brief', '--file', file(bug, 'bug', BUG_BRIEF));
  const cases = [
    [/has no 'acceptance_criteria'/, { ...BRIEF, acceptance_criteria: [] }],
    [/has no 'reviewed_approach'/, (() => { const b = { ...BRIEF }; delete b.reviewed_approach; return b; })()],
    [/has no 'current_behavior'/, (() => { const b = { ...BUG_BRIEF }; delete b.current_behavior; return b; })()],
    [/has unresolved questions/, { ...BRIEF, unresolved_questions: ['Which endpoint should we use?'] }],
  ];
  for (const [message, value] of cases) {
    const dir = run();
    refused(dir, message, 'brief', '--file', file(dir, 'invalid', value));
  }
});

test('viewer renders, requests changes on, and approves the richer requirements brief', async () => {
  const dir = run();
  ok(dir, 'brief', '--file', file(dir, 'brief', BUG_BRIEF));
  const server = await startServer(core.resolvePaths(dir), { port: 0 });
  const post = (route, body) => fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-theseus-token': server.token }, body: JSON.stringify(body || {}) });
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.port}/?t=${server.token}`)).text();
    assert.match(page, /Requirements brief/);
    assert.match((await (await post('/api/feedback', { brief: true, text: 'add an acceptance criterion' })).json()).message, /Changes requested on the brief/);
    ok(dir, 'brief', '--file', file(dir, 'brief2', BUG_BRIEF));
    assert.match((await (await post('/api/approve-brief')).json()).message, /Requirements brief approved/);
  } finally { await server.close(); }
});

test('CLI approval commands and approval mode are removed', () => {
  const dir = run();
  refused(dir, /--approvals has been removed/, 'config', '--approvals', 'any');
  refused(dir, /--autonomy unattended is unavailable at initialization/, 'init', '--key', 'other', '--reference', 'r', '--test-cmd', 'c', '--autonomy', 'unattended');
  assert.match(theseus(dir, 'approve-brief', '--by', 'h').out, /usage:/);
  assert.match(theseus(dir, 'approve-plan', '--by', 'h').out, /usage:/);
});

test('unattended autonomy is viewer-only after brief approval', () => {
  const dir = run();
  refused(dir, /unattended autonomy can only be enabled in the viewer/, 'config', '--autonomy', 'unattended');
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  assert.throws(() => core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' }), /confirm the requirements brief/);
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
  assert.strictEqual(JSON.parse(ok(dir, 'status', '--json').out).run.autonomy, 'unattended');
});

test('wait wakes when the viewer confirms the requirements brief', async () => {
  const dir = run();
  ok(dir, 'brief', '--file', file(dir, 'brief', BRIEF));
  const waiting = spawn(process.execPath, [SCRIPT, 'wait', '--timeout', '20'], { cwd: dir, env: env() });
  let out = '';
  waiting.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => setTimeout(resolve, 700));
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  assert.strictEqual(await new Promise(resolve => waiting.on('exit', resolve)), 0);
  assert.match(out, /brief confirmed — now do the research and plan the checkpoints/);
});
