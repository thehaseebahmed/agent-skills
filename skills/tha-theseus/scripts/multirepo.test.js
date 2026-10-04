'use strict';

/**
 * Multi-repo runs, driven through the CLI against a throwaway folder holding
 * two git repos, plus the backwards-compatibility guarantee: a single-repo run
 * recorded by the previous version of theseus.js carries on unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');
const core = require('./theseus');
const { requirementsBrief } = require('./brief-fixture');
const PRE_MULTIREPO = '8bf829e';

function env() {
  const copy = { ...process.env };
  delete copy.CLAUDE_PROJECT_DIR;
  delete copy.THESEUS_STATE;
  return copy;
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function cli(script, dir, ...args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: env() });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const theseus = (dir, ...args) => cli(SCRIPT, dir, ...args);

function ok(dir, ...args) {
  const r = theseus(dir, ...args);
  assert.strictEqual(r.code, 0, `theseus ${args.join(' ')} failed: ${r.err}`);
  return r;
}

/** Every run started by this version needs a confirmed brief before it can plan. */
function confirmBrief(dir) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')), 'brief.json');
  fs.writeFileSync(file, JSON.stringify(requirementsBrief()));
  ok(dir, 'brief', '--file', file);
  const core = require('./theseus');
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}

function refused(dir, pattern, ...args) {
  const r = theseus(dir, ...args);
  assert.strictEqual(r.code, 1, `expected theseus ${args.join(' ')} to fail, got ${r.code}: ${r.out}`);
  assert.match(r.err, pattern);
  return r;
}

/** A repo whose tests pass only once its marker file exists. */
function makeRepo(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'check.js'), `process.exit(require('fs').existsSync('${marker}') ? 0 : 1);\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const PLAN = [
  { title: 'Leave API rule', done: 'API rejects overdraw', ui: false, tests: ['rejects overdraw'], repos: ['api'] },
  { title: 'Leave form', done: 'form shows the API error', ui: false, tests: ['shows error'], repos: ['api', 'web'] },
];

/** The human clicks Approve plan in the viewer; the agent never approves. */
function viewerApprovePlan(dir) {
  core.approvePlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}

/** The human clicks Approve in the viewer; the agent never approves. */
function viewerApproveCp(dir, cp) {
  core.advance(core.resolvePaths(dir), cp, { by: 'human (viewer)', source: 'viewer' });
}

/** A parent folder (not a repo) holding api/ and web/, with an approved two-checkpoint plan. */
function workspace({ begin = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-ws-')));
  makeRepo(path.join(dir, 'api'), 'api.done');
  makeRepo(path.join(dir, 'web'), 'web.done');
  ok(dir, 'init', '--key', 'WS-1', '--reference', 'spec.md', '--repos', 'api,web', '--test-cmd', 'node check.js');
  confirmBrief(dir);
  ok(dir, 'plan', '--file', writeJson(path.dirname(dir), `plan-${path.basename(dir)}.json`, PLAN));
  viewerApprovePlan(dir);
  if (begin) ok(dir, 'begin', 'CP1');
  return dir;
}

function passGates(dir, cp, marker) {
  ok(dir, 'record', cp, 'red');
  for (const m of [].concat(marker)) fs.writeFileSync(path.join(dir, m), 'x\n');
  ok(dir, 'record', cp, 'tests');
  ok(dir, 'record', cp, 'visual', '--skip', 'logic only');
  ok(dir, 'record', cp, 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', cp, 'review', '--reviewer', 'b', '--findings', '0');
}

// ── init ─────────────────────────────────────────────────────────────────────

test('init --repos works from a folder that is not a repo and stores per-repo test commands', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-ws-')));
  makeRepo(path.join(dir, 'api'), 'a');
  makeRepo(path.join(dir, 'libs', 'shared'), 'b');
  const out = ok(dir, 'init', '--key', 'K', '--reference', 'r', '--repos', 'api,shared=libs/shared', '--test-cmd', 'npm test', '--test-cmd-shared', 'pnpm test').out;
  assert.match(out, /repos in this run: api \(api\), shared \(libs\/shared\) — every gate covers all of them/);
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'current', 'run.json'), 'utf8'));
  assert.deepStrictEqual(run.repos, [
    { name: 'api', path: 'api', testCmd: null },
    { name: 'shared', path: 'libs/shared', testCmd: 'pnpm test' },
  ]);
});

test('init --repos refuses a folder that is not a repo top level, and duplicate names', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-ws-')));
  makeRepo(path.join(dir, 'api'), 'a');
  fs.mkdirSync(path.join(dir, 'api', 'src'));
  fs.mkdirSync(path.join(dir, 'other'));
  makeRepo(path.join(dir, 'other', 'api'), 'b');
  refused(dir, /--repos: 'api\/src' is not the top level of a git repository/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--repos', 'api/src');
  refused(dir, /--repos: 'nope' is not a folder/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--repos', 'nope');
  refused(dir, /the name 'api' is used twice/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--repos', 'api,other/api');
});

test('single-repo init outside a git repo still fails as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-nogit-'));
  refused(dir, /not inside a git repository/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c');
});

// ── plan ─────────────────────────────────────────────────────────────────────

test('a multi-repo plan needs repos on every checkpoint, from the known set', () => {
  const dir = workspace({ begin: false });
  const add = items => writeJson(path.dirname(dir), `add-${path.basename(dir)}.json`, items);
  refused(dir, /checkpoint 1 \('x'\) needs 'repos' — the repos it changes, from: api, web/, 'add', '--file', add([{ title: 'x', done: 'y', ui: false, tests: ['t'] }]));
  refused(dir, /checkpoint 1 \('x'\) names unknown repo 'mobile' — known: api, web/, 'add', '--file', add([{ title: 'x', done: 'y', ui: false, tests: ['t'], repos: ['mobile'] }]));
  const snap = JSON.parse(ok(dir, 'status', '--json').out);
  assert.deepStrictEqual(snap.checkpoints.map(c => c.repos), [['api'], ['api', 'web']]);
  assert.deepStrictEqual(snap.run.repos, ['api', 'web']);
});

// ── gates ────────────────────────────────────────────────────────────────────

test('begin refuses when any repo in the run is dirty, and names it', () => {
  const dir = workspace({ begin: false });
  fs.writeFileSync(path.join(dir, 'web', 'stray.txt'), 'x');
  refused(dir, /repo 'web' has uncommitted changes/, 'begin', 'CP1');
});

test('red and tests run in each of the checkpoint repos; one failing repo fails gate 1', () => {
  const dir = workspace();
  passGates(dir, 'CP1', 'api/api.done');
  viewerApproveCp(dir, 'CP1');
  commitAll(path.join(dir, 'api'), 'cp1');
  ok(dir, 'begin', 'CP2');
  assert.match(ok(dir, 'record', 'CP2', 'red', '--cmd', 'node -e "process.exit(require(\'fs\').existsSync(\'cp2\') ? 0 : 1)"').out, /red recorded \(failing in api, web\)/);
  fs.writeFileSync(path.join(dir, 'api', 'cp2'), 'x');
  refused(dir, /tests failed in web \(exit 1\) — gate 1 not passed for CP2:\n── web/, 'record', 'CP2', 'tests', '--cmd', 'node -e "process.exit(require(\'fs\').existsSync(\'cp2\') ? 0 : 1)"');
  fs.writeFileSync(path.join(dir, 'web', 'cp2'), 'x');
  assert.match(ok(dir, 'record', 'CP2', 'tests', '--cmd', 'node -e "process.exit(require(\'fs\').existsSync(\'cp2\') ? 0 : 1)"').out, /gate 1 \(tests\) passed in api, web/);
  const full = JSON.parse(ok(dir, 'status', '--json', '--full').out);
  assert.deepStrictEqual(full.checkpoints[1].evidence.tests.runs.map(x => [x.repo, x.exit]), [['api', 0], ['web', 0]]);
});

test('red passing in every repo is refused', () => {
  const dir = workspace();
  fs.writeFileSync(path.join(dir, 'api', 'api.done'), 'x');
  refused(dir, /red run passed in every repo \(api\)/, 'record', 'CP1', 'red');
});

test('a change in a repo the checkpoint does not list makes gates stale and is named', () => {
  const dir = workspace();
  passGates(dir, 'CP1', 'api/api.done');
  fs.writeFileSync(path.join(dir, 'web', 'sneaky.txt'), 'x');
  refused(dir, /gate 1 \(tests\) for CP1 passed against older code/, 'advance', 'CP1');
  assert.match(ok(dir, 'status').out, /warning: CP1 also changed web, which it doesn't list in its repos/);
  assert.match(ok(dir, 'record', 'CP1', 'tests').out, /warning — CP1 also changed web/);
});

test('the multi-repo happy path completes', () => {
  const dir = workspace();
  passGates(dir, 'CP1', 'api/api.done');
  const full = core.advance(core.resolvePaths(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' });
  assert.match(core.doneMessage(full), /CP1 done/);
});

// ── diff ─────────────────────────────────────────────────────────────────────

test('diff covers every repo with name-prefixed paths and leaves out .theseus', () => {
  const dir = workspace();
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'api', 'api.done'), 'api change\n');
  fs.writeFileSync(path.join(dir, 'web', 'note.txt'), 'web change\n');
  const out = ok(dir, 'diff', 'CP1').out;
  assert.match(out, /diff --git a\/api\/api\.done b\/api\/api\.done/);
  assert.match(out, /diff --git a\/web\/note\.txt b\/web\/note\.txt/);
  assert.doesNotMatch(out, /\.theseus/);
});

test('diff --since-review works across repos', () => {
  const dir = workspace();
  passGates(dir, 'CP1', 'api/api.done');
  assert.match(ok(dir, 'diff', 'CP1', '--since-review').out, /^\(no changes since the last review\)/);
  fs.writeFileSync(path.join(dir, 'web', 'fix.txt'), 'fix\n');
  const out = ok(dir, 'diff', 'CP1', '--since-review').out;
  assert.match(out, /b\/web\/fix\.txt/);
  assert.doesNotMatch(out, /api\.done/);
});

// ── finding the run ──────────────────────────────────────────────────────────

test('commands and the Stop hook run inside a repo find the parent run', () => {
  const dir = workspace();
  const deep = path.join(dir, 'web', 'src');
  fs.mkdirSync(deep);
  assert.match(ok(deep, 'status').out, /theseus: WS-1/);
  assert.strictEqual(theseus(deep, 'check').code, 2, 'open gates block the stop from inside a repo');
});

test('a .theseus above the repo that does not list it is ignored', () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-outer-')));
  makeRepo(path.join(outer, 'api'), 'a');
  ok(outer, 'init', '--key', 'OUTER', '--reference', 'r', '--repos', 'api', '--test-cmd', 'c');
  makeRepo(path.join(outer, 'unrelated'), 'b');
  refused(path.join(outer, 'unrelated'), /no active theseus run/, 'status');
  assert.strictEqual(theseus(path.join(outer, 'unrelated'), 'check').code, 0);
});

// ── submodules ───────────────────────────────────────────────────────────────

test('a dirty submodule no longer crashes, and changing it makes gates stale', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-sub-')));
  makeRepo(path.join(root, 'lib'), 'x');
  const app = path.join(root, 'app');
  makeRepo(app, 'impl.txt');
  git(app, 'submodule', 'add', '-q', path.join(root, 'lib'), 'lib');
  git(app, 'commit', '-q', '-m', 'add submodule');
  ok(app, 'init', '--key', 'S', '--reference', 'r', '--test-cmd', 'node check.js');
  confirmBrief(app);
  ok(app, 'plan', '--file', writeJson(root, 'plan.json', [{ title: 't', done: 'd', ui: false, tests: ['x'] }]));
  viewerApprovePlan(app);
  ok(app, 'begin', 'CP1');
  fs.writeFileSync(path.join(app, 'lib', 'inside.txt'), 'dirty submodule\n');
  passGates(app, 'CP1', 'impl.txt');
  fs.writeFileSync(path.join(app, 'lib', 'inside.txt'), 'changed again\n');
  refused(app, /gate 1 \(tests\) for CP1 passed against older code/, 'advance', 'CP1');
});

// ── backwards compatibility ──────────────────────────────────────────────────

test('a single-repo run recorded by the previous version carries on unchanged', t => {
  // The last version before multi-repo support. CI checks out full history so this exists there.
  const committed = spawnSync('git', ['show', `${PRE_MULTIREPO}:skills/tha-theseus/scripts/theseus.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (committed.status !== 0) return t.skip(`commit ${PRE_MULTIREPO} is not in this clone's history`);
  const oldScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-old-')), 'theseus.js');
  fs.writeFileSync(oldScript, committed.stdout);
  const old = (dir, ...args) => {
    const r = cli(oldScript, dir, ...args);
    assert.strictEqual(r.code, 0, `old theseus ${args.join(' ')} failed: ${r.err}`);
    return r;
  };

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-compat-')));
  makeRepo(dir, 'impl.txt');
  // The previous version still had the approvals setting; its own CLI calls keep it.
  old(dir, 'init', '--key', 'OLD', '--reference', 'r', '--test-cmd', 'node check.js', '--approvals', 'any');
  old(dir, 'plan', '--file', writeJson(path.dirname(dir), `compat-${path.basename(dir)}.json`, [
    { title: 'one', done: 'd', ui: false, tests: ['x'] },
    { title: 'two', done: 'd', ui: false, tests: ['y'] },
  ]));
  old(dir, 'approve-plan', '--by', 'h');
  old(dir, 'begin', 'CP1');
  old(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x\n');
  old(dir, 'record', 'CP1', 'tests');
  old(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  old(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  old(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');

  // Same fingerprint, so nothing the old version recorded has gone stale.
  const gates = JSON.parse(ok(dir, 'status', '--json').out).checkpoints[0].gates;
  assert.deepStrictEqual(gates, { red: 'pass', tests: 'pass', visual: 'skip', review: 'pass' });
  // Same diff, byte for byte, and the same since-review behaviour.
  assert.strictEqual(ok(dir, 'diff', 'CP1').out, old(dir, 'diff', 'CP1').out);
  assert.strictEqual(ok(dir, 'diff', 'CP1', '--since-review').out, old(dir, 'diff', 'CP1', '--since-review').out);
  // The new version only accepts viewer approvals, whatever the old run.json says.
  assert.throws(() => core.advance(core.resolvePaths(dir), 'CP1', { by: 'h', source: 'cli' }), /checkpoint approval may only be recorded by the viewer/);
  viewerApproveCp(dir, 'CP1');
  commitAll(dir, 'cp1');
  ok(dir, 'begin', 'CP2');
  const run = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'current', 'run.json'), 'utf8'));
  assert.strictEqual(run.repos, undefined, 'a single-repo run is never rewritten into the multi-repo shape');
  const cps = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'current', 'checkpoints.json'), 'utf8')).checkpoints;
  assert.strictEqual(typeof cps[1].base, 'string');
  return undefined;
});
