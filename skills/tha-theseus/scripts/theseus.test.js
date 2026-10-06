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
const core = require('./theseus');
const { requirementsBrief } = require('./brief-fixture');

const CHECKPOINTS = [
  { title: 'Leave balance domain rule', done: 'balance never goes negative', ui: false, tests: ['rejects a request beyond the balance'] },
  { title: 'Leave request form', done: 'form matches the mock in empty and error states', ui: true, tests: ['shows the error state'] },
];


/** A reviewer's reply with `n` findings, saved to a file for `record … --verdict`. */
function verdict(n) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-verdict-')), 'verdict.txt');
  const items = Array.from({ length: n }, (_, i) => `${i + 1}. src/x.js:${i + 1} — wrong ${i + 1} — rule ${i + 1} — fix ${i + 1}`);
  fs.writeFileSync(file, [`VERDICT: ${n ? 'FINDINGS' : 'PASS'}`, `FINDINGS: ${n}`, ...items, `SUMMARY: ${n} problem(s).`].join('\n'));
  return file;
}
function env() {
  const copy = { ...process.env };
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

/** Every run started by this version needs a confirmed brief before it can plan. */
function confirmBrief(dir) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')), 'brief.json');
  fs.writeFileSync(file, JSON.stringify(requirementsBrief()));
  ok(dir, 'brief', '--file', file);
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}

/** The human clicks Approve plan in the viewer; the agent never approves. */
function viewerApprovePlan(dir) {
  core.approvePlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}

/** The human clicks Approve in the viewer; the agent never approves. */
function viewerApproveCp(dir, cp) {
  core.advance(core.resolvePaths(dir), cp, { by: 'human (viewer)', source: 'viewer' });
}

function refused(dir, pattern, ...args) {
  const result = theseus(dir, ...args);
  assert.strictEqual(result.code, 1, `expected theseus ${args.join(' ')} to fail, got ${result.code}: ${result.out}`);
  assert.match(result.err, pattern);
  return result;
}

/** theseus prints paths with the OS separator; tests assert on the forward-slash form. */
function re(forwardSlashPath) {
  return forwardSlashPath.replace(/\./g, '\\.').replace(/\//g, '[\\\\/]');
}

function writeJsonFile(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/** A repo with an approved two-checkpoint plan, CP1 begun. */
function started(autonomy = 'step') {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'docs/mock.html', '--test-cmd', 'node check.js', '--autonomy', autonomy);
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  viewerApprovePlan(dir);
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
  refused(dir, /waiting for human approval/, 'advance', 'CP1');
  const full = core.advance(core.resolvePaths(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' });
  assert.match(core.doneMessage(full), /CP1 done \(approved by human \(viewer\)\)\. Commit it now\. Next: CP2/);
});

test('begin refuses a checkpoint the human has not approved', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  refused(dir, /CP1 has not been approved by a human/, 'begin', 'CP1');
});

test('checkpoints run in order', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  viewerApprovePlan(dir);
  refused(dir, /CP1 comes first and is not done/, 'begin', 'CP2');
});

test('plan refuses a checkpoint without planned tests', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  const bad = writeJsonFile(os.tmpdir(), `bad-${process.pid}.json`, [{ title: 'x', done: 'y', ui: false, tests: [] }]);
  confirmBrief(dir);
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
  viewerApproveCp(dir, 'CP1');
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
  refused(dir, /gate 3 \(review\) for CP1 has fewer than 2 distinct clean reviewers/, 'advance', 'CP1');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  refused(dir, /fewer than 2 distinct clean reviewers/, 'advance', 'CP1');
});

test('open review findings block advance', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--verdict', verdict(2));
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  refused(dir, /gate 3 \(review\) for CP1 has open findings/, 'advance', 'CP1');
});

test('code changed after review is rejected as stale', () => {
  const dir = started();
  passGates(dir);
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'quietly fixed after review\n');
  refused(dir, /gate 1 \(tests\) for CP1 passed against older code — the code changed after it passed/, 'advance', 'CP1');
});

test('re-running tests after a fix still needs a fresh review', () => {
  const dir = started();
  passGates(dir);
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'fixed\n');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--carry', 'renamed a variable, nothing rendered');
  refused(dir, /gate 3 \(review\) for CP1 passed against older code/, 'advance', 'CP1');
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
  viewerApproveCp(dir, 'CP1');
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
  viewerApproveCp(dir, 'CP1');
  commit(dir, 'CP1');
  ok(dir, 'begin', 'CP2');
  ok(dir, 'record', 'CP2', 'red', '--cmd', 'node -e "process.exit(1)"');
  ok(dir, 'record', 'CP2', 'tests');
  ok(dir, 'record', 'CP2', 'visual', '--reviewer', 'look', '--findings', '0');
  ok(dir, 'record', 'CP2', 'visual', '--reviewer', 'behave', '--findings', '0');
  ok(dir, 'record', 'CP2', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP2', 'review', '--reviewer', 'b', '--findings', '0');
  assert.match(ok(dir, 'advance', 'CP2').out, /CP2 done \(approved by human \(viewer\), batch\)/);
});

test('unattended autonomy defers approval to the PR and status says so', () => {
  const dir = started();
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
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
  viewerApproveCp(dir, 'CP1');
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
  viewerApproveCp(dir, 'CP1');
  commit(dir, 'CP1');
  const extra = writeJsonFile(os.tmpdir(), `extra-${process.pid}.json`, [
    { title: 'Tighten the error copy', done: 'error names the field', ui: false, tests: ['error mentions days'] },
  ]);
  assert.match(ok(dir, 'add', '--file', extra).out, /added CP3/);
  const status = JSON.parse(ok(dir, 'status', '--json', '--full').out);
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
  assert.match(ok(sub, 'status').out, /theseus: HR-7 — autonomy step, approvals viewer-only, checkpoint size s-m/);
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

test('the removed CLI approval commands only print usage', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  for (const removed of ['approve-plan', 'approve-brief']) {
    const result = theseus(dir, removed, '--by', 'me');
    assert.strictEqual(result.code, 1, `${removed} is no longer a command`);
    assert.match(result.out, /usage: theseus\.js <command>/);
  }
  refused(dir, /--approved-by has been removed — approvals are made in the viewer/, 'advance', 'CP1', '--approved-by', 'me');
});

test('advance --approved-by is refused but still parks the checkpoint for the human', async () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  viewerApprovePlan(dir);
  ok(dir, 'begin', 'CP1');
  passGates(dir);
  refused(dir, /--approved-by has been removed — approvals are made in the viewer/, 'advance', 'CP1', '--approved-by', 'me');
  refused(dir, /waiting for human approval \(autonomy: step\)\. Ask the human to approve it in the viewer, then: theseus\.js wait/, 'advance', 'CP1');
});

test('the core refuses an approval that does not come from the viewer', () => {
  const dir = started();
  passGates(dir);
  assert.throws(() => core.advance(core.resolvePaths(dir), 'CP1', { by: 'h', source: 'cli' }), /checkpoint approval may only be recorded by the viewer/);
  assert.throws(() => core.approvePlan(core.resolvePaths(dir), { by: 'h', source: 'cli' }), /plan approval may only be recorded by the viewer/);
  assert.throws(() => core.approveBrief(core.resolvePaths(dir), { by: 'h', source: 'cli' }), /brief approval may only be recorded by the viewer/);
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
  const out = ok(dir, 'agents', '--target', 'claude,copilot', '--planner-model', 'opus', '--planner-model-copilot', 'Claude Opus 4.5 (copilot)').out;
  assert.match(out, new RegExp(`wrote ${re('.claude/agents/theseus-planner.md')} \\(model "opus"\\)`));
  const claude = fs.readFileSync(path.join(dir, '.claude', 'agents', 'theseus-planner.md'), 'utf8');
  const copilot = fs.readFileSync(path.join(dir, '.github', 'agents', 'theseus-planner.agent.md'), 'utf8');
  assert.match(claude, /^---\nname: theseus-planner\ndescription: ".+"\ntools: Read, Grep, Glob\nmodel: "opus"\neffort: medium\nmaxTurns: 40\nomitClaudeMd: true\n---\n/);
  assert.match(copilot, /^---\nname: theseus-planner\ndescription: ".+"\ntools: \['read', 'search'\]\nmodel: "Claude Opus 4\.5 \(copilot\)"\n---\n/);
  assert.match(claude, /## Writing the tests/, 'planner body is the checkpoints.md brief');
  const seams = path.resolve(__dirname, '..', '..', '..', 'references', 'seams.md');
  assert.ok(claude.includes(`[seams](${seams})`), 'relative links are rewritten to the real file');
  assert.doesNotMatch(claude, /\]\(\.\.\//, 'no relative links survive in the agent body');
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
  refused(dir, new RegExp(`${re('.github/agents/theseus-planner.agent.md')} exists and was not generated by theseus`), 'agents', '--target', 'copilot');
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents', 'theseus-planner.md')), 'nothing written on refusal');
  ok(dir, 'agents', '--target', 'claude');
  ok(dir, 'agents', '--target', 'claude', '--planner-model', 'haiku');
});

// ── lean agents ──────────────────────────────────────────────────────────────

test('agents writes planner, builder and reviewer for each tool, with lean Claude-only fields', () => {
  const dir = makeRepo();
  const out = ok(dir, 'agents', '--target', 'claude,copilot').out;
  for (const f of ['.claude/agents/theseus-planner.md', '.claude/agents/theseus-builder.md', '.claude/agents/theseus-reviewer.md',
    '.github/agents/theseus-planner.agent.md', '.github/agents/theseus-builder.agent.md', '.github/agents/theseus-reviewer.agent.md']) {
    assert.match(out, new RegExp(`wrote ${re(f)}`));
  }
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const reviewer = read('.claude/agents/theseus-reviewer.md');
  assert.match(reviewer, /\ntools: Read, Grep, Glob\neffort: medium\nmaxTurns: 30\nomitClaudeMd: true\n/);
  const builder = read('.claude/agents/theseus-builder.md');
  assert.match(builder, /\ntools: Read, Edit, Write, Bash, Grep, Glob\nmaxTurns: 80\n---/);
  assert.doesNotMatch(builder, /omitClaudeMd|effort:/, 'the builder keeps project rules and the session effort');
  assert.match(builder, /# Builder brief/);
  for (const role of ['planner', 'builder', 'reviewer']) {
    assert.doesNotMatch(read(`.github/agents/theseus-${role}.agent.md`), /^(effort|maxTurns|omitClaudeMd):/m, `copilot ${role} has no Claude-only fields`);
  }
  assert.match(read('.github/agents/theseus-builder.agent.md'), /\ntools: \['read', 'edit', 'search', 'execute'\]\n/);
});

test('agents flags override effort and max turns, and inherit drops effort', () => {
  const dir = makeRepo();
  ok(dir, 'agents', '--target', 'claude', '--reviewer-effort', 'low', '--reviewer-max-turns', '12', '--planner-effort', 'inherit');
  assert.match(fs.readFileSync(path.join(dir, '.claude/agents/theseus-reviewer.md'), 'utf8'), /\neffort: low\nmaxTurns: 12\n/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '.claude/agents/theseus-planner.md'), 'utf8'), /^effort:/m);
  refused(dir, /--reviewer-effort must be one of low, medium, high, xhigh, max or inherit, not 'huge'/, 'agents', '--reviewer-effort', 'huge');
  refused(dir, /--builder-max-turns must be a whole number ≥ 1, not '0'/, 'agents', '--builder-max-turns', '0');
});

// ── agents targets ───────────────────────────────────────────────────────────

test('agents with no --target writes only the generic portable files', () => {
  const dir = makeRepo();
  const out = ok(dir, 'agents', '--planner-model-generic', 'gpt-5').out;
  for (const role of ['planner', 'builder', 'reviewer']) {
    assert.match(out, new RegExp(`wrote ${re(`.agents/agents/theseus-${role}.md`)}`));
  }
  assert.doesNotMatch(out, /\.claude|\.github|\.opencode/, 'no harness-specific files without --target');
  const planner = fs.readFileSync(path.join(dir, '.agents', 'agents', 'theseus-planner.md'), 'utf8');
  assert.match(planner, /^---\nname: theseus-planner\ndescription: ".+"\nmodel: "gpt-5"\n---\n/);
  assert.doesNotMatch(planner, /^(tools|effort|maxTurns|omitClaudeMd|mode|permission):/m, 'generic files carry only portable frontmatter');
});

test('agents --target opencode writes subagents with read-only permission locks', () => {
  const dir = makeRepo();
  const out = ok(dir, 'agents', '--target', 'opencode', '--planner-model-opencode', 'anthropic/claude-sonnet-4-5').out;
  assert.match(out, new RegExp(`wrote ${re('.opencode/agents/theseus-planner.md')} \\(model "anthropic/claude-sonnet-4-5"\\)`));
  const read = f => fs.readFileSync(path.join(dir, '.opencode', 'agents', f), 'utf8');
  for (const role of ['planner', 'reviewer']) {
    const text = read(`theseus-${role}.md`);
    assert.match(text, new RegExp(`^---\\nname: theseus-${role}\\ndescription: ".+"\\nmode: subagent\\npermission:\\n  edit: deny\\n  bash: deny\\n  task: deny\\n  todowrite: deny\\n(model: ".+"\\n)?---\\n`), `${role} is a read-only subagent`);
    assert.doesNotMatch(text, /^(tools|effort|maxTurns|omitClaudeMd):/m, `opencode ${role} has no Claude-only fields`);
  }
  const builder = read('theseus-builder.md');
  assert.match(builder, /^---\nname: theseus-builder\ndescription: ".+"\nmode: subagent\n---\n/);
  assert.doesNotMatch(builder, /^permission:/m, 'the builder keeps the default permissions');
});

test('agents refuses an unknown or empty target, and --help writes nothing', () => {
  const dir = makeRepo();
  refused(dir, /--target must be a comma-separated list of generic, claude, opencode, copilot, not 'nope'/, 'agents', '--target', 'nope');
  refused(dir, /--target must name at least one of generic, claude, opencode, copilot/, 'agents', '--target', ',');
  const result = theseus(dir, 'agents', '--help');
  assert.strictEqual(result.code, 0, `agents --help failed: ${result.err}`);
  assert.match(result.out, /^usage: theseus\.js <command>/);
  for (const base of ['.agents', '.claude', '.opencode', '.github']) {
    assert.ok(!fs.existsSync(path.join(dir, base)), `--help writes nothing under ${base}`);
  }
});

// ── settings mid-run ─────────────────────────────────────────────────────────

function viewerRun(extra = []) {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js', ...extra);
  return dir;
}

test('init records the checkpoint size, defaulting to s-m', () => {
  assert.match(ok(viewerRun(), 'status').out, /autonomy step, approvals viewer-only, checkpoint size s-m/);
  assert.match(ok(viewerRun(['--granularity', 'xs-s']), 'status').out, /checkpoint size xs-s/);
  refused(makeRepo(), /--granularity must be xs-s or s-m, not 'huge'/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--granularity', 'huge');
});

test('the CLI may tighten settings but never loosen them', () => {
  const dir = viewerRun(['--autonomy', 'batch:3']);
  assert.match(ok(dir, 'config', '--autonomy', 'step').out, /settings changed — autonomy batch:3 → step/);
  refused(dir, /unattended autonomy can only be enabled in the viewer after the requirements brief is confirmed/, 'config', '--autonomy', 'unattended');
  refused(dir, /loosen settings in the viewer/, 'config', '--autonomy', 'batch:2');
  refused(dir, /give at least one of autonomy, granularity, visual or reviewers/, 'config');
  assert.match(ok(dir, 'config', '--granularity', 'xs-s').out, /granularity s-m → xs-s/);
  refused(dir, /nothing changed — those are already the settings/, 'config', '--granularity', 'xs-s');
  refused(dir, /autonomy must be step, batch:N or unattended, not 'sometimes'/, 'config', '--autonomy', 'sometimes');
});

test('a viewer change to unattended is logged as the human, after the brief is confirmed', () => {
  const dir = viewerRun();
  confirmBrief(dir);
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
  const full = JSON.parse(ok(dir, 'status', '--json', '--full').out);
  const e = full.log.find(x => x.event === 'settings-changed');
  assert.deepStrictEqual([e.source, e.by], ['viewer', 'human (viewer)']);
});

test('a change made in the viewer is announced once on the next CLI command', () => {
  const dir = viewerRun();
  confirmBrief(dir);
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
  assert.match(ok(dir, 'status').out, /^theseus: settings changed by human \(viewer\): autonomy step → unattended\. Follow them from now on\./);
  assert.doesNotMatch(ok(dir, 'status').out, /settings changed —/);
});

test('a checkpoint waiting for approval advances once the human switches to unattended', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  viewerApprovePlan(dir);
  ok(dir, 'begin', 'CP1');
  passGates(dir);
  refused(dir, /waiting for human approval/, 'advance', 'CP1');
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
  const status = ok(dir, 'status').out;
  assert.match(status, /next: autonomy no longer needs a human here: theseus\.js advance CP1/);
  assert.match(ok(dir, 'advance', 'CP1').out, /CP1 done \(approval deferred to PR review\)/);
});

test('wait wakes on a settings change and says what to do', async () => {
  const dir = started();
  passGates(dir);
  refused(dir, /waiting for human approval/, 'advance', 'CP1');
  const waiting = spawn(process.execPath, [SCRIPT, 'wait', '--timeout', '20'], { cwd: dir, env: env() });
  let out = '';
  waiting.stdout.on('data', chunk => { out += chunk; });
  await new Promise(resolve => setTimeout(resolve, 700));
  core.setSettings(core.resolvePaths(dir), { autonomy: 'unattended' }, { source: 'viewer' });
  assert.strictEqual(await new Promise(resolve => waiting.on('exit', resolve)), 0);
  assert.match(out, /settings changed by human \(viewer\): autonomy step → unattended/);
  assert.match(out, /next: autonomy no longer needs a human here: theseus\.js advance CP1/);
});

test('changing autonomy resets batch credit', () => {
  const dir = started('batch:3');
  passGates(dir);
  viewerApproveCp(dir, 'CP1');
  assert.strictEqual(JSON.parse(ok(dir, 'status', '--json').out).run.approvalCredit, 2);
  core.setSettings(core.resolvePaths(dir), { autonomy: 'batch:5' }, { source: 'viewer' });
  assert.strictEqual(JSON.parse(ok(dir, 'status', '--json').out).run.approvalCredit, 0);
});

// ── one settings spec, served to the viewer ──────────────────────────────────

test('the snapshot carries the settings with the choices the viewer may offer', () => {
  const dir = viewerRun();
  const snap = core.snapshot(core.resolvePaths(dir));
  assert.deepStrictEqual(
    { autonomy: snap.settings.autonomy, granularity: snap.settings.granularity, visual: snap.settings.visual, reviewers: snap.settings.reviewers },
    { autonomy: 'step', granularity: 's-m', visual: 'on', reviewers: '2' },
  );
  assert.deepStrictEqual(Object.keys(snap.settings.options), ['autonomy', 'granularity', 'visual', 'reviewers']);
  for (const [key, group] of Object.entries(snap.settings.options)) {
    assert.ok(group.options.length >= 2, `${key} offers its choices`);
    assert.ok(group.options.some(o => o.current), `${key} marks the current value`);
  }
});

test('every offered choice is a setting the run may legally hold', () => {
  const dir = viewerRun();
  confirmBrief(dir);
  const spec = core.snapshot(core.resolvePaths(dir)).settings.options;
  for (const [key, group] of Object.entries(spec)) {
    for (const o of group.options) {
      if (o.current) continue; // setting it again would be refused as "nothing changed"
      assert.doesNotThrow(() => core.setSettings(core.resolvePaths(dir), { [key]: o.value }, { source: 'viewer' }), `${key}: ${o.value}`);
    }
  }
  assert.deepStrictEqual(
    { ...(() => { const s = core.snapshot(core.resolvePaths(dir)).settings; return { autonomy: s.autonomy, granularity: s.granularity, visual: s.visual, reviewers: s.reviewers }; })() },
    { autonomy: 'unattended', granularity: 'xs-s', visual: 'off', reviewers: '0' },
  );
});

test('settings the validators refuse never reach the offered choices, and say exactly why', () => {
  const dir = viewerRun();
  confirmBrief(dir);
  const p = core.resolvePaths(dir);
  const bad = [
    [{ autonomy: 'sometimes' }, /autonomy must be step, batch:N or unattended, not 'sometimes'/],
    [{ granularity: 'huge' }, /granularity must be xs-s or s-m, not 'huge'/],
    [{ visual: 'blue' }, /visual must be on or off, not 'blue'/],
    [{ reviewers: '3' }, /reviewers must be 0, 1 or 2, not '3'/],
  ];
  for (const [changes, pattern] of bad) {
    assert.throws(() => core.setSettings(p, changes, { source: 'viewer' }), pattern);
  }
  for (const [key, group] of Object.entries(core.snapshot(p).settings.options)) {
    for (const o of group.options) assert.ok(bad.every(([changes]) => changes[key] !== o.value), `${key}: ${o.value} is offered but refused`);
  }
});

test('a batch size outside the curated menu is served with a real label', () => {
  const dir = viewerRun(['--autonomy', 'batch:4']);
  const group = core.snapshot(core.resolvePaths(dir)).settings.options.autonomy;
  const synthesized = group.options.find(o => o.value === 'batch:4');
  assert.ok(synthesized, 'batch:4 is offered');
  assert.strictEqual(synthesized.short, 'every 4 checkpoints');
  assert.strictEqual(synthesized.current, true);
  assert.strictEqual(group.options.filter(o => o.current).length, 1);
});

test('unattended is offered only once the brief is confirmed', () => {
  const dir = viewerRun();
  const offered = () => core.snapshot(core.resolvePaths(dir)).settings.options.autonomy.options.find(o => o.value === 'unattended');
  assert.strictEqual(offered().available, false);
  confirmBrief(dir);
  assert.strictEqual(offered().available, true);
});

test('approving the plan records the settings the run proceeds with', () => {
  const dir = makeRepo();
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'docs/mock.html', '--test-cmd', 'node check.js', '--autonomy', 'batch:4');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJsonFile(os.tmpdir(), `cps-${process.pid}.json`, CHECKPOINTS));
  core.setSettings(core.resolvePaths(dir), { reviewers: '1' }, { source: 'viewer' });
  core.approvePlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  const full = JSON.parse(ok(dir, 'status', '--json', '--full').out);
  const entry = full.log.find(e => e.event === 'plan-approved');
  assert.deepStrictEqual(entry.settings, { autonomy: 'batch:4', granularity: 's-m', visual: 'on', reviewers: '1' });
  assert.strictEqual(core.settingsSummary(JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'current', 'run.json'), 'utf8'))), 'every 4 checkpoints · visual on · 1 code reviewer');
});

// ── slimmer output ───────────────────────────────────────────────────────────

test('every command ends with a next line', () => {
  const dir = started();
  assert.match(ok(dir, 'record', 'CP1', 'red').out, /\nnext: make the tests pass: theseus\.js record CP1 tests\n$/);
});

test('status --json leaves out the log and evidence unless --full', () => {
  const dir = started();
  passGates(dir);
  const slim = JSON.parse(ok(dir, 'status', '--json').out);
  assert.strictEqual(slim.log, undefined);
  assert.strictEqual(slim.checkpoints[0].evidence, undefined);
  assert.deepStrictEqual(slim.checkpoints[0].gates, { red: 'pass', tests: 'pass', visual: 'skip', review: 'pass' });
  const full = JSON.parse(ok(dir, 'status', '--json', '--full').out);
  assert.ok(full.log.length > 0);
  assert.ok(full.checkpoints[0].evidence.tests.tail !== undefined);
});

test('diff shows the checkpoint, untracked files included, without the state dir', () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'first\n');
  const out = ok(dir, 'diff', 'CP1').out;
  assert.match(out, /diff --git a\/impl\.txt b\/impl\.txt/);
  assert.match(out, /\+first/);
  assert.doesNotMatch(out, /\.theseus/);
  assert.doesNotMatch(out, /^next:/m, 'diff output is handed to reviewers verbatim');
});

test('diff --since-review shows only what changed after the last review', () => {
  const dir = started();
  refused(dir, /no review recorded yet for CP1/, 'diff', 'CP1', '--since-review');
  passGates(dir);
  assert.match(ok(dir, 'diff', 'CP1', '--since-review').out, /^\(no changes since the last review\)/);
  fs.writeFileSync(path.join(dir, 'fix.txt'), 'the fix\n');
  const out = ok(dir, 'diff', 'CP1', '--since-review').out;
  assert.match(out, /b\/fix\.txt/);
  assert.doesNotMatch(out, /impl\.txt/);
  assert.strictEqual(spawnSync('git', ['status', '--porcelain', '--', 'fix.txt'], { cwd: dir, encoding: 'utf8' }).stdout, '?? fix.txt\n', 'the real index is untouched');
});

test('learn drops duplicates and --replace swaps in a compacted list', () => {
  const dir = started();
  ok(dir, 'learn', '--source', 'reviewer', 'Inject the clock');
  assert.match(ok(dir, 'learn', '--source', 'reviewer', '  inject   the clock ').out, /already learned/);
  ok(dir, 'learn', 'one more rule');
  const merged = writeJsonFile(os.tmpdir(), `merged-${process.pid}.json`, ['inject the clock; no Date.now in handlers']);
  assert.match(ok(dir, 'learn', '--replace', merged).out, /learnings compacted — 2 → 1/);
  assert.strictEqual(ok(dir, 'learnings').out, '- inject the clock; no Date.now in handlers\n');
});
