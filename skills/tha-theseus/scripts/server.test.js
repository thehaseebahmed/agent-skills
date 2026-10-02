'use strict';

/**
 * Tests for the viewer server, started in-process against a throwaway git
 * repo, plus the background `serve` / `stop` lifecycle through the CLI.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('./theseus');
const { startServer } = require('./server');

const SCRIPT = path.join(__dirname, 'theseus.js');
const CHECKPOINTS = [
  { title: 'Balance rule', done: 'balance never negative', ui: false, tests: ['rejects overdraw'] },
  { title: 'Request form', done: 'matches the mock', ui: true, tests: ['error state'] },
];

function env() {
  const copy = { ...process.env };
  delete copy.CLAUDE_PROJECT_DIR;
  delete copy.THESEUS_STATE;
  return copy;
}

function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: env() });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function ok(dir, ...args) {
  const r = cli(dir, ...args);
  assert.strictEqual(r.code, 0, `theseus ${args.join(' ')} failed: ${r.err}`);
  return r;
}

/** Every run started by this version needs a confirmed brief before it can plan. */
function confirmBrief(dir) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-brief-')), 'brief.json');
  fs.writeFileSync(file, JSON.stringify({ goal: 'g', understanding: 'u', areas: ['a'] }));
  ok(dir, 'brief', '--file', file);
  const core = require('./theseus');
  core.approveBrief(core.resolvePaths(dir), { by: 'human (viewer)', source: 'viewer' });
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

/** A repo with a planned (unapproved) run in viewer-approval mode. */
function planned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theseus-srv-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync('impl.txt') ? 0 : 1);\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  ok(dir, 'init', '--key', 'HR-7', '--reference', 'mock.html', '--test-cmd', 'node check.js');
  const file = path.join(dir, '..', `cps-${path.basename(dir)}.json`);
  fs.writeFileSync(file, JSON.stringify(CHECKPOINTS));
  confirmBrief(dir);
  ok(dir, 'plan', '--file', file);
  return dir;
}

/** Drive CP1 to awaiting-approval. */
function toAwaiting(dir, p) {
  core.approvePlan(p, { by: 'human (viewer)', source: 'viewer' });
  ok(dir, 'begin', 'CP1');
  ok(dir, 'record', 'CP1', 'red');
  fs.writeFileSync(path.join(dir, 'impl.txt'), 'x\n');
  ok(dir, 'record', 'CP1', 'tests');
  ok(dir, 'record', 'CP1', 'visual', '--skip', 'logic only');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'a', '--findings', '0');
  ok(dir, 'record', 'CP1', 'review', '--reviewer', 'b', '--findings', '0');
  assert.strictEqual(cli(dir, 'advance', 'CP1').code, 1);
}

async function withServer(fn) {
  const dir = planned();
  const p = core.resolvePaths(dir);
  const server = await startServer(p, { port: 0 });
  const api = (route, opts = {}) =>
    fetch(`http://127.0.0.1:${server.port}${route}`, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-theseus-token': server.token, ...(opts.headers || {}) },
    });
  try {
    await fn({ dir, p, server, api });
  } finally {
    await server.close();
  }
}

test('the page is served without a token, but the API refuses requests without one', () =>
  withServer(async ({ server }) => {
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /<title>Theseus Viewer<\/title>/);
    const bare = await fetch(`http://127.0.0.1:${server.port}/api/state`);
    assert.strictEqual(bare.status, 401);
    assert.match((await bare.json()).error, /missing or wrong token/);
    const wrong = await fetch(`http://127.0.0.1:${server.port}/api/state?t=${'0'.repeat(32)}`);
    assert.strictEqual(wrong.status, 401);
  }));

test('state carries the run, every checkpoint and the next action', () =>
  withServer(async ({ api }) => {
    const state = await (await api('/api/state')).json();
    assert.strictEqual(state.run.key, 'HR-7');
    assert.strictEqual(state.run.approvals, 'viewer');
    assert.deepStrictEqual(state.checkpoints.map(c => [c.id, c.status, c.approved]), [['CP1', 'pending', false], ['CP2', 'pending', false]]);
    assert.match(state.next, /human approves the plan \(CP1, CP2\) in the viewer/);
  }));

test('approving the plan in the viewer records it as the viewer', () =>
  withServer(async ({ dir, api }) => {
    const res = await api('/api/approve-plan', { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).message, 'Approved CP1, CP2.');
    const snap = JSON.parse(ok(dir, 'status', '--json', '--full').out);
    assert.deepStrictEqual(snap.checkpoints[0].plannedBy, { by: 'human (viewer)', source: 'viewer' });
    const again = await api('/api/approve-plan', { method: 'POST' });
    assert.strictEqual(again.status, 409);
    assert.match((await again.json()).error, /nothing to approve/);
  }));

test('approving a checkpoint in the viewer marks it done with source viewer', () =>
  withServer(async ({ dir, p, api }) => {
    toAwaiting(dir, p);
    const res = await api('/api/approve/CP1', { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /CP1 done \(approved by human \(viewer\)\)\. Commit it now\. Next: CP2/);
    const snap = JSON.parse(ok(dir, 'status', '--json').out);
    assert.deepStrictEqual(snap.checkpoints[0].approval, { by: 'human (viewer)', source: 'viewer' });
  }));

test('the viewer cannot approve a checkpoint whose code changed after its gates passed', () =>
  withServer(async ({ dir, p, api }) => {
    toAwaiting(dir, p);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'changed after review\n');
    const res = await api('/api/approve/CP1', { method: 'POST' });
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /gate 1 \(tests\) for CP1 passed against older code/);
  }));

test('requesting changes sends the checkpoint back to building and lands in the inbox', () =>
  withServer(async ({ dir, p, api }) => {
    toAwaiting(dir, p);
    const res = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ cp: 'CP1', text: 'reject half days too' }) });
    assert.match((await res.json()).message, /Changes requested — CP1 is back to building/);
    const snap = JSON.parse(ok(dir, 'status', '--json').out);
    assert.strictEqual(snap.checkpoints[0].status, 'building');
    assert.match(ok(dir, 'inbox').out, /- \[CP1\] reject half days too/);
  }));

test('empty feedback is refused', () =>
  withServer(async ({ api }) => {
    const res = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text: '  ' }) });
    assert.strictEqual(res.status, 409);
    assert.match((await res.json()).error, /feedback needs some text/);
  }));

test('evidence serves images from the evidence dir and nothing else', () =>
  withServer(async ({ p, server, api }) => {
    const dir = path.join(p.evidence, 'CP1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'build.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const img = await api('/evidence/CP1/build.png');
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    for (const route of ['/evidence/CP1/..%2F..%2Frun.json', '/evidence/../run.json', '/evidence/CP1/tests.json', '/evidence/x/build.png']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${route}?t=${server.token}`);
      assert.strictEqual(res.status, 404, `${route} should be 404`);
    }
  }));

test('the event stream sends the state, then again after a change', () =>
  withServer(async ({ server, api }) => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/events?t=${server.token}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return JSON.parse(event.replace(/^data: /, ''));
        }
        const { value } = await reader.read();
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const first = await nextEvent();
    assert.strictEqual(first.checkpoints[0].approved, false);
    await api('/api/approve-plan', { method: 'POST' });
    const second = await nextEvent();
    assert.strictEqual(second.checkpoints[0].approved, true);
    controller.abort();
  }));

test('serve starts a background viewer, reuses it, and stop ends it', async () => {
  const dir = planned();
  const first = ok(dir, 'serve', '--port', '0');
  const url = /open (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32})/.exec(first.out);
  assert.ok(url, `no link in: ${first.out}`);
  try {
    const health = await fetch(url[1].replace('/?t=', '/api/health?t='));
    assert.strictEqual(health.status, 200);
    const second = ok(dir, 'serve', '--port', '0');
    assert.match(second.out, new RegExp(`viewer already running — open ${url[1].replace(/[?]/g, '\\?')}`));
    assert.match(ok(dir, 'status').out, new RegExp(`viewer: ${url[1].replace(/[?]/g, '\\?')}`));
  } finally {
    assert.match(ok(dir, 'stop').out, /viewer stopped/);
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  await assert.rejects(fetch(url[1]));
  assert.match(ok(dir, 'stop').out, /no viewer running/);
});

test('the viewer can change any setting, and bad values are refused', () =>
  withServer(async ({ dir, server, api }) => {
    const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autonomy: 'unattended', approvals: 'viewer', granularity: 'xs-s' }) });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /Settings saved: autonomy step → unattended, granularity s-m → xs-s\. The agent picks them up on its next step\./);
    assert.match(ok(dir, 'status').out, /settings changed by human \(viewer\): autonomy step → unattended, granularity s-m → xs-s/);
    const bad = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autonomy: 'batch:0' }) });
    assert.strictEqual(bad.status, 409);
    assert.match((await bad.json()).error, /autonomy must be step, batch:N or unattended, not 'batch:0'/);
    const anon = await fetch(`http://127.0.0.1:${server.port}/api/settings`, { method: 'POST', body: '{"autonomy":"step"}' });
    assert.strictEqual(anon.status, 401);
  }));
