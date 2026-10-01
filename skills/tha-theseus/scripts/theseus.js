#!/usr/bin/env node
'use strict';

/**
 * theseus.js — the gate keeper for the tha-theseus workflow.
 *
 * A gate written as prose is advice: an agent under pressure talks its way
 * past it. This script is the only thing that may mark a checkpoint done, and
 * it will not do so until every gate has evidence recorded against the code as
 * it stands now. It runs the test commands itself rather than taking the
 * agent's word, and it fingerprints the working tree so a fix made after a
 * review cannot ride through on the old verdict.
 *
 * It stops mistakes and shortcuts, not malice: an agent that forges a reviewer
 * verdict with `record` will get past it. SKILL.md says so out loud.
 *
 * Node builtins only. Exit codes: 0 ok, 1 error or gate not passed, and 2 only
 * from `check`, which is how a Claude Code Stop hook blocks a premature stop.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REVIEWERS_REQUIRED = 2;
const MAX_STOP_BLOCKS = 3;
const OUTPUT_TAIL_LINES = 40;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const AUTONOMY = /^(step|unattended|batch:[1-9]\d*)$/;

const USAGE = `usage: theseus.js <command> [args]

  init --key K --reference R --test-cmd C [--arch a.md,b.md] [--autonomy step|batch:N|unattended]
  plan --file checkpoints.json        load the checkpoint list (replaces an unstarted plan)
  add --file checkpoints.json         append checkpoints, e.g. from human feedback
  approve-plan --by NAME              the human approves every unapproved checkpoint
  render                              rewrite checkpoints.md from state
  begin CP                            start a checkpoint (needs a clean tree)
  record CP red   [--cmd C]           run the tests; they must FAIL
  record CP tests [--cmd C]           gate 1: run the tests; they must pass
  record CP visual --reviewer ID --findings N [--isolation none] [--note T]
  record CP visual --skip "reason"    only for checkpoints with ui: false
  record CP visual --carry "reason"   re-use an earlier visual pass after a non-visual fix
  record CP review --reviewer ID --findings N [--isolation none] [--note T]
  advance CP [--approved-by NAME]     gate 4 and mark done
  learn --cp CP --source reviewer|human|other "one-line rule"
  status [--json]
  check                               for a Stop hook: exit 2 while gates are open
  archive                             move a finished run to archive/<key>/`;

class GateError extends Error {}

function fail(message) {
  throw new GateError(message);
}

// ── arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { positionals, flags };
}

function requireFlag(flags, name, hint) {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) {
    fail(`--${name} is required${hint ? ` — ${hint}` : ''}`);
  }
  return value.trim();
}

// ── git and paths ────────────────────────────────────────────────────────────

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function resolvePaths(cwd) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.status !== 0) {
    fail('not inside a git repository — theseus fingerprints the working tree with git');
  }
  const root = top.stdout.trim();
  // Same resolution as tha-planning, so both skills keep their state together.
  const plans = process.env.THA_PLANS_DIR
    ? path.join(process.env.THA_PLANS_DIR, path.basename(root))
    : path.join(root, 'plans');
  const base = path.join(plans, 'theseus');
  const run = path.join(base, 'current');
  return {
    root,
    base,
    run,
    runFile: path.join(run, 'run.json'),
    cpFile: path.join(run, 'checkpoints.json'),
    mdFile: path.join(run, 'checkpoints.md'),
    evidence: path.join(run, 'evidence'),
    learnings: path.join(base, 'learnings.md'),
    archive: path.join(base, 'archive'),
  };
}

/** Pathspec covering the repo minus our own state, so recording never dirties the fingerprint. */
function pathspec(p) {
  const rel = path.relative(p.root, p.base);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ['.'];
  return ['.', `:(exclude)${rel.split(path.sep).join('/')}`];
}

function headOrEmptyTree(root) {
  const head = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return head.status === 0 ? head.stdout.trim() : EMPTY_TREE;
}

/**
 * Hash of every change since the checkpoint began — tracked and untracked,
 * committed or not. Diffing against the checkpoint's base rather than HEAD
 * means committing mid-checkpoint does not make passed gates look stale.
 */
function fingerprint(p, baseRef) {
  const spec = pathspec(p);
  const list = args => git(p.root, args).toString('utf8').split('\0').filter(Boolean);
  // Hash (path, current content) for every path that differs from the base.
  // Hashing content rather than diff text keeps the result identical whether a
  // file is untracked, staged, or committed.
  const changed = new Set([
    ...list(['diff', '--name-only', '-z', baseRef, '--', ...spec]),
    ...list(['ls-files', '--others', '--exclude-standard', '-z', '--', ...spec]),
  ]);
  const hash = crypto.createHash('sha256');
  for (const file of [...changed].sort()) {
    const full = path.join(p.root, file);
    hash.update(`\0${file}\0`);
    if (!fs.existsSync(full) && !isSymlink(full)) {
      hash.update('\0deleted');
    } else if (isSymlink(full)) {
      hash.update(`\0link:${fs.readlinkSync(full)}`);
    } else {
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertClean(p) {
  const out = git(p.root, ['status', '--porcelain', '--', ...pathspec(p)]).toString('utf8').trim();
  if (out) {
    fail(`the working tree has uncommitted changes — commit the previous checkpoint (or stash) before beginning another:\n${out}`);
  }
}

// ── state ────────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadRun(p) {
  if (!fs.existsSync(p.runFile)) {
    fail('no active theseus run — start one with: theseus.js init --key K --reference R --test-cmd C');
  }
  return { run: readJson(p.runFile), state: readJson(p.cpFile) };
}

function save(p, run, state) {
  writeJson(p.runFile, run);
  writeJson(p.cpFile, state);
  fs.writeFileSync(p.mdFile, renderMarkdown(run, state, p));
}

function findCheckpoint(state, id) {
  if (!id) fail('a checkpoint id is required, e.g. CP1');
  const cp = state.checkpoints.find(c => c.id === id);
  if (!cp) fail(`unknown checkpoint '${id}' — known: ${state.checkpoints.map(c => c.id).join(', ') || 'none'}`);
  return cp;
}

function evidenceFile(p, cpId, gate) {
  return path.join(p.evidence, cpId, `${gate}.json`);
}

function readEvidence(p, cpId, gate) {
  const file = evidenceFile(p, cpId, gate);
  return fs.existsSync(file) ? readJson(file) : null;
}

/** Validate checkpoint input and give each one a stable, script-assigned id. */
function normalizeCheckpoints(input, startIndex, origin) {
  const list = Array.isArray(input) ? input : input && input.checkpoints;
  if (!Array.isArray(list) || list.length === 0) {
    fail('checkpoint file must be a non-empty JSON array (or { "checkpoints": [...] })');
  }
  return list.map((item, i) => {
    const where = `checkpoint ${i + 1}`;
    if (!item || typeof item.title !== 'string' || !item.title.trim()) fail(`${where} has no title`);
    if (typeof item.done !== 'string' || !item.done.trim()) {
      fail(`${where} ('${item.title}') has no 'done' — state what is observably true when it is finished`);
    }
    if (typeof item.ui !== 'boolean') {
      fail(`${where} ('${item.title}') needs 'ui': true or false — it decides whether the visual gate may be skipped`);
    }
    if (!Array.isArray(item.tests) || item.tests.length === 0 || item.tests.some(t => typeof t !== 'string' || !t.trim())) {
      fail(`${where} ('${item.title}') has no tests — plan the test cases before the human approves the list`);
    }
    return {
      id: `CP${startIndex + i + 1}`,
      title: item.title.trim(),
      done: item.done.trim(),
      ui: item.ui,
      tests: item.tests.map(t => t.trim()),
      origin,
      approved: false,
      status: 'pending',
      stopBlocks: 0,
    };
  });
}

// ── gates ────────────────────────────────────────────────────────────────────

/** A panel (visual or review) passes when enough distinct reviewers are clean at this fingerprint. */
function panelState(evidence, fp) {
  if (!evidence) return 'none';
  if (evidence.skip && evidence.skip.fp === fp) return 'skip';
  if (evidence.carry && evidence.carry.fp === fp) return 'carried';
  const reviewers = Object.values(evidence.reviewers || {});
  const current = reviewers.filter(r => r.fp === fp);
  if (current.length >= REVIEWERS_REQUIRED && current.every(r => r.findings === 0)) return 'pass';
  if (current.some(r => r.findings > 0)) return 'findings';
  if (reviewers.length > 0 || evidence.skip || evidence.carry) {
    return current.length > 0 ? 'partial' : 'stale';
  }
  return 'none';
}

/** True when the panel passed at some earlier fingerprint — the precondition for carrying it forward. */
function panelEverPassed(evidence) {
  if (evidence.skip) return true;
  const reviewers = Object.values(evidence.reviewers || {});
  return reviewers.some(r => panelState(evidence, r.fp) === 'pass');
}

function commandState(evidence, fp) {
  if (!evidence) return 'none';
  if (!evidence.passed) return 'fail';
  return evidence.fp === fp ? 'pass' : 'stale';
}

function gateStates(p, cp, fp) {
  return {
    red: readEvidence(p, cp.id, 'red') ? 'pass' : 'none',
    tests: commandState(readEvidence(p, cp.id, 'tests'), fp),
    visual: panelState(readEvidence(p, cp.id, 'visual'), fp),
    review: panelState(readEvidence(p, cp.id, 'review'), fp),
  };
}

const PASSING = new Set(['pass', 'skip', 'carried']);

function gatesComplete(states) {
  return states.red === 'pass' && states.tests === 'pass' && PASSING.has(states.visual) && states.review === 'pass';
}

function explainGate(name, state, cpId) {
  const hints = {
    none: 'has not been run',
    stale: 'passed against older code — the code changed after it passed, so it must run again',
    fail: 'failed',
    findings: 'has open findings — fix them, re-run the affected gates, then review again',
    partial: `has fewer than ${REVIEWERS_REQUIRED} distinct clean reviewers at the current code`,
  };
  return `${name} for ${cpId} ${hints[state] || `is '${state}'`}`;
}

function runCommand(p, cmd) {
  const result = spawnSync(cmd, { cwd: p.root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trimEnd();
  const tail = output.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
  const exit = result.status === null ? 1 : result.status;
  return { exit, tail };
}

function requireActive(cp) {
  if (cp.status !== 'building' && cp.status !== 'awaiting-approval') {
    fail(`${cp.id} is '${cp.status}', not in progress — begin it first: theseus.js begin ${cp.id}`);
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

function cmdInit(p, { flags }) {
  if (fs.existsSync(p.runFile)) {
    const existing = readJson(p.runFile);
    fail(`a run is already active (key ${existing.key}) — resume it (theseus.js status) or finish and archive it first`);
  }
  const autonomy = typeof flags.autonomy === 'string' ? flags.autonomy : 'step';
  if (!AUTONOMY.test(autonomy)) fail(`--autonomy must be step, batch:N or unattended, not '${autonomy}'`);
  const run = {
    key: requireFlag(flags, 'key', 'a ticket id or a kebab-case slug'),
    reference: requireFlag(flags, 'reference', 'what defines correct: legacy code, a running app, a spec or a mock'),
    testCmd: requireFlag(flags, 'test-cmd', 'the command that runs the tests'),
    arch: typeof flags.arch === 'string' ? flags.arch.split(',').map(s => s.trim()).filter(Boolean) : [],
    autonomy,
    approvalCredit: 0,
    created: new Date().toISOString(),
  };
  const state = { checkpoints: [] };
  if (!fs.existsSync(p.learnings)) {
    fs.mkdirSync(p.base, { recursive: true });
    fs.writeFileSync(p.learnings, '# Theseus learnings\n\nOne line per rule. Every builder and reviewer reads this before starting.\n\n');
  }
  save(p, run, state);
  console.log(`theseus: run '${run.key}' started in ${path.relative(p.root, p.run) || p.run} (autonomy: ${autonomy})`);
}

function cmdPlan(p, { flags }) {
  const { run, state } = loadRun(p);
  if (state.checkpoints.some(c => c.status !== 'pending')) {
    fail('checkpoints are already in progress — append new ones with: theseus.js add --file F');
  }
  state.checkpoints = normalizeCheckpoints(readJson(requireFlag(flags, 'file')), 0, 'plan');
  save(p, run, state);
  console.log(`theseus: ${state.checkpoints.length} checkpoint(s) planned — show ${path.relative(p.root, p.mdFile)} to the human for approval`);
}

function cmdAdd(p, { flags }) {
  const { run, state } = loadRun(p);
  const added = normalizeCheckpoints(readJson(requireFlag(flags, 'file')), state.checkpoints.length, 'feedback');
  state.checkpoints.push(...added);
  save(p, run, state);
  console.log(`theseus: added ${added.map(c => c.id).join(', ')} — they need human approval (approve-plan) before they begin`);
}

function cmdApprovePlan(p, { flags }) {
  const { run, state } = loadRun(p);
  const by = requireFlag(flags, 'by', 'the human who reviewed the checkpoint list');
  const pending = state.checkpoints.filter(c => !c.approved);
  if (pending.length === 0) fail('nothing to approve — every checkpoint is already approved');
  for (const cp of pending) {
    cp.approved = true;
    cp.plannedBy = by;
  }
  save(p, run, state);
  console.log(`theseus: ${pending.map(c => c.id).join(', ')} approved by ${by}`);
}

function cmdRender(p) {
  const { run, state } = loadRun(p);
  save(p, run, state);
  console.log(`theseus: wrote ${path.relative(p.root, p.mdFile)}`);
}

function cmdBegin(p, { positionals }) {
  const { run, state } = loadRun(p);
  const cp = findCheckpoint(state, positionals[0]);
  if (cp.status !== 'pending') fail(`${cp.id} is already '${cp.status}'`);
  if (!cp.approved) fail(`${cp.id} has not been approved by a human — show them checkpoints.md, then: theseus.js approve-plan --by NAME`);
  const active = state.checkpoints.find(c => c.status === 'building' || c.status === 'awaiting-approval');
  if (active) fail(`${active.id} is still '${active.status}' — one checkpoint at a time`);
  const earlier = state.checkpoints.slice(0, state.checkpoints.indexOf(cp)).find(c => c.status !== 'done');
  if (earlier) fail(`${earlier.id} comes first and is not done — checkpoints run in order`);
  assertClean(p);
  cp.status = 'building';
  cp.base = headOrEmptyTree(p.root);
  cp.stopBlocks = 0;
  fs.rmSync(path.join(p.evidence, cp.id), { recursive: true, force: true });
  save(p, run, state);
  console.log(`theseus: ${cp.id} '${cp.title}' is building. Read ${path.relative(p.root, p.learnings)} first; write the failing tests, then: theseus.js record ${cp.id} red`);
}

function recordCommand(p, run, cp, gate, flags, fp) {
  const cmd = typeof flags.cmd === 'string' ? flags.cmd : run.testCmd;
  const { exit, tail } = runCommand(p, cmd);
  if (gate === 'red') {
    if (exit === 0) {
      fail(`red run passed — the tests for ${cp.id} must fail before the implementation exists (a test that has never failed has proven nothing)`);
    }
    writeJson(evidenceFile(p, cp.id, 'red'), { cmd, exit, tail, fp, at: new Date().toISOString() });
    console.log(`theseus: ${cp.id} red recorded (exit ${exit}). Build it, then: theseus.js record ${cp.id} tests`);
    return;
  }
  writeJson(evidenceFile(p, cp.id, 'tests'), { cmd, exit, tail, fp, passed: exit === 0, at: new Date().toISOString() });
  if (exit !== 0) fail(`tests failed (exit ${exit}) — gate 1 not passed for ${cp.id}:\n${tail}`);
  console.log(`theseus: ${cp.id} gate 1 (tests) passed.`);
}

function recordPanel(p, cp, gate, flags, fp, states) {
  if (states.tests !== 'pass') fail(`cannot record ${gate}: ${explainGate('gate 1 (tests)', states.tests, cp.id)}`);
  if (gate === 'review' && !PASSING.has(states.visual)) {
    fail(`cannot record review: ${explainGate('gate 2 (visual)', states.visual, cp.id)}`);
  }
  const file = evidenceFile(p, cp.id, gate);
  const evidence = readEvidence(p, cp.id, gate) || { reviewers: {} };
  const at = new Date().toISOString();

  if (gate === 'visual' && flags.skip !== undefined) {
    if (typeof flags.skip !== 'string' || !flags.skip.trim()) fail('--skip needs a reason, e.g. --skip "pure domain logic, nothing rendered"');
    if (cp.ui) fail(`${cp.id} is flagged ui: true — the visual gate cannot be skipped`);
    evidence.skip = { reason: flags.skip.trim(), fp, at };
    writeJson(file, evidence);
    console.log(`theseus: ${cp.id} gate 2 (visual) skipped: ${evidence.skip.reason}`);
    return;
  }
  if (gate === 'visual' && flags.carry !== undefined) {
    if (typeof flags.carry !== 'string' || !flags.carry.trim()) fail('--carry needs a reason that says why the fix cannot have changed anything visible');
    if (!panelEverPassed(evidence)) fail(`--carry needs an earlier visual pass for ${cp.id} to carry forward — there is none`);
    evidence.carry = { reason: flags.carry.trim(), fp, at };
    writeJson(file, evidence);
    console.log(`theseus: ${cp.id} gate 2 (visual) carried forward: ${evidence.carry.reason}`);
    return;
  }

  const reviewer = requireFlag(flags, 'reviewer', 'a distinct id per reviewer subagent, e.g. review-a');
  const findings = Number(flags.findings);
  if (flags.findings === undefined || !Number.isInteger(findings) || findings < 0) {
    fail('--findings must be a whole number ≥ 0 — the count of open findings this reviewer reported');
  }
  evidence.reviewers[reviewer] = {
    findings,
    isolation: flags.isolation === 'none' ? 'none' : 'subagent',
    note: typeof flags.note === 'string' ? flags.note : undefined,
    fp,
    at,
  };
  writeJson(file, evidence);
  const after = panelState(evidence, fp);
  const label = gate === 'visual' ? 'gate 2 (visual)' : 'gate 3 (review)';
  if (after === 'pass') {
    console.log(`theseus: ${cp.id} ${label} passed — ${REVIEWERS_REQUIRED} distinct reviewers clean at the current code.`);
  } else if (findings > 0) {
    console.log(`theseus: ${cp.id} ${label} NOT passed — ${reviewer} reported ${findings} finding(s). Fix every one, re-run the gates the fix touched, then review again.`);
  } else {
    console.log(`theseus: ${cp.id} ${label} — ${reviewer} clean; ${explainGate(label, after, cp.id)}.`);
  }
}

function cmdRecord(p, { positionals, flags }) {
  const { run, state } = loadRun(p);
  const cp = findCheckpoint(state, positionals[0]);
  const gate = positionals[1];
  if (!['red', 'tests', 'visual', 'review'].includes(gate)) {
    fail(`unknown gate '${gate}' — one of red, tests, visual, review`);
  }
  requireActive(cp);
  const fp = fingerprint(p, cp.base);
  const states = gateStates(p, cp, fp);
  if (gate === 'tests' && states.red !== 'pass') {
    fail(`no failing red run recorded for ${cp.id} — write the tests first and record them failing: theseus.js record ${cp.id} red`);
  }
  if (gate === 'red' || gate === 'tests') {
    recordCommand(p, run, cp, gate, flags, fp);
  } else {
    recordPanel(p, cp, gate, flags, fp, states);
  }
  cp.status = 'building';
  save(p, run, state);
}

function cmdAdvance(p, { positionals, flags }) {
  const { run, state } = loadRun(p);
  const cp = findCheckpoint(state, positionals[0]);
  requireActive(cp);
  const fp = fingerprint(p, cp.base);
  const states = gateStates(p, cp, fp);
  if (states.red !== 'pass') fail(explainGate('the red run', states.red, cp.id));
  if (states.tests !== 'pass') fail(explainGate('gate 1 (tests)', states.tests, cp.id));
  if (!PASSING.has(states.visual)) fail(explainGate('gate 2 (visual)', states.visual, cp.id));
  if (states.review !== 'pass') fail(explainGate('gate 3 (review)', states.review, cp.id));

  const by = typeof flags['approved-by'] === 'string' && flags['approved-by'].trim() ? flags['approved-by'].trim() : null;
  let approval;
  if (run.autonomy === 'unattended') {
    approval = { deferred: 'PR' };
  } else if (by) {
    approval = { by };
    if (run.autonomy.startsWith('batch:')) {
      run.approvalCredit = Number(run.autonomy.slice(6)) - 1;
      run.lastApprover = by;
    }
  } else if (run.autonomy.startsWith('batch:') && run.approvalCredit > 0) {
    run.approvalCredit -= 1;
    approval = { by: run.lastApprover, batch: true };
  } else {
    cp.status = 'awaiting-approval';
    save(p, run, state);
    fail(`gates 1–3 passed for ${cp.id}; waiting for human approval (autonomy: ${run.autonomy}). Show the human the diff and evidence, then: theseus.js advance ${cp.id} --approved-by NAME`);
  }

  cp.status = 'done';
  cp.approval = approval;
  cp.doneFp = fp;
  cp.completed = new Date().toISOString();
  save(p, run, state);
  const next = state.checkpoints.find(c => c.status === 'pending');
  console.log(`theseus: ${cp.id} done (${approval.deferred ? 'approval deferred to PR review' : `approved by ${approval.by}`}). Commit it now.${next ? ` Next: ${next.id} '${next.title}'.` : ' That was the last checkpoint.'}`);
}

function cmdLearn(p, { positionals, flags }) {
  const text = positionals.join(' ').trim();
  if (!text) fail('give the rule as one line of text, e.g. theseus.js learn --cp CP3 --source reviewer "inject the clock; never call Date.now in handlers"');
  const source = typeof flags.source === 'string' ? flags.source : 'other';
  if (!['reviewer', 'human', 'other'].includes(source)) fail(`--source must be reviewer, human or other, not '${source}'`);
  const cp = typeof flags.cp === 'string' ? flags.cp : '-';
  fs.mkdirSync(p.base, { recursive: true });
  fs.appendFileSync(p.learnings, `- ${text} _(${cp}, ${source}, ${new Date().toISOString().slice(0, 10)})_\n`);
  console.log(`theseus: learned — ${text}`);
}

function nextAction(p, state) {
  if (state.checkpoints.length === 0) return 'plan the checkpoints: theseus.js plan --file F';
  const unapproved = state.checkpoints.filter(c => !c.approved);
  const active = state.checkpoints.find(c => c.status === 'building' || c.status === 'awaiting-approval');
  if (active) {
    if (active.status === 'awaiting-approval') return `get human approval: theseus.js advance ${active.id} --approved-by NAME`;
    const s = gateStates(p, active, fingerprint(p, active.base));
    if (s.red !== 'pass') return `write failing tests: theseus.js record ${active.id} red`;
    if (s.tests !== 'pass') return `make the tests pass: theseus.js record ${active.id} tests`;
    if (!PASSING.has(s.visual)) return `gate 2 for ${active.id}: visual review (or --skip if ui: false)`;
    if (s.review !== 'pass') return `gate 3 for ${active.id}: two isolated reviewers`;
    return `gates passed: theseus.js advance ${active.id}`;
  }
  const next = state.checkpoints.find(c => c.status === 'pending');
  if (next && !next.approved) return `human approval of ${unapproved.map(c => c.id).join(', ')}: theseus.js approve-plan --by NAME`;
  if (next) return `theseus.js begin ${next.id}`;
  return 'every checkpoint is done: the human reviews the whole feature, then theseus.js archive';
}

function cmdStatus(p, { flags }) {
  const { run, state } = loadRun(p);
  const rows = state.checkpoints.map(cp => {
    const active = cp.status === 'building' || cp.status === 'awaiting-approval';
    const gates = active ? gateStates(p, cp, fingerprint(p, cp.base)) : null;
    const isolationNone = ['visual', 'review'].some(g => {
      const ev = readEvidence(p, cp.id, g);
      return ev && Object.values(ev.reviewers || {}).some(r => r.isolation === 'none');
    });
    return { ...cp, gates, isolationNone };
  });
  const summary = {
    key: run.key,
    autonomy: run.autonomy,
    checkpoints: rows,
    deferredApprovals: rows.filter(r => r.approval && r.approval.deferred).map(r => r.id),
    isolationNone: rows.filter(r => r.isolationNone).map(r => r.id),
    next: nextAction(p, state),
  };
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`theseus: ${run.key} — autonomy ${run.autonomy}`);
  for (const r of rows) {
    const gates = r.gates ? `  red:${r.gates.red} tests:${r.gates.tests} visual:${r.gates.visual} review:${r.gates.review}` : '';
    console.log(`  ${r.id.padEnd(5)} ${r.status.padEnd(17)} ${r.title}${gates}`);
  }
  if (summary.isolationNone.length) console.log(`  WARNING: reviewed without context isolation: ${summary.isolationNone.join(', ')}`);
  if (summary.deferredApprovals.length) console.log(`  approval deferred to PR review: ${summary.deferredApprovals.join(', ')}`);
  console.log(`  next: ${summary.next}`);
}

/** Stop-hook entry point. Must never throw: a broken hook must not wedge a session. */
function cmdCheck(cwd) {
  try {
    const p = resolvePaths(cwd);
    if (!fs.existsSync(p.runFile)) return 0;
    const { run, state } = loadRun(p);
    const cp = state.checkpoints.find(c => c.status === 'building');
    if (!cp) return 0;
    if (gatesComplete(gateStates(p, cp, fingerprint(p, cp.base)))) return 0;
    if ((cp.stopBlocks || 0) >= MAX_STOP_BLOCKS) return 0;
    cp.stopBlocks = (cp.stopBlocks || 0) + 1;
    save(p, run, state);
    process.stderr.write(
      `theseus: ${cp.id} '${cp.title}' still has open gates — ${nextAction(p, state)}. ` +
        `Keep going (block ${cp.stopBlocks}/${MAX_STOP_BLOCKS}); if you are genuinely blocked, say what you need from the human.\n`
    );
    return 2;
  } catch {
    return 0;
  }
}

function cmdArchive(p) {
  const { run, state } = loadRun(p);
  if (state.checkpoints.length === 0 || state.checkpoints.some(c => c.status !== 'done')) {
    fail('only a finished run can be archived — every checkpoint must be done');
  }
  const dest = path.join(p.archive, run.key);
  if (fs.existsSync(dest)) fail(`archive/${run.key} already exists`);
  fs.mkdirSync(p.archive, { recursive: true });
  fs.renameSync(p.run, dest);
  console.log(`theseus: run archived to ${path.relative(p.root, dest)}; learnings.md stays for the next run`);
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderMarkdown(run, state, p) {
  const symbol = { pass: 'pass', skip: 'skipped', carried: 'carried', stale: 'STALE', fail: 'FAIL', findings: 'findings', partial: 'partial', none: '—' };
  const lines = [
    `# ${run.key} — checkpoints`,
    '',
    `**Reference:** ${run.reference}  `,
    `**Autonomy:** ${run.autonomy}  `,
    `**Architecture docs:** ${run.arch.length ? run.arch.join(', ') : '—'}`,
    '',
    '_Generated by theseus.js — edit the plan with `plan`/`add`, not by hand._',
    '',
    '| # | Checkpoint | UI | Approved | Status | Red | Tests | Visual | Review |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const cp of state.checkpoints) {
    const active = cp.status === 'building' || cp.status === 'awaiting-approval';
    const g = active ? gateStates(p, cp, fingerprint(p, cp.base)) : null;
    const cell = name => (cp.status === 'done' ? 'pass' : g ? symbol[g[name]] : '—');
    lines.push(`| ${cp.id} | ${cp.title} | ${cp.ui ? 'yes' : 'no'} | ${cp.approved ? 'yes' : '**no**'} | ${cp.status} | ${cell('red')} | ${cell('tests')} | ${cell('visual')} | ${cell('review')} |`);
  }
  for (const cp of state.checkpoints) {
    lines.push('', `## ${cp.id} — ${cp.title}`, '', `**Done when:** ${cp.done}`, '', '**Tests:**');
    for (const t of cp.tests) lines.push(`- ${t}`);
    if (cp.origin === 'feedback') lines.push('', '_Added from human feedback._');
    if (cp.approval) {
      lines.push('', cp.approval.deferred ? '_Approval deferred to PR review._' : `_Approved by ${cp.approval.by}${cp.approval.batch ? ' (batch)' : ''}._`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── main ─────────────────────────────────────────────────────────────────────

const COMMANDS = {
  init: cmdInit,
  plan: cmdPlan,
  add: cmdAdd,
  'approve-plan': cmdApprovePlan,
  render: cmdRender,
  begin: cmdBegin,
  record: cmdRecord,
  advance: cmdAdvance,
  learn: cmdLearn,
  status: cmdStatus,
  archive: cmdArchive,
};

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    return cmdCheck(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  }
  if (!command || command === 'help' || command === '--help' || !COMMANDS[command]) {
    console.log(USAGE);
    return command && !['help', '--help'].includes(command) ? 1 : 0;
  }
  try {
    COMMANDS[command](resolvePaths(process.cwd()), parseArgs(rest));
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`theseus: ${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
