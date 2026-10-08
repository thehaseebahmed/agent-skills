'use strict';

/** The coverage review: planned checkpoints are checked against the confirmed plan before the human can approve them. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');
const core = require('./theseus');
const { startServer } = require('./server');
const { viewer } = require('./viewer/viewer');
const { requirementsBrief } = require('./brief-fixture');

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
  fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
  return full;
}

const CHECKPOINTS = [
  { title: 'Balance rule', done: 'a request beyond the balance is rejected', ui: false, tests: ['beyond balance is rejected'] },
  { title: 'Export to CSV', done: 'the list downloads as CSV', ui: true, tests: ['download has every row'] },
];
const FINDINGS = `VERDICT: FINDINGS
FINDINGS: 2
1. acceptance criterion 1 — no checkpoint makes the observable result match the requirement — plan coverage — add a checkpoint whose done states it
2. CP2 — CSV export is not asked for anywhere in the plan — scope creep — remove CP2
SUMMARY: one criterion uncovered and one checkpoint out of scope.
`;
const PASS = 'VERDICT: PASS\nFINDINGS: 0\nSUMMARY: every requirement is covered and nothing is added.\n';

/** A repo with a confirmed plan and the checkpoints loaded, not yet reviewed. */
function planned() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-cov-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  ok(dir, 'init', '--key', 'COV', '--reference', 'r', '--test-cmd', 'c');
  ok(dir, 'plan', '--file', file(dir, 'plan', requirementsBrief()));
  core.approveReqPlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'checkpoints', '--file', file(dir, 'cps', CHECKPOINTS));
  return dir;
}
const approve = dir => core.approveCheckpoints(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });

test('loading checkpoints asks for the coverage review, and the human cannot approve before it', () => {
  const dir = planned();
  const status = ok(dir, 'status').out;
  assert.match(status, /coverage review: none/);
  assert.match(status, /next: coverage review: one isolated theseus-reviewer checks the checkpoints against the plan/);
  assert.throws(() => approve(dir), /the coverage review has not run — one isolated reviewer must check the checkpoints against the confirmed plan/);
});

test('coverage with no flags prints only the plan and the planned checkpoints, for the reviewer', () => {
  const dir = planned();
  const out = ok(dir, 'coverage').out;
  const input = JSON.parse(out);
  assert.strictEqual(input.plan.goal, requirementsBrief().goal);
  assert.deepStrictEqual(input.plan.acceptance_criteria, requirementsBrief().acceptance_criteria);
  assert.strictEqual(input.plan.status, undefined, 'bookkeeping is left out');
  assert.deepStrictEqual(input.checkpoints.map(c => [c.id, c.title]), [['CP1', 'Balance rule'], ['CP2', 'Export to CSV']]);
  assert.deepStrictEqual(input.checkpoints[0].tests, ['beyond balance is rejected']);
  assert.doesNotMatch(out, /next:/, 'reviewer input carries no notices');
});

test('findings block approval until a revised list passes a fresh review', () => {
  const dir = planned();
  assert.match(ok(dir, 'coverage', '--verdict', file(dir, 'findings', FINDINGS)).out, /coverage review NOT passed — 2 finding\(s\)/);
  assert.throws(() => approve(dir), /the coverage review has open findings — revise the checkpoints/);
  assert.match(ok(dir, 'status').out, /next: the coverage review found gaps: a fresh theseus-planner revises the checkpoints/);

  // Reloading the same list changes nothing: the findings still stand.
  ok(dir, 'checkpoints', '--file', file(dir, 'cps', CHECKPOINTS));
  assert.throws(() => approve(dir), /open findings/);

  // A revised list makes the earlier verdict stale; it needs a new review.
  const revised = [{ ...CHECKPOINTS[0], title: 'Balance rule and its message' }];
  ok(dir, 'checkpoints', '--file', file(dir, 'revised', revised));
  assert.match(ok(dir, 'status').out, /coverage review: stale/);
  assert.throws(() => approve(dir), /the coverage review passed against an older checkpoint list|has not run/);

  assert.match(ok(dir, 'coverage', '--verdict', file(dir, 'pass', PASS)).out, /coverage review passed/);
  assert.deepStrictEqual(approve(dir).cps, ['CP1']);
});

test('a pass on one list goes stale when the checkpoints change', () => {
  const dir = planned();
  ok(dir, 'coverage', '--verdict', file(dir, 'pass', PASS));
  ok(dir, 'checkpoints', '--file', file(dir, 'more', [...CHECKPOINTS, { title: 'Third', done: 'd', ui: false, tests: ['t'] }]));
  assert.throws(() => approve(dir), /the coverage review passed against an older checkpoint list — the checkpoints changed/);
});

test('bad coverage records are refused', () => {
  const dir = planned();
  refused(dir, /findings need their details/, 'coverage', '--findings', '2');
  refused(dir, /does not match the verdict's FINDINGS: 2/, 'coverage', '--verdict', file(dir, 'findings', FINDINGS), '--findings', '1');
  refused(dir, /says FINDINGS: 1 but lists 0 numbered findings/, 'coverage', '--verdict', file(dir, 'bad', 'VERDICT: FINDINGS\nFINDINGS: 1\nSUMMARY: x\n'));

  ok(dir, 'coverage', '--findings', '0');
  approve(dir);
  refused(dir, /already approved — the coverage review runs before approval, not after/, 'coverage', '--findings', '0');

  const early = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-cov-')));
  spawnSync('git', ['init', '-q'], { cwd: early });
  ok(early, 'init', '--key', 'E', '--reference', 'r', '--test-cmd', 'c');
  refused(early, /there is no confirmed plan to check the checkpoints against/, 'coverage');
});

test('checkpoints added from human feedback are approved without a coverage review', () => {
  const dir = planned();
  ok(dir, 'coverage', '--findings', '0');
  approve(dir);
  ok(dir, 'add', '--file', file(dir, 'extra', [{ title: 'From feedback', done: 'd', ui: false, tests: ['t'] }]));
  assert.doesNotMatch(ok(dir, 'status').out, /coverage review/);
  assert.deepStrictEqual(approve(dir).cps, ['CP3']);
});

test('isolation none is recorded and warned about', () => {
  const dir = planned();
  ok(dir, 'coverage', '--findings', '0', '--isolation', 'none');
  assert.match(ok(dir, 'status').out, /WARNING: coverage review recorded without context isolation/);
});

test('the viewer state carries every coverage round, and the API refuses approval until it passes', async () => {
  const dir = planned();
  const server = await startServer(core.resolvePaths(dir), { port: 0, ui: viewer() });
  const api = (route, opts = {}) => fetch(`http://127.0.0.1:${server.port}${route}`, { ...opts, headers: { 'content-type': 'application/json', 'x-theseus-token': server.token } });
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
    assert.match(page, /id="coverage"/);
    assert.match(page, /Coverage review/);

    ok(dir, 'coverage', '--verdict', file(dir, 'findings', FINDINGS));
    const blocked = await api('/api/approve-checkpoints', { method: 'POST' });
    assert.strictEqual(blocked.status, 409);
    assert.match((await blocked.json()).error, /coverage review has open findings/);

    let state = await (await api('/api/state')).json();
    assert.strictEqual(state.coverage.state, 'findings');
    assert.strictEqual(state.coverage.evidence.history[0].items[1].where, 'CP2');
    assert.strictEqual(state.coverage.evidence.history[0].items[1].rule, 'scope creep');

    ok(dir, 'checkpoints', '--file', file(dir, 'revised', [CHECKPOINTS[0]]));
    ok(dir, 'coverage', '--verdict', file(dir, 'pass', PASS));
    state = await (await api('/api/state')).json();
    assert.strictEqual(state.coverage.state, 'pass');
    assert.deepStrictEqual(state.coverage.evidence.history.map(h => [h.round, h.verdict]), [[1, 'FINDINGS'], [2, 'PASS']], 'the earlier round is kept');
    assert.strictEqual((await api('/api/approve-checkpoints', { method: 'POST' })).status, 200);
    state = await (await api('/api/state')).json();
    assert.strictEqual(state.coverage.state, 'off', 'approved checkpoints need no further coverage review');
  } finally {
    await server.close();
  }
});
