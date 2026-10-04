'use strict';

/**
 * Several runs: starting, pausing, switching, completing, abandoning, and the
 * history they leave behind — through the CLI and the viewer's API.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');
const core = require('./theseus');
const { requirementsBrief } = require('./brief-fixture');
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

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

const viewer = dir => core.resolvePaths(dir);

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-runs-')));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync(process.argv[2] || 'impl.txt') ? 0 : 1);\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

/** Start run `key`, confirm its brief and a one-checkpoint plan. */
function startRun(dir, key, extra = []) {
  ok(dir, 'init', '--key', key, '--reference', 'r', '--test-cmd', `node check.js ${key}.done`, ...extra);
  const brief = path.join(path.dirname(dir), `brief-${key}-${path.basename(dir)}.json`);
  fs.writeFileSync(brief, JSON.stringify(requirementsBrief({ goal: `goal ${key}` })));
  ok(dir, 'brief', '--file', brief);
  core.approveBrief(viewer(dir), { by: 'human (viewer)', source: 'viewer' });
  const plan = path.join(path.dirname(dir), `plan-${key}-${path.basename(dir)}.json`);
  fs.writeFileSync(plan, JSON.stringify([{ title: `${key} one`, done: 'd', ui: false, tests: ['t'] }]));
  ok(dir, 'plan', '--file', plan);
  core.approvePlan(viewer(dir), { by: 'human (viewer)', source: 'viewer' });
}

/** Drive CP1 of the active run to done and commit it. */
function finishCp1(dir, key) {
  ok(dir, 'begin', 'CP1');
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, `${key}.done`), 'x\n');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  core.advance(viewer(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' });
  git(dir, 'add', '-A', '--', '.', ':(exclude).theseus');
  git(dir, 'commit', '-q', '-m', `${key} CP1`);
}

const runsJson = dir => JSON.parse(ok(dir, 'runs', '--json').out);

// ── several open runs ────────────────────────────────────────────────────────

test('a second init pauses the first run; runs lists both with the new one active', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  const out = ok(dir, 'init', '--key', 'TWO', '--reference', 'r', '--test-cmd', 'c').out;
  assert.match(out, /run 'ONE' is paused; resume it later with: theseus\.js switch ONE/);
  assert.deepStrictEqual(runsJson(dir).map(r => [r.key, r.active, r.place, r.status]), [['TWO', true, 'current', 'open'], ['ONE', false, 'runs', 'open']]);
  assert.match(ok(dir, 'runs').out, /\* TWO\s+active/);
  assert.match(ok(dir, 'runs').out, / {3}ONE\s+paused/);
});

test('a duplicate key is refused', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  ok(dir, 'init', '--key', 'TWO', '--reference', 'r', '--test-cmd', 'c');
  refused(dir, /a run with key 'ONE' already exists — pick another key, or resume it with: theseus\.js switch ONE/, 'init', '--key', 'ONE', '--reference', 'r', '--test-cmd', 'c');
});

test('switch changes which run status and record act on', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  startRun(dir, 'TWO');
  assert.match(ok(dir, 'status').out, /theseus: TWO/);
  assert.match(ok(dir, 'switch', 'ONE').out, /run ONE is now active; TWO is paused/);
  assert.match(ok(dir, 'status').out, /theseus: ONE/);
  finishCp1(dir, 'ONE');
  assert.match(ok(dir, 'status', '--run', 'TWO').out, /CP1\s+pending/);
  assert.match(ok(dir, 'status').out, /CP1\s+done/);
});

test('switching or starting a run is refused mid-checkpoint and allowed between checkpoints', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  startRun(dir, 'TWO');
  ok(dir, 'begin', 'CP1');
  refused(dir, /CP1 of run TWO is still 'building' — finish it \(or get it approved\) before switching runs/, 'switch', 'ONE');
  refused(dir, /CP1 of run TWO is still 'building' — finish it \(or get it approved\) before starting another run/, 'init', '--key', 'THREE', '--reference', 'r', '--test-cmd', 'c');
  refused(dir, /unknown run 'NOPE' — known: TWO, ONE/, 'switch', 'NOPE');
});

test('--run is read-only', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  startRun(dir, 'TWO');
  refused(dir, /--run only works with status and diff/, 'begin', 'CP1', '--run', 'ONE');
});

// ── completing and abandoning ────────────────────────────────────────────────

test('complete is refused while a checkpoint is unfinished', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  refused(dir, /only a finished run can be completed — every checkpoint must be done; to stop early: theseus\.js abandon/, 'complete');
});

test('complete waits for the human; confirming saves a summary and moves the run to history', () => {
  const dir = repo();
  startRun(dir, 'ONE', []);
  finishCp1(dir, 'ONE');
  assert.match(ok(dir, 'complete').out, /run ONE is waiting for the human to confirm it complete in the viewer/);
  refused(dir, /run ONE is waiting for the human to confirm it complete/, 'add', '--file', 'x.json');
  refused(dir, /--approved-by has been removed — approvals are made in the viewer/, 'complete', '--approved-by', 'me');
  const result = core.closeRun(viewer(dir), 'confirm', { source: 'viewer', by: 'human (viewer)' });
  assert.strictEqual(result.final, 'completed');
  const summary = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'archive', 'ONE', 'summary.json'), 'utf8'));
  assert.deepStrictEqual(summary.checkpoints, { done: 1, total: 1 });
  assert.deepStrictEqual(summary.approvals, { viewer: 1, deferred: 0 });
  assert.deepStrictEqual(summary.reviews.code, { verdicts: 2, findings: 0 });
  assert.strictEqual(summary.status, 'completed');
  refused(dir, /no active theseus run/, 'status');
  assert.deepStrictEqual(runsJson(dir).map(r => [r.key, r.place, r.status]), [['ONE', 'archive', 'completed']]);
  assert.match(ok(dir, 'status', '--run', 'ONE').out, /theseus: ONE/);
});

test('keep open returns a pending completion to open', () => {
  const dir = repo();
  startRun(dir, 'ONE', []);
  finishCp1(dir, 'ONE');
  ok(dir, 'complete');
  assert.deepStrictEqual(core.closeRun(viewer(dir), 'keep', { source: 'viewer', by: 'human (viewer)' }), { kept: true });
  assert.match(ok(dir, 'status').out, /next: every checkpoint is done: the human reviews the whole feature, then theseus\.js complete/);
});

test('abandon needs a reason, and once confirmed the run is closed with it', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  refused(dir, /--reason is required/, 'abandon');
  assert.match(ok(dir, 'abandon', '--reason', 'scope changed').out, /run ONE is waiting for the human to confirm it abandoned in the viewer/);
  refused(dir, /--approved-by has been removed — approvals are made in the viewer/, 'abandon', '--reason', 'scope changed', '--approved-by', 'me');
  core.closeRun(viewer(dir), 'confirm', { source: 'viewer', by: 'human (viewer)' });
  const summary = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'archive', 'ONE', 'summary.json'), 'utf8'));
  assert.deepStrictEqual([summary.status, summary.reason], ['abandoned', 'scope changed']);
  refused(dir, /no active theseus run/, 'begin', 'CP1');
  refused(dir, /run ONE is abandoned — closed runs can be viewed but not resumed/, 'switch', 'ONE');
});

test('after closing, the hint names the paused runs to resume', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  startRun(dir, 'TWO');
  ok(dir, 'abandon', '--reason', 'x');
  core.closeRun(viewer(dir), 'confirm', { source: 'viewer', by: 'human (viewer)' });
  refused(dir, /no active theseus run — open runs: ONE — resume one with theseus\.js switch KEY/, 'status');
  ok(dir, 'switch', 'ONE');
  assert.match(ok(dir, 'status').out, /theseus: ONE/);
});

test('archive is now an alias for complete', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  finishCp1(dir, 'ONE');
  assert.match(ok(dir, 'archive').out, /run ONE is waiting for the human to confirm it complete in the viewer/);
  core.closeRun(viewer(dir), 'confirm', { source: 'viewer', by: 'human (viewer)' });
  assert.ok(fs.existsSync(path.join(dir, '.theseus', 'archive', 'ONE', 'summary.json')));
});

test('wait notices when the human completes the run in the viewer', async () => {
  const dir = repo();
  startRun(dir, 'ONE', []);
  finishCp1(dir, 'ONE');
  ok(dir, 'complete');
  const waiting = spawn(process.execPath, [SCRIPT, 'wait', '--timeout', '20'], { cwd: dir, env: env() });
  let out = '';
  waiting.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => setTimeout(resolve, 700));
  core.closeRun(viewer(dir), 'confirm', { source: 'viewer', by: 'human (viewer)' });
  assert.strictEqual(await new Promise(resolve => waiting.on('exit', resolve)), 0);
  assert.match(out, /theseus: run ONE is now completed/);
});

// ── older layouts ────────────────────────────────────────────────────────────

test('an archive folder from earlier versions shows in history as completed', () => {
  const dir = repo();
  startRun(dir, 'ONE');
  const legacy = path.join(dir, '.theseus', 'archive', 'OLD');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'run.json'), JSON.stringify({ key: 'OLD', created: '2026-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(legacy, 'checkpoints.json'), JSON.stringify({ checkpoints: [{ id: 'CP1', status: 'done' }] }));
  assert.deepStrictEqual(runsJson(dir).find(r => r.key === 'OLD'), { key: 'OLD', status: 'completed', active: false, place: 'archive', done: 1, total: 1, lastActivity: '2026-01-01T00:00:00Z' });
});

// ── viewer API ───────────────────────────────────────────────────────────────

test('the viewer lists runs, opens one read-only, switches, and confirms or keeps a close', async () => {
  const dir = repo();
  startRun(dir, 'ONE', []);
  startRun(dir, 'TWO', []);
  const server = await startServer(viewer(dir), { port: 0 });
  const call = (route, body) => fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-theseus-token': server.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.deepStrictEqual((await (await call('/api/runs')).json()).map(r => r.key), ['TWO', 'ONE']);
    const other = await (await call('/api/state?run=ONE')).json();
    assert.strictEqual(other.run.key, 'ONE');
    assert.strictEqual(other.checkpoints[0].title, 'ONE one');

    ok(dir, 'begin', 'CP1');
    const blocked = await call('/api/switch', { key: 'ONE' });
    assert.strictEqual(blocked.status, 409);
    assert.match((await blocked.json()).error, /CP1 of run TWO is still 'building'/);

    // Finish TWO's checkpoint, which frees the working tree for a switch.
    ok(dir, 'record', 'CP1', 'red');
    fs.writeFileSync(path.join(dir, 'TWO.done'), 'x\n');
    for (const args of [['tests'], ['visual', '--skip', 'logic'], ['review', '--reviewer', 'a', '--findings', '0'], ['review', '--reviewer', 'b', '--findings', '0']]) ok(dir, 'record', 'CP1', ...args);
    core.advance(viewer(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' });
    git(dir, 'add', '-A', '--', '.', ':(exclude).theseus');
    git(dir, 'commit', '-q', '-m', 'TWO CP1');
    const switched = await call('/api/switch', { key: 'ONE' });
    assert.match((await switched.json()).message, /ONE is now the active run; TWO is paused/);

    finishCp1(dir, 'ONE');
    ok(dir, 'complete');
    assert.match((await (await call('/api/close', { decision: 'keep' })).json()).message, /Kept open/);
    ok(dir, 'complete');
    assert.match((await (await call('/api/close', { decision: 'confirm' })).json()).message, /Run ONE completed/);
    const history = await (await call('/api/state?run=ONE')).json();
    assert.strictEqual(history.summary.status, 'completed');
    const none = await (await call('/api/state')).json();
    assert.match(none.error, /no active theseus run — open runs: TWO/);
    assert.deepStrictEqual(none.runs.map(r => r.key), ['TWO', 'ONE']);
  } finally {
    await server.close();
  }
});
