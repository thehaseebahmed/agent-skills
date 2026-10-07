'use strict';

/**
 * Tests for the API server, with and without the bundled viewer mounted,
 * started in-process against a throwaway git repo, plus the background
 * `serve` / `stop` lifecycle through the CLI.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const core = require('./theseus');
const { startServer, API_VERSION, parseHost, isExposed } = require('./server');
const { viewer } = require('./viewer/viewer');

const SCRIPT = path.join(__dirname, 'theseus.js');
const { requirementsBrief } = require('./brief-fixture');
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
  fs.writeFileSync(file, JSON.stringify(requirementsBrief()));
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
  ok(dir, 'checkpoints', '--file', file);
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

async function withServer(fn, options = { ui: viewer() }) {
  const dir = planned();
  const p = core.resolvePaths(dir);
  const server = await startServer(p, { port: 0, ...options });
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
    assert.strictEqual(state.run.approvals, undefined, 'the approvals setting is gone');
    assert.deepStrictEqual(state.checkpoints.map(c => [c.id, c.status, c.approved]), [['CP1', 'pending', false], ['CP2', 'pending', false]]);
    assert.match(state.next, /human approves the plan \(CP1, CP2\) in the viewer/);
    // The one settings spec, served to the page that renders the chips.
    assert.deepStrictEqual(
      { autonomy: state.settings.autonomy, granularity: state.settings.granularity, visual: state.settings.visual, reviewers: state.settings.reviewers },
      { autonomy: 'step', granularity: 's-m', visual: 'on', reviewers: '2' },
    );
    assert.deepStrictEqual(Object.keys(state.settings.options), ['autonomy', 'granularity', 'visual', 'reviewers']);
    assert.strictEqual(state.settings.options.granularity.options.find(o => o.value === 's-m').current, true);
    assert.strictEqual(state.settings.options.autonomy.options.find(o => o.value === 'unattended').available, true, 'the brief is confirmed in this fixture');
  }));

test('approving the plan in the viewer records it as the viewer', () =>
  withServer(async ({ dir, api }) => {
    const res = await api('/api/approve-plan', { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).message, 'Approved CP1, CP2 — the run proceeds with every checkpoint · visual on · 2 code reviewers.');
    const snap = JSON.parse(ok(dir, 'status', '--json', '--full').out);
    assert.deepStrictEqual(snap.checkpoints[0].plannedBy, { by: 'human (viewer)', source: 'viewer' });
    const entry = snap.log.find(e => e.event === 'checkpoints-approved');
    assert.deepStrictEqual(entry.settings, { autonomy: 'step', granularity: 's-m', visual: 'on', reviewers: '2' });
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
  assert.match(ok(dir, 'stop').out, /no server running/);
});

test('headless, the server has no page but the whole API', () =>
  withServer(async ({ server, api }) => {
    assert.strictEqual(server.url, null);
    const page = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.strictEqual(page.status, 404);
    assert.deepStrictEqual(await (await api('/api/health')).json(), { ok: true, api: API_VERSION, ui: false });
    const state = await (await api('/api/state')).json();
    assert.strictEqual(state.run.key, 'HR-7');
    const res = await api('/api/approve-plan', { method: 'POST' });
    assert.strictEqual(res.status, 200);
  }, {}));

test('with the viewer mounted, health says so and the page lives at / only', () =>
  withServer(async ({ server, api }) => {
    assert.deepStrictEqual(await (await api('/api/health')).json(), { ok: true, api: API_VERSION, ui: true });
    assert.strictEqual(server.url, `http://127.0.0.1:${server.port}/?t=${server.token}`);
    assert.strictEqual((await fetch(`http://127.0.0.1:${server.port}/viewer.html`)).status, 404);
  }));

test('only allowed origins get CORS headers, and they still need the token', () =>
  withServer(async ({ server, api }) => {
    const base = `http://127.0.0.1:${server.port}`;
    const preflight = await fetch(`${base}/api/approve-plan`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-theseus-token' },
    });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-theseus-token/);

    const allowed = await api('/api/state', { headers: { origin: 'http://localhost:5173' } });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    const stranger = await api('/api/state', { headers: { origin: 'http://evil.example' } });
    assert.strictEqual(stranger.headers.get('access-control-allow-origin'), null);
    const strangerPreflight = await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { origin: 'http://evil.example' } });
    assert.strictEqual(strangerPreflight.status, 403);

    const tokenless = await fetch(`${base}/api/state`, { headers: { origin: 'http://localhost:5173' } });
    assert.strictEqual(tokenless.status, 401);
    assert.strictEqual(tokenless.headers.get('access-control-allow-origin'), 'http://localhost:5173', 'so the client can read why');
  }, { allowOrigins: ['http://localhost:5173/'] }));

test('allowed origins must be http(s) origins', async () => {
  const p = core.resolvePaths(planned());
  await assert.rejects(startServer(p, { port: 0, allowOrigins: ['localhost:5173'] }), /must be an http or https origin|is not a URL/);
  await assert.rejects(startServer(p, { port: 0, allowOrigins: ['file:///tmp/x.html'] }), /must be an http or https origin/);
});

/** This machine's first non-loopback IPv4 address, to prove what a bind exposes; null when it has none. */
function outsideAddress() {
  const found = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
  return found ? found.address : null;
}

test('the server binds 127.0.0.1 unless given another IP address', async () => {
  const outside = outsideAddress();
  await withServer(async ({ server }) => {
    assert.strictEqual(server.host, '127.0.0.1');
    assert.strictEqual(server.api, `http://127.0.0.1:${server.port}`);
    if (outside) await assert.rejects(fetch(`http://${outside}:${server.port}/api/health`), 'the default bind is unreachable from other interfaces');
  }, {});
  await withServer(async ({ server, api }) => {
    assert.strictEqual(server.host, '0.0.0.0');
    assert.strictEqual(server.url, `http://127.0.0.1:${server.port}/?t=${server.token}`, 'the link dials loopback, not 0.0.0.0');
    assert.strictEqual((await api('/api/health')).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${server.port}/api/state`)).status, 401, 'a wide bind still needs the token');
    if (outside) assert.strictEqual((await fetch(`http://${outside}:${server.port}/api/state?t=${server.token}`)).status, 200, 'reachable from other interfaces');
  }, { ui: viewer(), host: '0.0.0.0' });
  assert.strictEqual(parseHost('[::]'), '::');
  assert.deepStrictEqual(['127.0.0.1', '127.0.0.2', '::1', '0.0.0.0', '::', '172.17.0.2'].map(isExposed), [false, false, false, true, true, true]);
  const p = core.resolvePaths(planned());
  await assert.rejects(startServer(p, { port: 0, host: 'localhost' }), /host 'localhost' is not an IP address/);
});

test('serve --host 0.0.0.0, or THESEUS_HOST, listens on every interface and warns that it does', async () => {
  const dir = planned();
  const run = (extra, ...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...env(), ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const first = run({ THESEUS_HOST: '0.0.0.0' }, 'serve', '--port', '0');
  assert.strictEqual(first.code, 0, first.err);
  const url = /open (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32})/.exec(first.out);
  assert.ok(url, `no link in: ${first.out}`);
  assert.match(first.out, /listening on 0\.0\.0\.0, not just this machine — anyone who can reach port \d+ can load the page; only the token guards the run/);
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'server.json'), 'utf8'));
    assert.strictEqual(info.host, '0.0.0.0');
    assert.strictEqual((await fetch(url[1].replace('/?t=', '/api/health?t='))).status, 200);
    assert.match(ok(dir, 'serve', '--port', '0', '--host', '0.0.0.0').out, /viewer already running/);
    const narrower = cli(dir, 'serve', '--port', '0');
    assert.strictEqual(narrower.code, 1);
    assert.match(narrower.err, /already running with other options \(viewer, on 0\.0\.0\.0\) — run theseus\.js stop first/);
  } finally {
    assert.match(ok(dir, 'stop').out, /viewer stopped/);
  }
  const bad = cli(dir, 'serve', '--port', '0', '--host', 'everywhere');
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /host 'everywhere' is not an IP address/);
  assert.match(cli(dir, 'serve', '--host').err, /--host needs a value/);
  assert.doesNotMatch(ok(dir, 'serve', '--port', '0').out, /listening on/, 'the default bind says nothing about exposure');
  ok(dir, 'stop');
});

test('serve --headless starts the API alone, and a differently-shaped serve is refused', async () => {
  const dir = planned();
  const first = ok(dir, 'serve', '--port', '0', '--headless', '--allow-origin', 'http://localhost:5173');
  const found = /API running \(headless\) at (http:\/\/127\.0\.0\.1:\d+) — token ([0-9a-f]{32})/.exec(first.out);
  assert.ok(found, `no API line in: ${first.out}`);
  assert.match(first.out, /cross-origin calls allowed from http:\/\/localhost:5173/);
  try {
    const health = await fetch(`${found[1]}/api/health?t=${found[2]}`);
    assert.deepStrictEqual(await health.json(), { ok: true, api: API_VERSION, ui: false });
    assert.strictEqual((await fetch(`${found[1]}/`)).status, 404);
    assert.match(ok(dir, 'status').out, new RegExp(`api: ${found[1].replace(/\./g, '\\.')} \\(headless`));
    const info = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'server.json'), 'utf8'));
    assert.deepStrictEqual([info.api, info.token, info.url, info.allowOrigins], [found[1], found[2], null, ['http://localhost:5173']]);
    assert.match(ok(dir, 'serve', '--port', '0', '--headless', '--allow-origin', 'http://localhost:5173').out, /API already running/);
    const other = cli(dir, 'serve', '--port', '0');
    assert.strictEqual(other.code, 1);
    assert.match(other.err, /already running with other options \(headless, on 127\.0\.0\.1, allowing http:\/\/localhost:5173\) — run theseus\.js stop first/);
  } finally {
    assert.match(ok(dir, 'stop').out, /API server stopped/);
  }
});

test('the viewer can change any setting, and bad values are refused', () =>
  withServer(async ({ dir, server, api }) => {
    const res = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autonomy: 'unattended', granularity: 'xs-s' }) });
    assert.strictEqual(res.status, 200);
    assert.match((await res.json()).message, /Settings saved: autonomy step → unattended, granularity s-m → xs-s\. The agent picks them up on its next step\./);
    assert.match(ok(dir, 'status').out, /settings changed by human \(viewer\): autonomy step → unattended, granularity s-m → xs-s/);
    const bad = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autonomy: 'batch:0' }) });
    assert.strictEqual(bad.status, 409);
    assert.match((await bad.json()).error, /autonomy must be step, batch:N or unattended, not 'batch:0'/);
    const anon = await fetch(`http://127.0.0.1:${server.port}/api/settings`, { method: 'POST', body: '{"autonomy":"step"}' });
    assert.strictEqual(anon.status, 401);
  }));

// ── idle shutdown ────────────────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an untouched server reports itself idle, after the idle time and not before', async () => {
  const p = core.resolvePaths(planned());
  await sleep(50); // let the files written by planned() age past the mark
  const idle = [];
  const server = await startServer(p, { port: 0, idleMs: 400, onIdle: info => idle.push(info) });
  try {
    await sleep(150);
    assert.deepStrictEqual(idle, [], 'not yet');
    await sleep(700);
    assert.ok(idle.length >= 1, 'idle after 400ms of nothing');
    assert.strictEqual(idle[0].idleMs, 400);
    assert.match(idle[0].since, /^\d{4}-\d\d-\d\dT/);
  } finally {
    await server.close();
  }
});

test('API requests and changes to the run both count as activity', async () => {
  const dir = planned();
  const p = core.resolvePaths(dir);
  await sleep(50);
  const idle = [];
  const server = await startServer(p, { port: 0, idleMs: 600, onIdle: info => idle.push(info) });
  try {
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      await fetch(`http://127.0.0.1:${server.port}/api/health?t=${server.token}`);
    }
    assert.deepStrictEqual(idle, [], 'requests every 250ms keep a 600ms limit at bay');
    for (let i = 0; i < 4; i++) {
      await sleep(250);
      core.setSettings(p, { visual: i % 2 ? 'on' : 'off' }, { source: 'viewer' }); // writes the run's files, as the agent working does
    }
    assert.deepStrictEqual(idle, [], 'so do writes to the run, with no request at all');
    await sleep(1000);
    assert.ok(idle.length >= 1, 'and then it does go idle');
  } finally {
    await server.close();
  }
});

test('a background server stops itself when idle, leaves the run alone, and serve brings it back', async () => {
  const dir = planned();
  // THESEUS_IDLE_MS is the tests' way to shorten the fixed six hours.
  const first = spawnSync(process.execPath, [SCRIPT, 'serve', '--port', '0'], { cwd: dir, encoding: 'utf8', env: { ...env(), THESEUS_IDLE_MS: '1000' } });
  assert.strictEqual(first.status, 0, first.stderr);
  first.out = first.stdout;
  assert.match(first.out, /stops itself after 6h idle \(nothing is deleted\)/);
  const url = /open (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32})/.exec(first.out)[1];
  const info = JSON.parse(fs.readFileSync(path.join(dir, '.theseus', 'server.json'), 'utf8'));
  const before = fs.readFileSync(path.join(dir, '.theseus', 'current', 'run.json'), 'utf8');
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    await sleep(100);
    try {
      process.kill(info.pid, 0);
    } catch {
      gone = true;
    }
  }
  assert.ok(gone, 'the server process exited by itself');
  await assert.rejects(fetch(url));
  assert.strictEqual(fs.existsSync(path.join(dir, '.theseus', 'server.json')), false, 'its record is removed');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.theseus', 'current', 'run.json'), 'utf8'), before, 'the run is untouched');
  assert.match(fs.readFileSync(path.join(dir, '.theseus', 'server.log'), 'utf8'), /stopping after 6h idle/);
  const again = ok(dir, 'serve', '--port', '0');
  assert.match(again.out, /viewer running — open http/);
  assert.match(again.out, /stops itself after 6h idle/);
  ok(dir, 'stop');
});
