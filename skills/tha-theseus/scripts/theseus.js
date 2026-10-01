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
 * State lives in `.theseus/` in the directory the agent runs in. The viewer
 * (server.js) reads the same state through the functions exported here, so the
 * CLI and the browser can never disagree about what a gate means.
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
const { spawnSync, spawn } = require('node:child_process');

const STATE_DIR = '.theseus';
const REVIEWERS_REQUIRED = 2;
const MAX_STOP_BLOCKS = 3;
const OUTPUT_TAIL_LINES = 40;
const LOG_LIMIT = 200;
const DEFAULT_PORT = 4747;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const AUTONOMY = /^(step|unattended|batch:[1-9]\d*)$/;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

const USAGE = `usage: theseus.js <command> [args]

  init --key K --reference R --test-cmd C [--arch a.md,b.md]
       [--autonomy step|batch:N|unattended] [--approvals viewer|any]
  serve [--port ${DEFAULT_PORT}]            start the live viewer in the background; prints its link
  stop                                stop the viewer
  plan --file checkpoints.json        load the checkpoint list (replaces an unstarted plan)
  add --file checkpoints.json         append checkpoints, e.g. from human feedback
  approve-plan --by NAME              CLI plan approval (refused when --approvals viewer)
  begin CP                            start a checkpoint (needs a clean tree)
  record CP red   [--cmd C]           run the tests; they must FAIL
  record CP tests [--cmd C]           gate 1: run the tests; they must pass
  record CP visual --reviewer ID --findings N [--isolation none] [--note T]
  record CP visual --skip "reason"    only for checkpoints with ui: false
  record CP visual --carry "reason"   re-use an earlier visual pass after a non-visual fix
  record CP review --reviewer ID --findings N [--isolation none] [--note T]
  advance CP [--approved-by NAME]     gate 4 and mark done (--approved-by refused when --approvals viewer)
  wait [--timeout 540]                block until the human approves or sends feedback in the viewer
  inbox                               print unread feedback from the viewer and mark it read
  learn --cp CP --source reviewer|human|other "one-line rule"
  learnings                           print the learnings, one per line, for subagent briefs
  agents [--target claude,copilot] [--planner-model M] [--planner-model-copilot M]
         [--reviewer-model M] [--reviewer-model-copilot M]
                                      write custom agent files that pin a model
  status [--json]
  check                               for a Stop hook: exit 2 while gates are open
  archive                             move a finished run to .theseus/archive/<key>/`;

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

function stringFlag(flags, name) {
  return typeof flags[name] === 'string' && flags[name].trim() ? flags[name].trim() : null;
}

// ── git and paths ────────────────────────────────────────────────────────────

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function gitRoot(cwd) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.status !== 0) {
    fail('not inside a git repository — theseus fingerprints the working tree with git');
  }
  return fs.realpathSync(top.stdout.trim());
}

function pathsFor(root, base) {
  const run = path.join(base, 'current');
  return {
    root,
    base,
    run,
    runFile: path.join(run, 'run.json'),
    cpFile: path.join(run, 'checkpoints.json'),
    logFile: path.join(run, 'log.jsonl'),
    evidence: path.join(run, 'evidence'),
    learnings: path.join(base, 'learnings.json'),
    feedback: path.join(base, 'feedback.json'),
    serverFile: path.join(base, 'server.json'),
    serverLog: path.join(base, 'server.log'),
    archive: path.join(base, 'archive'),
  };
}

/**
 * Find `.theseus/` by walking up from cwd to the git root, so a command run
 * from a subfolder still finds the run. `init` instead creates it in cwd.
 */
function resolvePaths(cwd, { create = false } = {}) {
  const root = gitRoot(cwd);
  const start = fs.realpathSync(cwd);
  if (create) return pathsFor(root, path.join(start, STATE_DIR));
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, STATE_DIR);
    if (fs.existsSync(candidate)) return pathsFor(root, candidate);
    if (dir === root || path.dirname(dir) === dir) break;
    dir = path.dirname(dir);
  }
  return pathsFor(root, path.join(start, STATE_DIR));
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
    if (isSymlink(full)) {
      hash.update(`\0link:${fs.readlinkSync(full)}`);
    } else if (!fs.existsSync(full)) {
      hash.update('\0deleted');
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

function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Write via a temp file and rename, so the viewer never reads half a file. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
}

function log(p, event, detail = {}) {
  fs.mkdirSync(p.run, { recursive: true });
  fs.appendFileSync(p.logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`);
}

function readLog(p) {
  if (!fs.existsSync(p.logFile)) return [];
  return fs
    .readFileSync(p.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
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

function isActive(cp) {
  return cp.status === 'building' || cp.status === 'awaiting-approval';
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
  if (!isActive(cp)) {
    fail(`${cp.id} is '${cp.status}', not in progress — begin it first: theseus.js begin ${cp.id}`);
  }
}

/** CLI approvals are refused when the human chose to approve only in the viewer. */
function assertCliMayApprove(run) {
  if (run.approvals === 'viewer') {
    fail('approve in the viewer — this run only accepts approvals the human clicks there (theseus.js serve prints the link). Ask the human, then run: theseus.js wait');
  }
}

// ── operations shared by the CLI and the viewer ──────────────────────────────

function approvePlan(p, { by, source }) {
  const { run, state } = loadRun(p);
  const pending = state.checkpoints.filter(c => !c.approved);
  if (pending.length === 0) fail('nothing to approve — every checkpoint is already approved');
  for (const cp of pending) {
    cp.approved = true;
    cp.plannedBy = { by, source };
  }
  save(p, run, state);
  log(p, 'plan-approved', { by, source, cps: pending.map(c => c.id) });
  return pending.map(c => c.id);
}

/**
 * Gate 4. Checks gates 1–3 at the current code, then applies the approval
 * the autonomy level demands. Returns { done: false } when it is now waiting
 * on a human.
 */
function advance(p, cpId, { by = null, source = 'cli' } = {}) {
  const { run, state } = loadRun(p);
  const cp = findCheckpoint(state, cpId);
  requireActive(cp);
  const fp = fingerprint(p, cp.base);
  const states = gateStates(p, cp, fp);
  if (states.red !== 'pass') fail(explainGate('the red run', states.red, cp.id));
  if (states.tests !== 'pass') fail(explainGate('gate 1 (tests)', states.tests, cp.id));
  if (!PASSING.has(states.visual)) fail(explainGate('gate 2 (visual)', states.visual, cp.id));
  if (states.review !== 'pass') fail(explainGate('gate 3 (review)', states.review, cp.id));

  let approval;
  if (run.autonomy === 'unattended') {
    approval = { deferred: 'PR' };
  } else if (by) {
    approval = { by, source };
    if (run.autonomy.startsWith('batch:')) {
      run.approvalCredit = Number(run.autonomy.slice(6)) - 1;
      run.lastApprover = { by, source };
    }
  } else if (run.autonomy.startsWith('batch:') && run.approvalCredit > 0) {
    run.approvalCredit -= 1;
    approval = { ...run.lastApprover, batch: true };
  } else {
    if (cp.status !== 'awaiting-approval') {
      cp.status = 'awaiting-approval';
      save(p, run, state);
      log(p, 'awaiting-approval', { cp: cp.id });
    }
    return { done: false, cp };
  }

  cp.status = 'done';
  cp.approval = approval;
  cp.doneFp = fp;
  cp.completed = new Date().toISOString();
  save(p, run, state);
  log(p, 'approved', { cp: cp.id, ...approval });
  const next = state.checkpoints.find(c => c.status === 'pending');
  return { done: true, cp, approval, next };
}

function readFeedback(p) {
  return readJson(p.feedback, { items: [] });
}

/** Human feedback from the viewer. On a checkpoint awaiting approval it means "request changes". */
function addFeedback(p, { cp: cpId, text }) {
  if (typeof text !== 'string' || !text.trim()) fail('feedback needs some text');
  const { run, state } = loadRun(p);
  let reopened = false;
  if (cpId) {
    const cp = findCheckpoint(state, cpId);
    if (cp.status === 'awaiting-approval') {
      cp.status = 'building';
      cp.stopBlocks = 0;
      reopened = true;
      save(p, run, state);
    }
  }
  const feedback = readFeedback(p);
  const item = { id: feedback.items.length + 1, at: new Date().toISOString(), cp: cpId || null, text: text.trim(), read: false };
  feedback.items.push(item);
  writeJson(p.feedback, feedback);
  log(p, reopened ? 'changes-requested' : 'feedback', { cp: cpId || null, text: item.text });
  return { item, reopened };
}

function readLearnings(p) {
  return readJson(p.learnings, []);
}

function nextAction(p, state, run) {
  const viewer = run && run.approvals === 'viewer';
  if (state.checkpoints.length === 0) return 'plan the checkpoints: theseus.js plan --file F';
  const active = state.checkpoints.find(isActive);
  if (active) {
    if (active.status === 'awaiting-approval') {
      return viewer ? `human approves ${active.id} in the viewer; agent runs: theseus.js wait` : `get human approval: theseus.js advance ${active.id} --approved-by NAME`;
    }
    const s = gateStates(p, active, fingerprint(p, active.base));
    if (s.red !== 'pass') return `write failing tests: theseus.js record ${active.id} red`;
    if (s.tests !== 'pass') return `make the tests pass: theseus.js record ${active.id} tests`;
    if (!PASSING.has(s.visual)) {
      return active.ui
        ? `gate 2 for ${active.id}: two blind visual reviewers against the reference`
        : `gate 2 for ${active.id}: theseus.js record ${active.id} visual --skip "<reason>"`;
    }
    if (s.review !== 'pass') return `gate 3 for ${active.id}: two isolated reviewers`;
    return `gates passed: theseus.js advance ${active.id}`;
  }
  const next = state.checkpoints.find(c => c.status === 'pending');
  if (next && !next.approved) {
    const ids = state.checkpoints.filter(c => !c.approved).map(c => c.id).join(', ');
    return viewer ? `human approves the plan (${ids}) in the viewer; agent runs: theseus.js wait` : `human approval of ${ids}: theseus.js approve-plan --by NAME`;
  }
  if (next) return `theseus.js begin ${next.id}`;
  return 'every checkpoint is done: the human reviews the whole feature, then theseus.js archive';
}

function screenshots(p, cpId) {
  const dir = path.join(p.evidence, cpId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => IMAGE_TYPES[path.extname(f).toLowerCase()]).sort();
}

/** Everything the viewer shows, computed fresh from disk. */
function snapshot(p) {
  const { run, state } = loadRun(p);
  const checkpoints = state.checkpoints.map(cp => {
    const gates = isActive(cp) ? gateStates(p, cp, fingerprint(p, cp.base)) : null;
    const evidence = {};
    for (const gate of ['red', 'tests', 'visual', 'review']) evidence[gate] = readEvidence(p, cp.id, gate);
    const isolationNone = ['visual', 'review'].some(g => evidence[g] && Object.values(evidence[g].reviewers || {}).some(r => r.isolation === 'none'));
    return { ...cp, gates, evidence, screenshots: screenshots(p, cp.id), isolationNone };
  });
  return {
    run,
    checkpoints,
    next: nextAction(p, state, run),
    learnings: readLearnings(p),
    feedback: readFeedback(p).items,
    log: readLog(p).slice(-LOG_LIMIT),
    warnings: {
      isolationNone: checkpoints.filter(c => c.isolationNone).map(c => c.id),
      deferredApprovals: checkpoints.filter(c => c.approval && c.approval.deferred).map(c => c.id),
      cliApprovals: checkpoints.filter(c => c.approval && c.approval.source === 'cli').map(c => c.id),
    },
  };
}

// ── commands ─────────────────────────────────────────────────────────────────

function cmdInit(cwd, { flags }) {
  const p = resolvePaths(cwd, { create: true });
  const existing = resolvePaths(cwd);
  if (fs.existsSync(existing.runFile)) {
    fail(`a run is already active (key ${readJson(existing.runFile).key}) in ${existing.base} — resume it (theseus.js status) or finish and archive it first`);
  }
  const autonomy = stringFlag(flags, 'autonomy') || 'step';
  if (!AUTONOMY.test(autonomy)) fail(`--autonomy must be step, batch:N or unattended, not '${autonomy}'`);
  const approvals = stringFlag(flags, 'approvals') || 'viewer';
  if (!['viewer', 'any'].includes(approvals)) fail(`--approvals must be viewer or any, not '${approvals}'`);
  const run = {
    key: requireFlag(flags, 'key', 'a ticket id or a kebab-case slug'),
    reference: requireFlag(flags, 'reference', 'what defines correct: legacy code, a running app, a spec or a mock'),
    testCmd: requireFlag(flags, 'test-cmd', 'the command that runs the tests'),
    arch: stringFlag(flags, 'arch') ? flags.arch.split(',').map(s => s.trim()).filter(Boolean) : [],
    autonomy,
    approvals,
    approvalCredit: 0,
    created: new Date().toISOString(),
  };
  fs.mkdirSync(p.base, { recursive: true });
  const ignore = path.join(p.base, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'server.json\nserver.log\n*.tmp\n');
  save(p, run, { checkpoints: [] });
  log(p, 'init', { key: run.key, autonomy, approvals });
  console.log(`theseus: run '${run.key}' started in ${path.relative(cwd, p.base) || p.base} (autonomy: ${autonomy}, approvals: ${approvals})`);
  console.log('theseus: start the viewer and give the human its link: theseus.js serve');
}

function cmdPlan(p, { flags }) {
  const { run, state } = loadRun(p);
  if (state.checkpoints.some(c => c.status !== 'pending')) {
    fail('checkpoints are already in progress — append new ones with: theseus.js add --file F');
  }
  state.checkpoints = normalizeCheckpoints(readJson(requireFlag(flags, 'file')), 0, 'plan');
  save(p, run, state);
  log(p, 'planned', { count: state.checkpoints.length });
  console.log(`theseus: ${state.checkpoints.length} checkpoint(s) planned — the human reviews and approves them in the viewer`);
}

function cmdAdd(p, { flags }) {
  const { run, state } = loadRun(p);
  const added = normalizeCheckpoints(readJson(requireFlag(flags, 'file')), state.checkpoints.length, 'feedback');
  state.checkpoints.push(...added);
  save(p, run, state);
  log(p, 'added', { cps: added.map(c => c.id) });
  console.log(`theseus: added ${added.map(c => c.id).join(', ')} — they need human approval before they begin`);
}

function cmdApprovePlan(p, { flags }) {
  const { run } = loadRun(p);
  assertCliMayApprove(run);
  const by = requireFlag(flags, 'by', 'the human who reviewed the checkpoint list');
  const ids = approvePlan(p, { by, source: 'cli' });
  console.log(`theseus: ${ids.join(', ')} approved by ${by} (reported by agent)`);
}

function cmdBegin(p, { positionals }) {
  const { run, state } = loadRun(p);
  const cp = findCheckpoint(state, positionals[0]);
  if (cp.status !== 'pending') fail(`${cp.id} is already '${cp.status}'`);
  if (!cp.approved) fail(`${cp.id} has not been approved by a human — they approve the plan in the viewer (or, with --approvals any: theseus.js approve-plan --by NAME)`);
  const active = state.checkpoints.find(isActive);
  if (active) fail(`${active.id} is still '${active.status}' — one checkpoint at a time`);
  const earlier = state.checkpoints.slice(0, state.checkpoints.indexOf(cp)).find(c => c.status !== 'done');
  if (earlier) fail(`${earlier.id} comes first and is not done — checkpoints run in order`);
  assertClean(p);
  cp.status = 'building';
  cp.base = headOrEmptyTree(p.root);
  cp.stopBlocks = 0;
  fs.rmSync(path.join(p.evidence, cp.id), { recursive: true, force: true });
  save(p, run, state);
  log(p, 'begin', { cp: cp.id });
  console.log(`theseus: ${cp.id} '${cp.title}' is building. Hand every subagent the output of 'theseus.js learnings'; write the failing tests, then: theseus.js record ${cp.id} red`);
}

function recordCommand(p, run, cp, gate, flags, fp) {
  const cmd = stringFlag(flags, 'cmd') || run.testCmd;
  const { exit, tail } = runCommand(p, cmd);
  if (gate === 'red') {
    if (exit === 0) {
      fail(`red run passed — the tests for ${cp.id} must fail before the implementation exists (a test that has never failed has proven nothing)`);
    }
    writeJson(evidenceFile(p, cp.id, 'red'), { cmd, exit, tail, fp, at: new Date().toISOString() });
    log(p, 'gate', { cp: cp.id, gate: 'red', result: `failed as required (exit ${exit})` });
    console.log(`theseus: ${cp.id} red recorded (exit ${exit}). Build it, then: theseus.js record ${cp.id} tests`);
    return;
  }
  writeJson(evidenceFile(p, cp.id, 'tests'), { cmd, exit, tail, fp, passed: exit === 0, at: new Date().toISOString() });
  log(p, 'gate', { cp: cp.id, gate: 'tests', result: exit === 0 ? 'pass' : `fail (exit ${exit})` });
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
    log(p, 'gate', { cp: cp.id, gate: 'visual', result: `skipped: ${evidence.skip.reason}` });
    console.log(`theseus: ${cp.id} gate 2 (visual) skipped: ${evidence.skip.reason}`);
    return;
  }
  if (gate === 'visual' && flags.carry !== undefined) {
    if (typeof flags.carry !== 'string' || !flags.carry.trim()) fail('--carry needs a reason that says why the fix cannot have changed anything visible');
    if (!panelEverPassed(evidence)) fail(`--carry needs an earlier visual pass for ${cp.id} to carry forward — there is none`);
    evidence.carry = { reason: flags.carry.trim(), fp, at };
    writeJson(file, evidence);
    log(p, 'gate', { cp: cp.id, gate: 'visual', result: `carried: ${evidence.carry.reason}` });
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
    note: stringFlag(flags, 'note') || undefined,
    fp,
    at,
  };
  writeJson(file, evidence);
  const after = panelState(evidence, fp);
  const label = gate === 'visual' ? 'gate 2 (visual)' : 'gate 3 (review)';
  log(p, 'gate', { cp: cp.id, gate, reviewer, result: findings ? `${findings} finding(s)` : 'clean', isolation: evidence.reviewers[reviewer].isolation });
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
  if (cp.status !== 'building') {
    cp.status = 'building';
    save(p, run, state);
  }
  if (gate === 'red' || gate === 'tests') {
    recordCommand(p, run, cp, gate, flags, fp);
  } else {
    recordPanel(p, cp, gate, flags, fp, states);
  }
}

function cmdAdvance(p, { positionals, flags }) {
  const { run } = loadRun(p);
  const by = stringFlag(flags, 'approved-by');
  if (by) assertCliMayApprove(run);
  const result = advance(p, positionals[0], { by, source: 'cli' });
  if (!result.done) {
    const how = run.approvals === 'viewer'
      ? 'Ask the human to approve it in the viewer, then: theseus.js wait'
      : `Show the human the diff and evidence, then: theseus.js advance ${result.cp.id} --approved-by NAME`;
    fail(`gates 1–3 passed for ${result.cp.id}; waiting for human approval (autonomy: ${run.autonomy}). ${how}`);
  }
  console.log(doneMessage(result));
}

function doneMessage({ cp, approval, next }) {
  const who = approval.deferred
    ? 'approval deferred to PR review'
    : `approved by ${approval.by}${approval.source === 'cli' ? ', reported by agent' : ''}${approval.batch ? ', batch' : ''}`;
  return `theseus: ${cp.id} done (${who}). Commit it now.${next ? ` Next: ${next.id} '${next.title}'.` : ' That was the last checkpoint.'}`;
}

function cmdLearn(p, { positionals, flags }) {
  const text = positionals.join(' ').trim();
  if (!text) fail('give the rule as one line of text, e.g. theseus.js learn --cp CP3 --source reviewer "inject the clock; never call Date.now in handlers"');
  const source = stringFlag(flags, 'source') || 'other';
  if (!['reviewer', 'human', 'other'].includes(source)) fail(`--source must be reviewer, human or other, not '${source}'`);
  const learnings = readLearnings(p);
  learnings.push({ text, cp: stringFlag(flags, 'cp'), source, date: new Date().toISOString().slice(0, 10) });
  writeJson(p.learnings, learnings);
  if (fs.existsSync(p.runFile)) log(p, 'learned', { cp: stringFlag(flags, 'cp'), text });
  console.log(`theseus: learned — ${text}`);
}

function cmdLearnings(p) {
  const learnings = readLearnings(p);
  if (learnings.length === 0) {
    console.log('(no learnings yet)');
    return;
  }
  for (const l of learnings) console.log(`- ${l.text}`);
}

function cmdInbox(p) {
  const feedback = readFeedback(p);
  const unread = feedback.items.filter(i => !i.read);
  if (unread.length === 0) {
    console.log('theseus: no unread feedback');
    return;
  }
  for (const item of unread) {
    console.log(`- [${item.cp || 'general'}] ${item.text}`);
    item.read = true;
  }
  writeJson(p.feedback, feedback);
  console.log('theseus: turn change requests into checkpoints (theseus.js add) and rules into learnings (theseus.js learn)');
}

/**
 * Block until the human acts in the viewer. Polls the activity log rather
 * than talking to the server, so it works even if the server restarted.
 */
async function cmdWait(p, { flags }) {
  loadRun(p);
  const timeout = Number(stringFlag(flags, 'timeout') || 540);
  if (!Number.isFinite(timeout) || timeout <= 0) fail('--timeout must be a positive number of seconds');
  const seen = readLog(p).length;
  const deadline = Date.now() + timeout * 1000;
  const human = new Set(['plan-approved', 'approved', 'feedback', 'changes-requested']);
  while (Date.now() < deadline) {
    const fresh = readLog(p).slice(seen).filter(e => human.has(e.event) && e.source !== 'cli');
    if (fresh.length) {
      for (const e of fresh) {
        const what = { 'plan-approved': `plan approved (${(e.cps || []).join(', ')})`, approved: `${e.cp} approved`, feedback: `feedback${e.cp ? ` on ${e.cp}` : ''}: ${e.text}`, 'changes-requested': `changes requested on ${e.cp}: ${e.text}` }[e.event];
        console.log(`theseus: ${what}`);
      }
      if (fresh.some(e => e.event === 'approved')) console.log('theseus: commit the approved checkpoint, then continue.');
      if (fresh.some(e => e.event === 'feedback' || e.event === 'changes-requested')) console.log('theseus: read it with: theseus.js inbox');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`no approval or feedback yet after ${timeout}s — run theseus.js wait again, or remind the human the viewer is waiting on them`);
}

function cmdStatus(p, { flags }) {
  const snap = snapshot(p);
  if (flags.json) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  console.log(`theseus: ${snap.run.key} — autonomy ${snap.run.autonomy}, approvals ${snap.run.approvals}`);
  for (const r of snap.checkpoints) {
    const gates = r.gates ? `  red:${r.gates.red} tests:${r.gates.tests} visual:${r.gates.visual} review:${r.gates.review}` : '';
    console.log(`  ${r.id.padEnd(5)} ${r.status.padEnd(17)} ${r.title}${gates}`);
  }
  const w = snap.warnings;
  if (w.isolationNone.length) console.log(`  WARNING: reviewed without context isolation: ${w.isolationNone.join(', ')}`);
  if (w.cliApprovals.length) console.log(`  approval reported by agent, not clicked by a human: ${w.cliApprovals.join(', ')}`);
  if (w.deferredApprovals.length) console.log(`  approval deferred to PR review: ${w.deferredApprovals.join(', ')}`);
  const server = liveServer(p);
  if (server) console.log(`  viewer: ${server.url}`);
  console.log(`  next: ${snap.next}`);
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
      `theseus: ${cp.id} '${cp.title}' still has open gates — ${nextAction(p, state, run)}. ` +
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
  console.log(`theseus: run archived to ${path.relative(p.root, dest)}; learnings stay for the next run. Stop the viewer with: theseus.js stop`);
}

// ── the viewer server, run in the background ─────────────────────────────────

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The recorded server, if its process is still alive. */
function liveServer(p) {
  const info = readJson(p.serverFile, null);
  if (!info || !processAlive(info.pid)) return null;
  return info;
}

async function healthy(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health?t=${info.token}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function cmdServe(p, { flags }) {
  loadRun(p);
  const port = Number(stringFlag(flags, 'port') || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be 0–65535, not '${flags.port}'`);

  if (flags.foreground) {
    const { startServer } = require('./server');
    const server = await startServer(p, { port });
    writeJson(p.serverFile, { pid: process.pid, port: server.port, token: server.token, url: server.url, started: new Date().toISOString() });
    const cleanup = () => {
      try {
        const info = readJson(p.serverFile, null);
        if (info && info.pid === process.pid) fs.rmSync(p.serverFile, { force: true });
      } catch {
        // best effort
      }
      process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    console.log(`theseus viewer: ${server.url}`);
    return new Promise(() => {});
  }

  const existing = liveServer(p);
  if (existing && (await healthy(existing))) {
    console.log(`theseus: viewer already running — open ${existing.url}`);
    return;
  }
  fs.rmSync(p.serverFile, { force: true });
  const out = fs.openSync(p.serverLog, 'a');
  const child = spawn(process.execPath, [__filename, 'serve', '--foreground', '--port', String(port)], {
    cwd: p.root,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, THESEUS_STATE: p.base },
  });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const info = readJson(p.serverFile, null);
    if (info && (await healthy(info))) {
      console.log(`theseus: viewer running — open ${info.url}`);
      console.log('theseus: give the human this link; it updates live and is where they approve.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail(`the viewer did not start within 10s — see ${path.relative(p.root, p.serverLog)}`);
}

function cmdStop(p) {
  const info = liveServer(p);
  if (!info) {
    fs.rmSync(p.serverFile, { force: true });
    console.log('theseus: no viewer running');
    return;
  }
  process.kill(info.pid, 'SIGTERM');
  fs.rmSync(p.serverFile, { force: true });
  console.log(`theseus: viewer stopped (pid ${info.pid})`);
}

// ── custom agent files that pin a model ──────────────────────────────────────

const AGENT_MARKER = '<!-- generated by tha-theseus (theseus.js agents) — re-run that command to update; edits here are overwritten -->';

const AGENTS = {
  planner: {
    source: 'checkpoints.md',
    description: 'Theseus checkpoint planner. Turns a reference (legacy code, running app, mock or spec) into small, ordered checkpoints with done-criteria and planned tests, as JSON for theseus.js plan.',
  },
  reviewer: {
    source: 'reviewer.md',
    description: 'Theseus adversarial reviewer for gates 2 and 3. Judges a diff or a pair of screenshots against the given standards and reference only, and returns a VERDICT/FINDINGS block.',
  },
};

function agentBody(role) {
  const text = fs.readFileSync(path.join(__dirname, '..', AGENTS[role].source), 'utf8');
  // reviewer.md opens with a note for the orchestrator, above a `---` rule; the agent gets only the brief below it.
  const rule = text.search(/^---$/m);
  return (role === 'reviewer' && rule !== -1 ? text.slice(rule + 4) : text).trim();
}

function agentFile(target, role, model) {
  const name = `theseus-${role}`;
  const description = JSON.stringify(AGENTS[role].description);
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  if (target === 'claude') {
    lines.push('tools: Read, Grep, Glob');
  } else {
    lines.push("tools: ['read', 'search']");
  }
  // Copilot CLI rejects an array here (github/copilot-cli#2133), so always one string.
  if (model) lines.push(`model: ${JSON.stringify(model)}`);
  lines.push('---', '', AGENT_MARKER, '', agentBody(role), '');
  return {
    file: target === 'claude' ? path.join('.claude', 'agents', `${name}.md`) : path.join('.github', 'agents', `${name}.agent.md`),
    content: lines.join('\n'),
  };
}

function cmdAgents(cwd, { flags }) {
  const root = gitRoot(cwd);
  const targets = (stringFlag(flags, 'target') || 'claude,copilot').split(',').map(s => s.trim()).filter(Boolean);
  for (const t of targets) if (!['claude', 'copilot'].includes(t)) fail(`--target must be claude, copilot or both, not '${t}'`);
  const files = [];
  for (const target of targets) {
    for (const role of Object.keys(AGENTS)) {
      const model = stringFlag(flags, target === 'claude' ? `${role}-model` : `${role}-model-copilot`);
      files.push(agentFile(target, role, model));
    }
  }
  // Check every destination before writing any, so a refusal leaves nothing half-done.
  for (const { file } of files) {
    const full = path.join(root, file);
    if (fs.existsSync(full) && !fs.readFileSync(full, 'utf8').includes(AGENT_MARKER)) {
      fail(`${file} exists and was not generated by theseus — refusing to overwrite it; rename or delete it first`);
    }
  }
  for (const { file, content } of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    const model = /^model: (.*)$/m.exec(content);
    console.log(`theseus: wrote ${file} (${model ? `model ${model[1]}` : 'inherits the session model'})`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const COMMANDS = {
  plan: cmdPlan,
  add: cmdAdd,
  'approve-plan': cmdApprovePlan,
  begin: cmdBegin,
  record: cmdRecord,
  advance: cmdAdvance,
  wait: cmdWait,
  inbox: cmdInbox,
  learn: cmdLearn,
  learnings: cmdLearnings,
  status: cmdStatus,
  serve: cmdServe,
  stop: cmdStop,
  archive: cmdArchive,
};

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'check') {
    return cmdCheck(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  }
  const known = command === 'init' || command === 'agents' || COMMANDS[command];
  if (!command || command === 'help' || command === '--help' || !known) {
    console.log(USAGE);
    return command && !['help', '--help'].includes(command) ? 1 : 0;
  }
  try {
    const args = parseArgs(rest);
    if (command === 'init') {
      cmdInit(process.cwd(), args);
    } else if (command === 'agents') {
      cmdAgents(process.cwd(), args);
    } else {
      // The background server is told exactly where its state is, so it never
      // depends on where it happened to be spawned.
      const p = process.env.THESEUS_STATE && args.flags.foreground
        ? pathsFor(gitRoot(process.cwd()), process.env.THESEUS_STATE)
        : resolvePaths(process.cwd());
      await COMMANDS[command](p, args);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof GateError)) throw error;
    console.error(`theseus: ${error.message}`);
    return 1;
  }
}

module.exports = {
  GateError,
  resolvePaths,
  pathsFor,
  loadRun,
  snapshot,
  approvePlan,
  advance,
  addFeedback,
  doneMessage,
  IMAGE_TYPES,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
