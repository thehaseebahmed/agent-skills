'use strict';

/**
 * server.js — the Theseus API server behind `theseus.js serve`.
 *
 * A local HTTP server (node:http, no dependencies) that exposes the run as JSON,
 * streams it as server-sent events, and takes the human's approvals. It has no
 * UI of its own: the bundled viewer (viewer/) is one client, mounted through the
 * `ui` option, and any other product can be another. The routes are documented
 * in ../api.md. Every approval made through it is recorded with source "viewer",
 * meaning a human-facing UI rather than the agent's CLI.
 *
 * It binds to 127.0.0.1 unless told otherwise (`host`, e.g. 0.0.0.0 inside a
 * container whose port is published), and every API and evidence request must
 * carry the random token, so another page open in the same browser, or another
 * machine that can reach a wider bind, can neither read the run nor approve
 * anything. Cross-origin clients are refused unless their
 * origin is listed in `allowOrigins`, and even then still need the token.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const { GateError, snapshot, approveCheckpoints, approveReqPlan, advance, addFeedback, setSettings, doneMessage, approveBrief, approvePlan, listRuns, findRun, withRunDir, switchRun, closeRun, IMAGE_TYPES } = require('./theseus');

/** Bumped on any breaking change to the routes or payloads in ../api.md. */
const API_VERSION = 1;
const TICK_MS = 1000;
/** A server nobody has touched for this long stops itself; the run's data stays on disk. */
const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
const MAX_BODY = 64 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...res.theseusCors, 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new GateError('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new GateError('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** Serve an image from inside the evidence dir, and nothing else. */
function serveEvidence(p, res, rest) {
  const [cp, ...fileParts] = rest.split('/').map(decodeURIComponent);
  const file = fileParts.join('/');
  if (!/^CP\d+$/.test(cp || '') || !file || file.includes('/') || file.includes('\\')) return send(res, 404, { error: 'not found' });
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  const dir = path.join(p.evidence, cp);
  const full = path.resolve(dir, file);
  if (!type || !full.startsWith(dir + path.sep) || !fs.existsSync(full)) return send(res, 404, { error: 'not found' });
  return send(res, 200, fs.readFileSync(full), type);
}

/** Normalise `--allow-origin` values to exact origins; anything else is refused. */
function parseOrigins(list) {
  return list.map(value => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new GateError(`allowed origin '${value}' is not a URL — give one like http://localhost:5173`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') throw new GateError(`allowed origin '${value}' must be an http or https origin`);
    return url.origin;
  });
}

const DEFAULT_HOST = '127.0.0.1';

/** Check a bind address: an IP literal only, so no name lookup decides what is exposed. */
function parseHost(value) {
  const host = String(value ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!net.isIP(host)) throw new GateError(`host '${value}' is not an IP address — give one like 127.0.0.1, or 0.0.0.0 for every interface`);
  return host;
}

/** True for a bind that other machines (or a container's host) can reach. */
function isExposed(host) {
  return !(host === '::1' || /^127\./.test(host));
}

/** The address a client on this machine dials for a server bound to `host`. */
function dialHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return net.isIPv6(host) ? `[${host}]` : host;
}

/**
 * Start the API server for the run at paths `p`. Resolves once listening.
 * Falls back to an OS-assigned port when the requested one is taken.
 *
 * `host` is the address to bind, 127.0.0.1 by default. 0.0.0.0 (or ::) listens
 * on every interface, which is what a server inside a Docker container needs
 * for a published port to reach it; anyone who can reach that port can then
 * load the viewer page, and only the token keeps them out of the run.
 *
 * `ui`, when given, is a request handler `(req, res, url) => boolean` tried for
 * any route outside the API before answering 404; it is how a UI is mounted on
 * the same origin. It is reached without the token, so it must only serve
 * static, run-independent content. Without it the server is headless.
 *
 * Idle shutdown: once `idleMs` (six hours; the option is a seam for tests) pass with no
 * API request and no change to the run's files, `onIdle` is called. It only
 * stops the process: `.theseus/` is not touched, so `theseus serve` brings the
 * server back with the run intact. An open viewer tab does not count as
 * activity on its own, or a forgotten tab would keep the server alive for ever.
 */
function startServer(p, { port = 0, host = DEFAULT_HOST, token = crypto.randomBytes(16).toString('hex'), allowOrigins = [], ui = null, idleMs = DEFAULT_IDLE_MS, onIdle = null } = {}) {
  let origins;
  try {
    host = parseHost(host);
    origins = new Set(parseOrigins(allowOrigins));
  } catch (error) {
    return Promise.reject(error);
  }
  const clients = new Set();
  let last = '';

  const runs = () => listRuns(p).map(({ dir, ...rest }) => rest);

  // With no active run (all closed or paused), still send the run list so the page can offer them.
  const current = () => {
    try {
      return JSON.stringify(snapshot(p));
    } catch (error) {
      try {
        return JSON.stringify({ error: error.message, runs: runs() });
      } catch {
        return JSON.stringify({ error: error.message, runs: [] });
      }
    }
  };

  const broadcast = (force = false) => {
    if (clients.size === 0 && !force) return;
    const body = current();
    if (body === last && !force) return;
    last = body;
    for (const res of clients) res.write(`data: ${body}\n\n`);
  };

  const timer = setInterval(broadcast, TICK_MS);
  timer.unref();

  // The newest of: the last API request, and the last write to the run's files
  // (the agent working moves those, with no request reaching this server).
  let touched = Date.now();
  const lastActivity = () => {
    let latest = touched;
    for (const file of [p.runFile, p.cpFile, p.logFile]) {
      try {
        latest = Math.max(latest, fs.statSync(file).mtimeMs);
      } catch {
        // not written yet
      }
    }
    return latest;
  };
  let idleTimer = null;
  if (idleMs > 0 && onIdle) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity() >= idleMs) onIdle({ idleMs, since: new Date(lastActivity()).toISOString() });
    }, Math.min(IDLE_CHECK_MS, Math.max(idleMs / 2, 10)));
    idleTimer.unref();
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    touched = Date.now();
    const isApi = route.startsWith('/api/') || route.startsWith('/evidence/');

    // A cross-origin client gets CORS headers only if its origin was allowed.
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.theseusCors = { 'access-control-allow-origin': origin, vary: 'Origin' };
    }
    if (req.method === 'OPTIONS' && isApi) {
      if (!res.theseusCors) return send(res, 403, { error: 'origin not allowed — start the server with --allow-origin for it' });
      res.writeHead(204, {
        ...res.theseusCors,
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers': 'content-type, x-theseus-token',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    if (!isApi) {
      if (ui && ui(req, res, url)) return undefined;
      return send(res, 404, { error: 'not found' });
    }

    const authorised = tokenMatches(url.searchParams.get('t') || req.headers['x-theseus-token'], token);
    if (!authorised) return send(res, 401, { error: 'missing or wrong token — open the link theseus.js serve printed' });

    try {
      if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true, api: API_VERSION, ui: Boolean(ui) });
      if (req.method === 'GET' && route === '/api/state') {
        const key = url.searchParams.get('run');
        if (!key) return send(res, 200, current());
        const found = findRun(p, key);
        return send(res, 200, JSON.stringify(found.active ? snapshot(p) : snapshot(withRunDir(p, found.dir))));
      }
      if (req.method === 'GET' && route === '/api/runs') return send(res, 200, runs());
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { ...res.theseusCors, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${current()}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      if (req.method === 'GET' && route.startsWith('/evidence/')) return serveEvidence(p, res, route.slice('/evidence/'.length));

      // Canonical route: approve the planned checkpoints.
      if (req.method === 'POST' && route === '/api/approve-checkpoints') {
        const plan = approveCheckpoints(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: `Approved ${plan.cps.join(', ')} — the run proceeds with ${plan.settings}.` });
      }
      // Legacy alias: /api/approve-plan still approves checkpoints (its original meaning).
      if (req.method === 'POST' && route === '/api/approve-plan') {
        const plan = approveCheckpoints(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: `Approved ${plan.cps.join(', ')} — the run proceeds with ${plan.settings}.` });
      }
      const approve = /^\/api\/approve\/(CP\d+)$/.exec(route);
      if (req.method === 'POST' && approve) {
        const result = advance(p, approve[1], { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: doneMessage(result).replace(/^theseus: /, '') });
      }
      if (req.method === 'POST' && route === '/api/settings') {
        const body = await readBody(req);
        const changes = setSettings(p, body, { source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: `Settings saved: ${changes.map(c => `${c.key} ${c.from} → ${c.to}`).join(', ')}. The agent picks them up on its next step.` });
      }
      if (req.method === 'POST' && route === '/api/feedback') {
        const body = await readBody(req);
        const { reopened, brief } = addFeedback(p, { cp: body.cp || null, text: body.text, brief: body.brief === true || body.plan === true });
        broadcast(true);
        const message = brief ? 'Changes requested on the plan — the agent revises it before any checkpoints are loaded.'
          : reopened ? `Changes requested — ${body.cp} is back to building.` : 'Feedback sent to the agent.';
        return send(res, 200, { ok: true, message });
      }
      // Canonical route: approve the requirements plan.
      if (req.method === 'POST' && route === '/api/approve-implementation-plan') {
        approveReqPlan(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: 'Requirements plan approved — the agent can now load the checkpoints.' });
      }
      // Legacy alias: /api/approve-brief still approves the requirements plan.
      if (req.method === 'POST' && route === '/api/approve-brief') {
        approveReqPlan(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: 'Requirements plan approved — the agent can now load the checkpoints.' });
      }
      if (req.method === 'POST' && route === '/api/switch') {
        const body = await readBody(req);
        const from = switchRun(p, String(body.key || ''), { source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: `${body.key} is now the active run${from ? `; ${from} is paused` : ''}.` });
      }
      if (req.method === 'POST' && route === '/api/close') {
        const body = await readBody(req);
        const result = closeRun(p, body.decision, { source: 'viewer', by: 'human (viewer)' });
        broadcast(true);
        return send(res, 200, { ok: true, message: result.kept ? 'Kept open.' : `Run ${result.summary.key} ${result.final}. Its summary is in History.` });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof GateError) return send(res, 409, { error: error.message });
      return send(res, 500, { error: 'internal error' });
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => send(res, 500, { error: 'internal error' }));
  });

  const listen = wanted =>
    new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(wanted, host);
    });

  return listen(port)
    .catch(error => {
      if (error.code !== 'EADDRINUSE' || port === 0) throw error;
      return listen(0);
    })
    .then(() => {
      const actual = server.address().port;
      const api = `http://${dialHost(host)}:${actual}`;
      return {
        port: actual,
        host,
        token,
        api,
        url: ui ? `${api}/?t=${token}` : null,
        allowOrigins: [...origins],
        idleMs: idleTimer ? idleMs : 0,
        close: () =>
          new Promise(resolve => {
            clearInterval(timer);
            if (idleTimer) clearInterval(idleTimer);
            for (const res of clients) res.end();
            server.close(() => resolve());
          }),
      };
    });
}

module.exports = { startServer, parseOrigins, parseHost, isExposed, API_VERSION, DEFAULT_IDLE_MS, DEFAULT_HOST };
