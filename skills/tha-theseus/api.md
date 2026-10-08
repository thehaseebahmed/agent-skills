# Theseus API

`theseus serve` starts two separable parts:

- **The API server** (`scripts/server.js`): a local HTTP server that exposes the
  active run as JSON, streams it live, and takes the human's approvals. It has no UI.
- **The viewer** (`scripts/viewer/`): one static page that is a client of that API
  and nothing more. It uses only the routes below.

Another coding product can drop the viewer and show the run in its own UI. Start
the server headless and point your UI at it:

```sh
theseus serve --headless                                   # API only
theseus serve --headless --allow-origin http://localhost:5173   # and let that page call it
```

It prints `API running (headless) at http://127.0.0.1:PORT — token TOKEN`. A
program can read the same details from `.theseus/server.json`
(`{ pid, port, host, token, api, url, allowOrigins, started }`, where `url` is `null`
when headless). `theseus stop` ends it. Node code can also embed the server:
`require('<skill>/scripts/server').startServer(paths, { port, host, allowOrigins, ui })`,
with `paths` from `require('<skill>/scripts/theseus').resolvePaths(dir)`.

The server stops itself after six hours with no API request and no change to the
run's files. An open viewer tab alone does not keep it alive. Only the process
exits; `.theseus/` is untouched, and `theseus serve` starts it again with the run
as it was, under a new token. A UI should treat a dropped connection as "server
may have stopped": ask the agent to restart it rather than reporting a broken
run. The limit is fixed. Embedders get the same behaviour by passing `onIdle` to
`startServer`, which is called when the server has gone idle; without it nothing
is stopped.

The rules do not change with the UI. Approvals still cannot come from the agent's
CLI. Whatever UI calls these routes is where the human approves, and every
approval it makes is recorded with source `viewer`. Show the human what they are
approving; never let the agent call these routes for them.

## Access

- The server listens on `127.0.0.1` by default, so only the same machine can reach it.
- `--host ADDRESS` (or the `THESEUS_HOST` environment variable; the flag wins)
  binds another address. It must be an IP literal; host names are refused so no
  name lookup decides what is exposed. Use `--host 0.0.0.0` (or `::`) when the
  server runs inside a container, such as a Docker sandbox, and the browser is
  outside it: a server on the container's loopback cannot be reached through a
  published port. Pin `--port` too, because a taken port otherwise falls back to a
  random one that nothing publishes. The printed link and `api` still dial
  `127.0.0.1`, which is what both the container and a host publishing the same
  port number use; with a different host port, swap the port in the link.
- **What a wide bind exposes.** Anyone who can reach the port, which with
  `0.0.0.0` on a machine that is not sandboxed can mean the whole network, can load
  the viewer page. The token is then the only thing between them and reading the
  run or approving a checkpoint, and it travels in the link over plain HTTP. Bind
  wide only inside a container whose published port you control, prefer
  publishing it to the host's loopback alone, and share the link with the human
  only. `serve` prints a warning whenever it binds beyond loopback.
- Every `/api/*` and `/evidence/*` request needs the token, either as the
  `x-theseus-token` header or as the `t` query parameter. Use the parameter for
  `EventSource` and `<img src>`, which cannot send headers. Without it the
  response is `401`.
- Browsers on another origin are refused unless the server was started with
  `--allow-origin` for that exact origin. Allowed origins get CORS headers and
  preflights for `GET`/`POST` with `content-type` and `x-theseus-token`, and still
  need the token. There is no wildcard.

## Responses

- JSON everywhere except `/api/events` (server-sent events) and `/evidence/*`
  (images).
- `200` on success. Actions return `{ ok: true, message }`, where `message` is a
  sentence to show the human.
- `409` with `{ error }` when Theseus refuses the action, for example a gate that
  has not passed or a bad setting. Show the human `error` as is.
- `401` for a missing or wrong token, `404` for an unknown route, `500` with
  `{ error: "internal error" }` otherwise.

## Routes

| Method | Route | Body | Does |
|---|---|---|---|
| GET | `/api/health` | | `{ ok: true, api: 1, ui }`. `api` is the version of this contract; `ui` says whether a viewer is mounted at `/` |
| GET | `/api/state` | | The active run's state (below). With no active run: `{ error, runs }` |
| GET | `/api/state?run=KEY` | | Any run's state, read-only, by key (paused and closed ones too) |
| GET | `/api/runs` | | Every run: `{ key, status, active, place, done, total, lastActivity }` |
| GET | `/api/events` | | Server-sent events. Each `data:` line is the same JSON as `/api/state`, sent on connect and again whenever it changes |
| GET | `/evidence/CP/FILE` | | A screenshot from that checkpoint's evidence, by the file names in `screenshots` |
| POST | `/api/approve-implementation-plan` | | Confirms the requirements plan |
| POST | `/api/approve-checkpoints` | | Approves the planned checkpoints with the current settings; refused until the coverage review is clean on the current list |
| POST | `/api/approve-brief` | | Legacy alias for `/api/approve-implementation-plan` |
| POST | `/api/approve-plan` | | Legacy alias for `/api/approve-checkpoints` |
| POST | `/api/approve/CP` | | Approves a checkpoint awaiting approval; refused unless all its gates pass on the current code |
| POST | `/api/feedback` | `{ text, cp?, brief?, plan? }` | Feedback to the agent. With `cp` on a checkpoint awaiting approval, requests changes and sends it back to building. With `brief: true` or `plan: true`, requests changes on the plan |
| POST | `/api/settings` | `{ autonomy?, granularity?, visual?, reviewers? }` | Changes run settings, in any direction. Valid values come from `settings.options` in the state |
| POST | `/api/switch` | `{ key }` | Makes another run the active one and pauses the current one |
| POST | `/api/close` | `{ decision }` | Answers the agent's request to complete or abandon the run: `confirm` or `keep` |

## The state

`/api/state` and every event carry the full snapshot that `theseus status --json
--full` prints. The fields a UI needs:

- `run`: the run's key, reference, settings and, while it is being settled,
  `plan` (with `status` `pending`, `draft` after changes are requested, or
  `confirmed`). `brief` is exposed as a compatibility alias for `plan`.
- `settings`: the current value of each setting, plus `options`. That is the one
  spec of each setting's label and choices. Each choice has `value`, `short`, `text`,
  `hint`, `current` and `available`. Render choices from it rather than
  hard-coding them.
- `checkpoints`: each with `id`, `title`, `done`, `ui`, `tests`, `status`
  (`pending`, `building`, `awaiting-approval`, `done`), `approved`, `approval`, the
  `gates` state of `red`, `tests`, `visual` and `review`, the `evidence` behind
  each gate (including every reviewer round's findings), and `screenshots`.
- `coverage`: the review of the planned checkpoints against the plan. `state` is
  `none`, `findings`, `stale`, `pass`, or `off` once they are approved (or when the
  run has no plan); `evidence` holds every round, shaped like a gate's (`reviewers`,
  `history` with each round's findings); `fp` is the hash of the current list.
- `next`: one line saying what happens next and who acts.
- `learnings`, `feedback`, `log` (recent events), `runs`, `summary` (once
  closed) and `warnings` (`coverageIsolationNone` is true when the coverage review
  was recorded without isolation).

New fields may appear in the same `api` version. A route or field is removed or
changes meaning only together with a bump of `api`.
