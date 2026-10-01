'use strict';

/**
 * Tests for theseus.js, driven through the CLI against a throwaway git repo —
 * the same surface an agent uses. Each refusal asserts on its specific message,
 * so a rule that quietly stops firing cannot hide behind another one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');

const CHECKPOINTS = [
  { title: 'Leave balance domain rule', done: 'balance never goes negative', ui: false, tests: ['rejects a request beyond the balance'] },
  { title: 'Leave request form', done: 'form matches the mock in empty and error states', ui: true, tests: ['shows the error state'] },
];

function env() {
  const copy = { ...process.env };
  delete copy.THA_PLANS_DIR;
  delete copy.CLAUDE_PROJECT_DIR;
  return copy;
}

function sh(cwd, cmd, args) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env() });
  assert.strictEqual(result.status, 0, `${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/** A repo whose test command passes only once impl.txt exists. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-'));
  sh(dir, 'git', ['init', '-q']);
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync('impl.txt') ? 0 : 1);\n");
  commit(dir, 'initial');
  return dir;
}

function commit(dir, message) {
  sh(dir, 'git', ['add', '-A', '--', '.', ':(exclude).theseus']);
  sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
}

function theseus(dir, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: env() });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function ok(dir, ...args) {
  const result = theseus(dir, ...args);
  assert.strictEqual(result.code, 0, `theseus ${args.join(' ')} failed: ${result.err}`);
  return result;
}

function refused(dir, pattern, ...args) {
  const result = theseus(dir, ...args);
  assert.strictEqual(result.code, 1, `expected theseus ${args.join(' ')} to fail, got ${result.code}: ${result.out}`);
  assert.match(result.err, pattern);
  return result;
}

function writeJsonFile(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** A repo with an approved two-checkpoint plan, CP1 begun. */
function started(autonomy = 'step') {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'docs/mock.html', '--test-cmd', 'node check.js', '--autonomy', autonomy, '--approvals', 'any');
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  ok(dir, 'approve-plan', '--by', 'haseeb');
  ok(dir, 'begin', 'CP1');
  return dir;
}

/** Drive CP1 through gates 1–3. */
function passGates(dir, cp = 'CP1') {
  ok(dir, 'record', cp, 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), `${cp}\n`);
  ok(dir, 'record', cp, 'tests');
  ok(dir, 'record', cp, 'visual', '--skip', 'domain rule only');
  ok(dir, 'record', cp, 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', cp, 'review', '--reviewer', 'b', '--findings', '0');
}

test('the happy path reaches done and suggests the next checkpoint', () => {
  const dir = started();
  passGates(dir);
  const result = ok(dir, 'advance', 'CP1', '--approved-by', 'haseeb');
  assert.match(result.out, /CP1 done \(approved by haseeb, reported by agent\)\. Commit it now\. Next: CP2/);
});

test('begin refuses a checkpoint the human has not approved', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  refused(dir, /CP1 has not been approved by a human/, 'begin', 'CP1');
});

test('checkpoints run in order', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js', '--approvals', 'any');
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  ok(dir, 'approve-plan', '--by', 'h');
  refused(dir, /CP1 comes first and is not done/, 'begin', 'CP2');
});

test('plan refuses a checkpoint without planned tests', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  const bad = writeJsonFile(os.tmpdir(), `bad-${process.pid}.json`, [{ title: 'x', done: 'y', ui: false, tests: [] }]);
  refused(dir, /has no tests — plan the test cases before the human approves/, 'plan', '--file', bad);
});

test('tests cannot be recorded before a failing red run', () => {
  const dir = started();
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  refused(dir, /no failing red run recorded for CP1/, 'record', 'CP1', 'tests');
});

test('a red run that passes is refused', () => {
  const dir = started();
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  refused(dir, /red run passed — the tests for CP1 must fail/, 'record', 'CP1', 'red');
});

test('a failing test command does not pass gate 1', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  refused(dir, /tests failed \(exit 1\) — gate 1 not passed for CP1/, 'record', 'CP1', 'tests');
});

test('gates are recorded in order', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  refused(dir, /cannot record visual: gate 1 \(tests\) for CP1 has not been run/, 'record', 'CP1', 'visual', '--skip', 'x');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  refused(dir, /cannot record review: gate 2 \(visual\) for CP1 has not been run/, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
});

test('the visual gate cannot be skipped without a reason, or on a ui checkpoint', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  refused(dir, /--skip needs a reason/, 'record', 'CP1', 'visual', '--skip');

  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
  commit(dir, 'CP1');
  ok(dir, 'begin', 'CP2');
  ok(dir, 'record', 'CP2', 'red', '--cmd', 'node -e "process.exit(1)"');
  ok(dir, 'record', 'CP2', 'tests');
  refused(dir, /CP2 is flagged ui: true — the visual gate cannot be skipped/, 'record', 'CP2', 'visual', '--skip', 'looks fine');
});

test('one reviewer, or the same reviewer twice, does not pass gate 3', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  refused(dir, /gate 3 \(review\) for CP1 has fewer than 2 distinct clean reviewers/, 'advance', 'CP1', '--approved-by', 'h');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  refused(dir, /fewer than 2 distinct clean reviewers/, 'advance', 'CP1', '--approved-by', 'h');
});

test('open review findings block advance', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '2');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  refused(dir, /gate 3 \(review\) for CP1 has open findings/, 'advance', 'CP1', '--approved-by', 'h');
});

test('code changed after review is rejected as stale', () => {
  const dir = started();
  passGates(dir);
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'quietly fixed after review\n');
  refused(dir, /gate 1 \(tests\) for CP1 passed against older code — the code changed after it passed/, 'advance', 'CP1', '--approved-by', 'h');
});

test('re-running tests after a fix still needs a fresh review', () => {
  const dir = started();
  passGates(dir);
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'fixed\n');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--carry', 'renamed a variable, nothing rendered');
  refused(dir, /gate 3 \(review\) for CP1 passed against older code/, 'advance', 'CP1', '--approved-by', 'h');
});

test('a visual carry needs an earlier visual pass', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  refused(dir, /--carry needs an earlier visual pass for CP1/, 'record', 'CP1', 'visual', '--carry', 'nothing visible');
});

test('committing mid-checkpoint does not make passed gates stale', () => {
  const dir = started();
  passGates(dir);
  commit(dir, 'wip');
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
});

test('step autonomy waits for a human before marking done', () => {
  const dir = started('step');
  passGates(dir);
  refused(dir, /gates 1–3 passed for CP1; waiting for human approval \(autonomy: step\)/, 'advance', 'CP1');
  const status = JSON.parse(ok(dir, 'status', '--json').out);
  assert.strictEqual(status.checkpoints[0].status, 'awaiting-approval');
});

test('batch autonomy lets one approval cover N checkpoints', () => {
  const dir = started('batch:2');
  passGates(dir);
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
  commit(dir, 'CP1');
  ok(dir, 'begin', 'CP2');
  ok(dir, 'record', 'CP2', 'red', '--cmd', 'node -e "process.exit(1)"');
  ok(dir, 'record', 'CP2', 'tests');
  ok(dir, 'record', 'CP2', 'visual', '--reviewer', 'look', '--findings', '0');
  ok(dir, 'record', 'CP2', 'visual', '--reviewer', 'behave', '--findings', '0');
  ok(dir, 'record', 'CP2', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP2', 'review', '--reviewer', 'b', '--findings', '0');
  assert.match(ok(dir, 'advance', 'CP2').out, /CP2 done \(approved by h, reported by agent, batch\)/);
});

test('unattended autonomy defers approval to the PR and status says so', () => {
  const dir = started('unattended');
  passGates(dir);
  assert.match(ok(dir, 'advance', 'CP1').out, /approval deferred to PR review/);
  assert.match(ok(dir, 'status').out, /approval deferred to PR review: CP1/);
});

test('reviews without isolation are flagged in status', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0', '--isolation', 'none');
  assert.match(ok(dir, 'status').out, /WARNING: reviewed without context isolation: CP1/);
});

test('begin refuses a dirty working tree', () => {
  const dir = started();
  passGates(dir);
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
  refused(dir, /uncommitted changes — commit the previous checkpoint/, 'begin', 'CP2');
});

test('status --json carries every checkpoint with its done-criteria and tests', () => {
  const dir = started();
  const snap = JSON.parse(ok(dir, 'status', '--json').out);
  assert.deepStrictEqual(snap.checkpoints.map(c => [c.id, c.status]), [['CP1', 'building'], ['CP2', 'pending']]);
  assert.strictEqual(snap.checkpoints[1].done, 'form matches the mock in empty and error states');
  assert.deepStrictEqual(snap.checkpoints[1].tests, ['shows the error state']);
  assert.deepStrictEqual(snap.checkpoints[0].gates, { red: 'none', tests: 'none', visual: 'none', review: 'none' });
});

test('added checkpoints need approval and pass through every gate', () => {
  const dir = started();
  passGates(dir);
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
  commit(dir, 'CP1');
  const extra = writeJsonFile(os.tmpdir(), `extra-${process.pid}.json`, [
    { title: 'Tighten the error copy', done: 'error names the field', ui: false, tests: ['error mentions days'] },
  ]);
  assert.match(ok(dir, 'add', '--file', extra).out, /added CP3/);
  const status = JSON.parse(ok(dir, 'status', '--json').out);
  assert.strictEqual(status.checkpoints[2].origin, 'feedback');
  assert.strictEqual(status.checkpoints[2].approved, false);
  refused(dir, /CP3 has not been approved by a human/, 'begin', 'CP3');
});

test('check blocks a stop only while gates are open, and gives up after three blocks', () => {
  const dir = started();
  for (let i = 1; i <= 3; i++) {
    const result = theseus(dir, 'check');
    assert.strictEqual(result.code, 2, `block ${i} should exit 2`);
    assert.match(result.err, new RegExp(`CP1 'Leave balance domain rule' still has open gates .*\\(block ${i}/3\\)`));
  }
  assert.strictEqual(theseus(dir, 'check').code, 0);
});

test('check lets the session stop while waiting for human approval', () => {
  const dir = started();
  passGates(dir);
  refused(dir, /waiting for human approval/, 'advance', 'CP1');
  assert.strictEqual(theseus(dir, 'check').code, 0);
});

test('check exits 0 outside a run and outside git', () => {
  assert.strictEqual(theseus(makeRepo(), 'check').code, 0);
  assert.strictEqual(theseus(fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-')), 'check').code, 0);
});

test('learn stores a rule in learnings.json and learnings prints it', () => {
  const dir = started();
  ok(dir, 'learn', '--cp', 'CP1', '--source', 'reviewer', 'inject the clock; never call Date.now in handlers');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'learnings.json'), 'utf8'));
  assert.deepStrictEqual(stored.map(l => [l.text, l.cp, l.source]), [['inject the clock; never call Date.now in handlers', 'CP1', 'reviewer']]);
  assert.strictEqual(ok(dir, 'learnings').out, '- inject the clock; never call Date.now in handlers\n');
});

test('archive refuses an unfinished run', () => {
  refused(started(), /only a finished run can be archived/, 'archive');
});

test('init creates .theseus in the working directory, and commands find it from a subfolder', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  assert.ok(fs.existsSync(path.join(dir, '.theseus', 'current', 'run.json')));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.theseus', '.gitignore'), 'utf8'), 'server.json\nserver.log\n*.tmp\n');
  const sub = path.join(dir, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  assert.match(ok(sub, 'status').out, /theseus: HR-7 — autonomy step, approvals viewer/);
});

test('a second init anywhere inside an active run is refused', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  refused(sub, /a run is already active \(key HR-7\)/, 'init', '--key', 'X', '--reference', 'r', '--test-cmd', 'c');
});

test('commands outside a run say there is no active run', () => {
  refused(makeRepo(), /no active theseus run/, 'status');
});

test('viewer approval mode refuses approvals typed on the command line', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  refused(dir, /approve in the viewer — this run only accepts approvals the human clicks there/, 'approve-plan', '--by', 'me');
});

test('viewer approval mode refuses advance --approved-by but still parks the checkpoint for the human', async () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  const core = require('./theseus');
  core.approvePlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'begin', 'CP1');
  passGates(dir);
  refused(dir, /approve in the viewer/, 'advance', 'CP1', '--approved-by', 'me');
  refused(dir, /waiting for human approval \(autonomy: step\)\. Ask the human to approve it in the viewer, then: theseus\.js wait/, 'advance', 'CP1');
});

test('any approval mode records CLI approvals as reported by the agent', () => {
  const dir = started();
  passGates(dir);
  ok(dir, 'advance', 'CP1', '--approved-by', 'h');
  const snap = JSON.parse(ok(dir, 'status', '--json').out);
  assert.deepStrictEqual(snap.checkpoints[0].approval, { by: 'h', source: 'cli' });
  assert.deepStrictEqual(snap.warnings.cliApprovals, ['CP1']);
});

test('wait times out with a clear message when the human has not acted', () => {
  refused(started(), /no approval or feedback yet after 1s/, 'wait', '--timeout', '1');
});

test('wait returns when the human approves in the viewer', async () => {
  const dir = started();
  passGates(dir);
  refused(dir, /waiting for human approval/, 'advance', 'CP1');
  const waiting = spawn(process.execPath, [SCRIPT, 'wait', '--timeout', '20'], { cwd: dir, env: env() });
  let out = '';
  waiting.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => setTimeout(resolve, 700));
  const core = require('./theseus');
  core.advance(core.resolvePaths(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' });
  const code = await new Promise(resolve => waiting.on('exit', resolve));
  assert.strictEqual(code, 0);
  assert.match(out, /theseus: CP1 approved/);
});

test('inbox prints unread feedback once', () => {
  const dir = started();
  const core = require('./theseus');
  core.addFeedback(core.resolvePaths(dir), { cp: null, text: 'make the error copy friendlier' });
  assert.match(ok(dir, 'inbox').out, /- \[general\] make the error copy friendlier/);
  assert.match(ok(dir, 'inbox').out, /no unread feedback/);
});

test('agents writes Claude and Copilot files with a single-string model and the brief as body', () => {
  const dir = makeRepo();
  const out = ok(dir, 'agents', '--planner-model', 'opus', '--planner-model-copilot', 'Claude Opus 4.5 (copilot)').out;
  assert.match(out, /wrote \.claude\/agents\/theseus-planner\.md \(model "opus"\)/);
  const claude = fs.readFileSync(path.join(dir, '.claude', 'agents', 'theseus-planner.md'), 'utf8');
  const copilot = fs.readFileSync(path.join(dir, '.github', 'agents', 'theseus-planner.agent.md'), 'utf8');
  assert.match(claude, /^---\nname: theseus-planner\ndescription: ".+"\ntools: Read, Grep, Glob\nmodel: "opus"\n---\n/);
  assert.match(copilot, /^---\nname: theseus-planner\ndescription: ".+"\ntools: \['read', 'search'\]\nmodel: "Claude Opus 4\.5 \(copilot\)"\n---\n/);
  const brief = fs.readFileSync(path.join(__dirname, '..', 'checkpoints.md'), 'utf8').trim();
  assert.ok(claude.trimEnd().endsWith(brief), 'planner body is the checkpoints.md brief');
  const reviewer = fs.readFileSync(path.join(dir, '.claude', 'agents', 'theseus-reviewer.md'), 'utf8');
  assert.match(reviewer, /## You are an adversarial reviewer/);
  assert.doesNotMatch(reviewer, /Hand this file \*\*verbatim\*\*/);
});

test('agents omits model when none is given, so the agent inherits the session model', () => {
  const dir = makeRepo();
  assert.match(ok(dir, 'agents', '--target', 'claude').out, /theseus-reviewer\.md \(inherits the session model\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.claude', 'agents', 'theseus-reviewer.md'), 'utf8'), /^model:/m);
  assert.ok(!fs.existsSync(path.join(dir, '.github', 'agents')));
});

test('agents refuses to overwrite an agent file it did not generate', () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'agents', 'theseus-planner.agent.md'), 'hand written\n');
  refused(dir, /\.github\/agents\/theseus-planner\.agent\.md exists and was not generated by theseus/, 'agents');
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'theseus-planner.md')), 'nothing written on refusal');
  ok(dir, 'agents', '--target', 'claude');
  ok(dir, 'agents', '--target', 'claude', '--planner-model', 'haiku');
});
