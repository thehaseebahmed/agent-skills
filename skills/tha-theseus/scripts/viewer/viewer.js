'use strict';

/**
 * viewer.js — the bundled Theseus viewer, one client of the API in ../server.js.
 *
 * The viewer is a single static page. It holds no run state and reads nothing
 * from disk but itself: everything it shows comes from the API, over the same
 * routes any other UI would use (api.md at the skill root). Mounted on the API server with
 * `startServer(p, { ui: viewer() })`, it is served at `/` and talks to its own
 * origin. Opened from anywhere else, `?api=http://127.0.0.1:PORT` points it at
 * a server started with `--allow-origin` for wherever the page is hosted.
 */

const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, 'viewer.html');

/** A `ui` handler for startServer: serves the page at `/`, and nothing else. */
function viewer() {
  return (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/') return false;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(fs.readFileSync(PAGE));
    return true;
  };
}

module.exports = { viewer, PAGE };
