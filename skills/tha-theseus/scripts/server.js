'use strict';

/**
 * server.js — the live viewer behind `theseus.js serve`.
 *
 * A local HTTP server (node:http, no dependencies) that shows the run as it
 * happens and is where the human approves. Every approval made here is
 * recorded with source "viewer", which is the only kind a run started with
 * `--approvals viewer` accepts.
 *
 * It binds to 127.0.0.1 only, and every API and evidence request must carry
 * the random token printed in the link, so another page open in the same
 * browser can neither read the run nor approve anything.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { GateError, snapshot, approvePlan, advance, addFeedback, setSettings, doneMessage, approveBrief, listRuns, findRun, withRunDir, switchRun, closeRun, IMAGE_TYPES } = require('./theseus');

const PAGE = path.join(__dirname, 'viewer.html');
const TICK_MS = 1000;
const MAX_BODY = 64 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
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

/**
 * Start the viewer for the run at paths `p`. Resolves once listening.
 * Falls back to an OS-assigned port when the requested one is taken.
 */
function startServer(p, { port = 0, token = crypto.randomBytes(16).toString('hex') } = {}) {
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

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'GET' && route === '/') {
      return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    }

    const authorised = tokenMatches(url.searchParams.get('t') || req.headers['x-theseus-token'], token);
    if (!authorised) return send(res, 401, { error: 'missing or wrong token — open the link theseus.js serve printed' });

    try {
      if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && route === '/api/state') {
        const key = url.searchParams.get('run');
        if (!key) return send(res, 200, current());
        const found = findRun(p, key);
        return send(res, 200, JSON.stringify(found.active ? snapshot(p) : snapshot(withRunDir(p, found.dir))));
      }
      if (req.method === 'GET' && route === '/api/runs') return send(res, 200, runs());
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${current()}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      if (req.method === 'GET' && route.startsWith('/evidence/')) return serveEvidence(p, res, route.slice('/evidence/'.length));

      if (req.method === 'POST' && route === '/api/approve-plan') {
        const ids = approvePlan(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: `Approved ${ids.join(', ')}.` });
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
        const { reopened, brief } = addFeedback(p, { cp: body.cp || null, text: body.text, brief: body.brief === true });
        broadcast(true);
        const message = brief ? 'Changes requested on the brief — the agent revises it before any planning.'
          : reopened ? `Changes requested — ${body.cp} is back to building.` : 'Feedback sent to the agent.';
        return send(res, 200, { ok: true, message });
      }
      if (req.method === 'POST' && route === '/api/approve-brief') {
        approveBrief(p, { by: 'human (viewer)', source: 'viewer' });
        broadcast(true);
        return send(res, 200, { ok: true, message: 'Brief confirmed — the agent can now research and plan the checkpoints.' });
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
      server.listen(wanted, '127.0.0.1');
    });

  return listen(port)
    .catch(error => {
      if (error.code !== 'EADDRINUSE' || port === 0) throw error;
      return listen(0);
    })
    .then(() => {
      const actual = server.address().port;
      return {
        port: actual,
        token,
        url: `http://127.0.0.1:${actual}/?t=${token}`,
        close: () =>
          new Promise(resolve => {
            clearInterval(timer);
            for (const res of clients) res.end();
            server.close(() => resolve());
          }),
      };
    });
}

module.exports = { startServer };
