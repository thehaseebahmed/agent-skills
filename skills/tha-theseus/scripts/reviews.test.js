'use strict';

/**
 * Choosing which reviews run (visual on/off) and how many code reviewers a
 * run deploys (0, 1 or 2 — exactly that many, all clean).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'theseus.js');
const { requirementsBrief } = require('./brief-fixture');
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

/** Every run started by this version needs a confirmed brief before it can plan. */
function confirmBrief(dir) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')), 'brief.json');
  fs.writeFileSync(file, JSON.stringify(requirementsBrief()));
  ok(dir, 'brief', '--file', file);
  const core = require('./theseus');
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}


/** A reviewer's reply with `n` findings, saved to a file for `record … --verdict`. */
function verdict(n) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-verdict-')), 'verdict.txt');
  const items = Array.from({ length: n }, (_, i) => `${i + 1}. src/x.js:${i + 1} — wrong ${i + 1} — rule ${i + 1} — fix ${i + 1}`);
  fs.writeFileSync(file, [`VERDICT: ${n ? 'FINDINGS' : 'PASS'}`, `FINDINGS: ${n}`, ...items, `SUMMARY: ${n} problem(s).`].join('\n'));
  return file;
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

/** A repo with one UI checkpoint begun; `init` takes the extra flags. */
function started(extra = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-rev-')));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync('impl.txt') ? 0 : 1);\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  ok(dir, 'init', '--key', 'R', '--reference', 'mock.html', '--test-cmd', 'node check.js', ...extra);
  const plan = path.join(path.dirname(dir), `plan-${path.basename(dir)}.json`);
  fs.writeFileSync(plan, JSON.stringify([{ title: 'Form', done: 'matches the mock', ui: true, tests: ['error state'] }]));
  confirmBrief(dir);
  ok(dir, 'plan', '--file', plan);
  core.approvePlan(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'begin', 'CP1');
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x\n');
  ok(dir, 'record', 'CP1', 'tests');
  return dir;
}

const gates = dir => JSON.parse(ok(dir, 'status', '--json').out).checkpoints[0].gates;

/** The human clicks Approve in the viewer; the agent never approves. */
function advanceInViewer(dir) {
  return core.doneMessage(core.advance(core.resolvePaths(dir), 'CP1', { by: 'human (viewer)', source: 'viewer' }));
}

function passVisual(dir) {
  ok(dir, 'record', 'CP1', 'visual', '--reviewer', 'look', '--findings', '0');
  ok(dir, 'record', 'CP1', 'visual', '--reviewer', 'behave', '--findings', '0');
}

// ── settings ─────────────────────────────────────────────────────────────────

test('defaults are visual on and two code reviewers; bad values are refused', () => {
  const dir = started();
  const run = JSON.parse(ok(dir, 'status', '--json').out).run;
  assert.deepStrictEqual([run.visual, run.reviewers], ['on', '2']);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-rev-'));
  git(fresh, 'init', '-q');
  refused(fresh, /--reviewers must be 0, 1 or 2, not '3'/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--reviewers', '3');
  refused(fresh, /--visual must be on or off, not 'maybe'/, 'init', '--key', 'K', '--reference', 'r', '--test-cmd', 'c', '--visual', 'maybe');
  refused(dir, /reviewers must be 0, 1 or 2, not '5'/, 'config', '--reviewers', '5');
});

// ── code reviewers ───────────────────────────────────────────────────────────

test('one code reviewer: one clean verdict passes, and a second reviewer is refused', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  assert.match(ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0').out, /gate 3 \(review\) passed — 1 distinct reviewer clean/);
  refused(dir, /this run uses 1 code reviewer: a — re-review with the same id/, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  assert.match(advanceInViewer(dir), /CP1 done/);
});

test('one code reviewer with findings blocks, and a clean re-review with the same id passes', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--verdict', verdict(2));
  refused(dir, /gate 3 \(review\) for CP1 has open findings/, 'advance', 'CP1');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  assert.match(advanceInViewer(dir), /CP1 done/);
});

test('two code reviewers stay capped at two distinct ids', () => {
  const dir = started();
  passVisual(dir);
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--verdict', verdict(1));
  refused(dir, /this run uses 2 code reviewers: a, b — re-review with the same ids/, 'record', 'CP1', 'review', '--reviewer', 'c', '--findings', '0');
});

test('no code reviewers: gate 3 is off, recording is refused, and advance completes', () => {
  const dir = started(['--reviewers', '0']);
  passVisual(dir);
  assert.strictEqual(gates(dir).review, 'off');
  refused(dir, /this run has no code reviewers \(reviewers: 0\)/, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  assert.match(advanceInViewer(dir), /CP1 done/);
});

// ── visual on/off ────────────────────────────────────────────────────────────

test('visual off: a UI checkpoint advances without visual verdicts, and recording one is refused', () => {
  const dir = started(['--visual', 'off']);
  assert.strictEqual(gates(dir).visual, 'off');
  refused(dir, /visual review is off for this run/, 'record', 'CP1', 'visual', '--reviewer', 'look', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  assert.match(advanceInViewer(dir), /CP1 done/);
});

test('with every review off, gates 1 and the human are all that remain', () => {
  const dir = started(['--visual', 'off', '--reviewers', '0']);
  assert.match(ok(dir, 'status').out, /reviews: visual off, code reviewers 0/);
  assert.match(ok(dir, 'status').out, /next: gates passed: theseus\.js advance CP1/);
  assert.strictEqual(theseus(dir, 'check').code, 0, 'the Stop hook lets the session stop');
  assert.match(advanceInViewer(dir), /CP1 done/);
});

// ── changing mid-run ─────────────────────────────────────────────────────────

test('the human lowering 2 → 1 lets one clean reviewer pass; raising it back needs a second', () => {
  const dir = started();
  passVisual(dir);
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  assert.strictEqual(gates(dir).review, 'partial');
  const p = core.resolvePaths(dir);
  core.setSettings(p, { reviewers: '1' }, { source: 'viewer' });
  assert.strictEqual(gates(dir).review, 'pass');
  core.setSettings(p, { reviewers: '2' }, { source: 'viewer' });
  assert.strictEqual(gates(dir).review, 'partial');
  assert.match(ok(dir, 'status').out, /next: gate 3 for CP1: two isolated reviewers/);
});

test('the CLI may raise reviews but not lower them', () => {
  const dir = started(['--reviewers', '1', '--visual', 'off']);
  refused(dir, /loosen settings in the viewer/, 'config', '--reviewers', '0');
  assert.match(ok(dir, 'config', '--reviewers', '2').out, /settings changed — reviewers 1 → 2/);
  assert.match(ok(dir, 'config', '--visual', 'on').out, /settings changed — visual off → on/);
  refused(dir, /loosen settings in the viewer/, 'config', '--visual', 'off');
});

test('a run made before these settings still needs two code reviewers', () => {
  const dir = started();
  const runFile = path.join(dir, '.theseus', 'current', 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  delete run.visual;
  delete run.reviewers;
  fs.writeFileSync(runFile, JSON.stringify(run));
  passVisual(dir);
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  refused(dir, /gate 3 \(review\) for CP1 has fewer than 2 distinct clean reviewers/, 'advance', 'CP1');
});

// ── viewer ───────────────────────────────────────────────────────────────────

test('the viewer can set visual and reviewers, and refuses bad values', async () => {
  const dir = started();
  const server = await startServer(core.resolvePaths(dir), { port: 0 });
  const post = body => fetch(`http://127.0.0.1:${server.port}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-theseus-token': server.token },
    body: JSON.stringify(body),
  });
  try {
    const res = await post({ reviewers: '1', visual: 'off' });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /visual on → off, reviewers 2 → 1/);
    assert.match(ok(dir, 'status').out, /settings changed by human \(viewer\): visual on → off, reviewers 2 → 1/);
    const bad = await post({ reviewers: '3' });
    assert.strictEqual(bad.status, 409);
    assert.match((await bad.json()).error, /reviewers must be 0, 1 or 2, not '3'/);
  } finally {
    await server.close();
  }
});

// ── finding details ──────────────────────────────────────────────────────────

const evidenceOf = (dir, gate) => core.snapshot(core.resolvePaths(dir)).checkpoints[0].evidence[gate];

function reply(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-verdict-')), 'reply.txt');
  fs.writeFileSync(file, text);
  return file;
}

test('a verdict file is parsed into findings, and --findings defaults to its count', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  const file = reply([
    '```',
    'VERDICT: FINDINGS',
    'FINDINGS: 2',
    '1. src/form.js:12 — submits twice on Enter — learnings: one submit per action — disable the button while pending',
    '2. tests/form.test.js — the error test never asserts the message',
    '   it only checks that something rendered',
    'SUMMARY: double submit and a weak test.',
    '```',
  ].join('\n'));
  assert.match(ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--verdict', file).out, /a reported 2 finding\(s\)/);
  const [round] = evidenceOf(dir, 'review').history;
  assert.deepStrictEqual(
    { reviewer: round.reviewer, round: round.round, findings: round.findings, verdict: round.verdict, summary: round.summary },
    { reviewer: 'a', round: 1, findings: 2, verdict: 'FINDINGS', summary: 'double submit and a weak test.' },
  );
  assert.deepStrictEqual(round.items[0], {
    text: 'src/form.js:12 — submits twice on Enter — learnings: one submit per action — disable the button while pending',
    where: 'src/form.js:12', what: 'submits twice on Enter', rule: 'learnings: one submit per action', fix: 'disable the button while pending',
  });
  assert.deepStrictEqual(round.items[1], { text: 'tests/form.test.js — the error test never asserts the message\nit only checks that something rendered' });
});

test('every review round is kept: a clean re-review does not erase the earlier findings', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--verdict', verdict(2));
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--verdict', verdict(0), '--note', 'fixed both');
  const ev = evidenceOf(dir, 'review');
  assert.deepStrictEqual(ev.history.map(h => [h.reviewer, h.round, h.findings, h.items.length]), [['a', 1, 2, 2], ['a', 2, 0, 0]]);
  assert.strictEqual(ev.history[1].note, 'fixed both');
  assert.strictEqual(ev.reviewers.a.findings, 0, 'the gate still judges the latest verdict');
  assert.strictEqual(gates(dir).review, 'pass');
  const cp = core.snapshot(core.resolvePaths(dir)).checkpoints[0];
  assert.strictEqual(cp.fp, ev.history[1].fp, 'the viewer can tell which rounds saw the current code');
  assert.notStrictEqual(cp.fp, undefined);
});

test('findings without details are refused', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  refused(dir, /findings need their details: .*--verdict FILE/, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '1');
  refused(dir, /findings need their details/, 'record', 'CP1', 'visual', '--reviewer', 'look', '--findings', '1');
});

test('a verdict that contradicts itself or --findings is refused', () => {
  const dir = started(['--reviewers', '1']);
  passVisual(dir);
  const rec = file => ['record', 'CP1', 'review', '--reviewer', 'a', '--verdict', file];
  refused(dir, /does not match the verdict's FINDINGS: 2/, ...rec(verdict(2)), '--findings', '1');
  refused(dir, /says FINDINGS: 2 but lists 1 numbered finding$/m, ...rec(reply('VERDICT: FINDINGS\nFINDINGS: 2\n1. a — b — c — d\nSUMMARY: s')));
  refused(dir, /says PASS with FINDINGS: 1 — that is invalid/, ...rec(reply('VERDICT: PASS\nFINDINGS: 1\n1. x\nSUMMARY: s')));
  refused(dir, /has no VERDICT: PASS or VERDICT: FINDINGS line/, ...rec(reply('looks fine to me')));
  refused(dir, /--verdict: '.*nope\.txt' is not a file/, ...rec(path.join(dir, 'nope.txt')));
  assert.strictEqual(evidenceOf(dir, 'review'), null, 'nothing was recorded');
});

test('the viewer state carries each round with its findings', async () => {
  const dir = started();
  ok(dir, 'record', 'CP1', 'visual', '--reviewer', 'look', '--verdict', verdict(1));
  const server = await startServer(core.resolvePaths(dir), { port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { 'x-theseus-token': server.token } });
    const [round] = (await res.json()).checkpoints[0].evidence.visual.history;
    assert.deepStrictEqual([round.reviewer, round.findings, round.items[0].where, round.items[0].fix], ['look', 1, 'src/x.js:1', 'fix 1']);
  } finally {
    await server.close();
  }
});
