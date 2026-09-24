---
name: tha-planning
description: Plan a feature as a per-layer change inventory plus a test-first contract, written to plan.md and tasks.md. Use when asked to plan, design, scope, or break down work before implementing — a spec that needs turning into tasks, a change that feels too large to start, or any "write me a plan" request. Produces an explicit list of what is added/modified/removed in each layer (API, application, domain, infrastructure, migrations, UI, wiring) and an up-front catalogue of integration-style test cases — happy and unhappy paths — that drive the outermost entry point without touching real infrastructure.
---

# THA Planning

## Overview

Most plans read like a to-do list: "add the endpoint", "wire up the service", "add
tests". That hides the two things that actually determine whether the work goes well —
**which artifact changes in which layer**, and **what the tests will assert**.

This skill produces two files:

- **`plan.md`** — the change inventory (per layer, per artifact, ADD/MODIFY/REMOVE) and
  the test contract (every case, happy and unhappy, with stable IDs).
- **`tasks.md`** — the execution order: vertical slices, each one written red→green,
  referencing the test IDs from `plan.md`.

The plan is the contract; the tasks are the schedule. Neither is implementation — **do
not write production code while planning.**

## When to Use

- A spec, ticket, or feature request needs to become implementable work
- The change spans more than one file and it isn't obvious what it touches
- You want the shape of a change visible before any code exists
- Work will be split across sessions or agents

**Not for:** single-file edits with obvious scope, typo/config fixes, or a ticket that
already contains a per-layer breakdown and test list.

## Workflow

### Step 0 — Locate and identify the plan

Do this **first**, before reading code. It tells you whether you are starting fresh or
resuming.

#### Where the files go

```
if $THA_PLANS_DIR is set  →  $THA_PLANS_DIR/<repo-name>/
else                      →  <repo-root>/plans/
```

`<repo-name>` is the basename of `git rev-parse --show-toplevel`, so plans for different
repos never collide inside a shared notes vault.

```
<plans-dir>/
├── plan.md            # the one active plan
├── tasks.md           # its task list
└── archive/
    ├── PROJ-412/{plan.md,tasks.md}
    └── refactor-ocr-queue/{plan.md,tasks.md}
```

```bash
PLANS_DIR="${THA_PLANS_DIR:+$THA_PLANS_DIR/$(basename "$(git rev-parse --show-toplevel)")}"
PLANS_DIR="${PLANS_DIR:-$(git rev-parse --show-toplevel)/plans}"
```

**Invariant: there is never more than one `plan.md` / `tasks.md` outside `archive/`.**
Everything else lives in `archive/<key>/`.

#### The key

Every plan has a key, so it can be referred to later. Ask the user:

> Is there a task key for this work (Jira / Linear / GitHub issue)?

If yes, use it verbatim (`PROJ-412`, `ENG-88`, `#341`). If not, derive a stable
kebab-case slug from the feature (`add-bookmark-folders`) and **tell the user which key
you used**. The key goes in `plan.md` frontmatter, in the first line of `tasks.md`, and
becomes the archive folder name.

#### If a plan already exists

Read the existing `plan.md` frontmatter and compare its key and scope to the request:

| Situation | Action |
|---|---|
| Same work — revise, extend, or re-plan the same key | Update `plan.md` and `tasks.md` **in place**. Never reset tasks already checked off |
| Different work, and **no unchecked tasks remain** | Ask to archive, then `git mv` both files to `archive/<key>/`, set `status: archived`, and write the new plan |
| Different work, and **unchecked tasks remain** | **Stop and ask.** Report the existing key, title, and how many tasks are unchecked, then offer: archive it anyway / finish it first / put the new plan elsewhere |

Unfinished work is never archived, overwritten, or renamed without the user saying so —
those unchecked tasks may be mid-build in another session, and that state exists nowhere
else. `plan.md` and `tasks.md` always move together as a pair.

### Step 1 — Recon and layer map

Read-only. Two outputs.

**a. The layer map.** For each canonical layer, find the real directory in *this* repo —
or record `n/a`. Never invent layers a repo doesn't have, and never skip one silently.

| Canonical layer | What lives there |
|---|---|
| API / Transport | HTTP routes, controllers, CLI commands, MCP tool handlers, queue consumers |
| Application / Use cases | handlers, orchestrators, services that sequence one unit of work |
| Domain | entities, value objects, domain rules and invariants |
| Infrastructure / Adapters | repositories, external API clients, filesystem/queue/mail adapters |
| Persistence / Migrations | schema, migrations, seed data |
| UI / Front end | components, pages, client API calls, state |
| Config / Wiring | DI registration, env vars, route registration, feature flags |
| Docs / Skills | READMEs, agent skills, API docs that must move with the code in the same commit |

**b. The ground truth for tests:** the test command, the test directory layout, and how
existing tests substitute infrastructure (fixtures, DI overrides, in-memory stores).
Reuse what's there — note the existing helpers by path rather than planning new ones.

Also list existing functions and utilities the change should reuse. A plan that proposes
code which already exists is a failed plan.

**Delegate the recon.** On anything larger than a small repo, dispatch one sub-agent per
layer or per unknown area rather than reading it all yourself. Each returns two things
only: its row of the layer map, and the helpers in that area worth reusing, by path. The
exploration stays in the sub-agent; the summary is what lands in `plan.md`. Settle the
layer map before Step 2 — every later delegation drafts against it. If the harness has no
sub-agents, do the same recon inline but write only the summary into the plan.

### Step 2 — The change inventory

The centrepiece of `plan.md`. One row per artifact, grouped by layer, each tagged
`ADD`, `MODIFY`, or `REMOVE`.

```markdown
### API — `src/Api/Controllers/`
| Change | Artifact | Detail |
|---|---|---|
| ADD | `BookmarksController.Create` | `POST /bookmarks` → 201 + `Location`; 400 invalid body; 409 duplicate url |
| MODIFY | `BookmarksController.List` | new `?folder=` filter, unfiltered behaviour unchanged |

### Application — `src/Application/Bookmarks/`
| Change | Artifact | Detail |
|---|---|---|
| ADD | `CreateBookmarkHandler` | validates folder exists, normalises url, delegates to repository |

### Domain — `src/Domain/`
| Change | Artifact | Detail |
|---|---|---|
| ADD | `Bookmark` entity | `Id`, `Url`, `Title`, `FolderId`, `CreatedAt`; invariant: absolute http(s) url |

### Infrastructure — `src/Infrastructure/Repositories/`
| Change | Artifact | Detail |
|---|---|---|
| MODIFY | `IBookmarkRepository` | add `Add(Bookmark)` and `ExistsByUrl(userId, url)` |

### Persistence / Migrations — `src/Infrastructure/Migrations/`
| Change | Artifact | Detail |
|---|---|---|
| ADD | `AddBookmarks` migration | `bookmarks` table; unique index `(user_id, url)` |

### Config / Wiring — `src/Api/Program.cs`
| Change | Artifact | Detail |
|---|---|---|
| MODIFY | DI registration | register `CreateBookmarkHandler` |

### UI — n/a (no front end in this repo)
### Docs / Skills — n/a
```

Rules:

- **Every canonical layer appears**, even if only as `n/a`. This is how the forgotten
  migration and the unregistered dependency get caught at plan time rather than at
  runtime.
- Rows name the **artifact** — class, function, route, table, component, env var — not
  "update the service".
- A `REMOVE` row must name what calls it today, and where those callers move to.
- When a change crosses a layer boundary, state the contract once (request/response
  shape, method signature) so work either side of it can proceed independently.
- If the repo has a UI, the UI section lists the component, the call it makes, and the
  states it renders (loading, empty, error) — "and the front end" is not a plan.

**Delegate per layer.** When the change spans several layers, one sub-agent drafts each
layer's table against the settled layer map and returns the rows, nothing else. You
assemble them and reconcile the boundaries. A sub-agent must be told the contracts at the
edges of its layer — decide an undecided contract before dispatching, not after, or two
layers come back describing different shapes of the same call.

### Step 3 — The test contract

#### a. The seam

State this once per plan, filled in for the repo at hand:

> Tests drive the **outermost in-process entry point** of each surface — controller
> action, route handler, CLI command, tool handler, pipeline function — and assert only
> **observable outputs**: status code, response body, error shape, state visible through
> the substituted boundary, emitted events. Everything behind that entry point runs for
> real: routing, model binding, validation, handlers, domain rules, mapping. Only the
> outermost infrastructure is substituted — database → in-memory or fake repository,
> network → stub client, clock / ids / randomness → deterministic, filesystem → temp
> directory. No test asserts on internal call sequences, and no test reaches a real
> database, network, queue, or third-party service.

These are integration-style tests of a surface, not unit tests of a class. If the inputs
and outputs are right, what happens between them is an implementation detail and is free
to change without touching the test.

Concrete per-stack recipes — ASP.NET `WebApplicationFactory`, FastAPI `TestClient` with
`dependency_overrides`, Express with `supertest`, in-process MCP tool handlers, pure
pipeline functions over a temp directory — are in
[`reference/seams.md`](reference/seams.md), along with how to pick a seam in an
unfamiliar stack. The principles behind the choice of double are in
[testing-patterns](../../references/testing-patterns.md).

#### b. The catalogue

Enumerate every case **before any code**, with stable IDs. Group by surface.

```markdown
### Surface: `POST /bookmarks`
| ID | Type | Scenario | Given → When → Then |
|---|---|---|---|
| T1.1 | happy | creates a bookmark | empty store → valid body → 201, body has id + url, `Location` header set, item returned by `GET /bookmarks` |
| T1.2 | happy | normalises the url | body with trailing space and uppercase host → 201, stored url normalised |
| T1.3 | happy | optional title defaults from url | body without title → 201, title = host |
| T1.4 | unhappy | missing url | → 400, error names `url` |
| T1.5 | unhappy | malformed url (`ftp://`, `notaurl`) | → 400, nothing written |
| T1.6 | unhappy | duplicate url for same user | one existing → 409, store still holds exactly one |
| T1.7 | unhappy | unknown folderId | → 422, nothing written |
| T1.8 | unhappy | repository fails | fake configured to throw → 500, error body has no stack trace |
```

**Coverage checklist — every surface answers each line with a case ID or an explicit
"n/a because …":**

- invalid or missing input (each required field, each malformed shape)
- unknown / missing resource
- auth, ownership, permission
- conflict, duplicate, idempotent repeat
- dependency failure and timeout (the substituted boundary misbehaving)
- boundary values — empty, maximum, pagination edges, unicode
- out-of-order or repeated calls, where sequence matters

Happy paths come first and define the contract; the unhappy paths are where the
behaviour actually gets decided. Every row's "Then" must be **observable at the seam** —
if you cannot express the expectation as an output of the entry point, either the seam
is wrong or the test is asserting an internal.

**Delegate per surface.** One sub-agent per surface, each handed the seam statement, the
coverage checklist, and that surface's inventory rows; each returns its table of cases.
The seam and the checklist are settled by you before any dispatch — they are the contract
every sub-agent drafts against, and catalogues drafted against different seams do not
merge.

### Step 4 — Slice vertically and order

Slice by user-visible capability, not by layer. Each slice cuts through every layer it
needs and leaves the system working.

**Bad:** all entities → all repositories → all endpoints → wire it up.
**Good:** "create a bookmark" (entity + migration + repo method + handler + endpoint) →
"list bookmarks by folder" → "delete a bookmark".

Order so that: dependencies come first, the riskiest or most uncertain slice is early
(fail fast), and a checkpoint lands after every 2–3 tasks:

```markdown
### Checkpoint: after Tasks 1–3
- [ ] Full suite green
- [ ] Every catalogue ID for slice 1 is implemented and passing
- [ ] No inventory row for slice 1 left unstruck
```

**Group into waves.** Two tasks are independent when they touch no file in common **and**
every contract between them is already fixed in the inventory rather than still being
decided by one of them. Independent tasks form a wave and run in parallel, one sub-agent
each; waves run in order, with a checkpoint between them. A task whose `Depends on` is
still unchecked does not belong in the current wave. Parallelism is a property of the
inventory, not of how urgent the work feels — if the rows do not prove independence, the
tasks are sequential.

### Step 5 — Write tasks.md, red→green

Each task pairs the tests it must write first with the implementation that makes them
pass:

```markdown
## Task 2: Create a bookmark — slice 1
**Layers:** API (ADD `BookmarksController.Create`) · Application (ADD `CreateBookmarkHandler`) · Infrastructure (MODIFY `IBookmarkRepository`)
**Size:** M · **Wave:** 2 — parallel with Task 3, shares no file with it
**Red — write these first, confirm they fail:** T1.1, T1.4, T1.6, T1.8 → `tests/Api/BookmarksCreateTests.cs`
**Green — implement:** `src/Api/Controllers/BookmarksController.cs`, `src/Application/Bookmarks/CreateBookmarkHandler.cs`, `src/Infrastructure/Repositories/BookmarkRepository.cs`
**Done when:** those IDs pass, full suite green (`dotnet test`), inventory rows for this task struck through
**Depends on:** Task 1
```

Rules:

- **No artifact without a row.** A task may not introduce something the change inventory
  doesn't list.
- **No behaviour without a test ID.** If a task needs behaviour no catalogue row covers,
  amend `plan.md` first — the contract leads, the code follows.
- Red means *run the tests and watch them fail* before implementing. A test that has
  never failed has proven nothing.
- **Size every task before writing it.** Anything past M is two tasks:

  | Size | Files touched | Meaning |
  |---|---|---|
  | XS | 1 | a single function, config value, or migration |
  | S | 2 | one endpoint or one component |
  | M | 3–5 | one vertical slice — where most tasks should land |
  | L / XL | 6+ | not a task. Split it until every piece is XS–M |

- **A task block is a sub-agent's entire brief.** Dispatching a wave means one sub-agent
  per task, each given its own block, its inventory rows, its test IDs and the seam — not
  the whole plan, and not the other tasks. Each returns a short summary: which IDs are
  green, which files it touched, and anything it had to do differently. Record that
  summary against the task and keep it; discard the transcript.

### plan.md template

```markdown
---
key: PROJ-412
title: Add bookmark folders
created: YYYY-MM-DD
status: active
---

# PROJ-412 — Add bookmark folders

## Context
Why this work exists: the problem, what prompted it, the intended outcome. One paragraph.

## Scope
**In:** …
**Out:** … (things a reader would reasonably assume are included but aren't)

## Layer map
| Layer | This repo | Touched? |
|---|---|---|
| API / Transport | `src/Api/Controllers/` | yes |
| Application | `src/Application/` | yes |
| Domain | `src/Domain/` | yes |
| Infrastructure | `src/Infrastructure/Repositories/` | yes |
| Persistence / Migrations | `src/Infrastructure/Migrations/` | yes |
| UI | — | n/a |
| Config / Wiring | `src/Api/Program.cs` | yes |
| Docs / Skills | `README.md` | yes |

## Change inventory
[per-layer ADD/MODIFY/REMOVE tables — Step 2]

## Test contract
**Seam:** [the paragraph from Step 3a, filled in for this repo]
**Harness:** [test command, test dir, existing fixtures/fakes to reuse, by path]
**Catalogue:** [per-surface tables — Step 3b]
**Coverage check:** [the checklist, each line answered]

## Slices and order
1. [slice] — tasks 1–3 (wave 1: task 1; wave 2: tasks 2–3)
2. [slice] — tasks 4–5

## Reuse
- `path/to/existing_helper` — [what it already does for us]

## Risks
| Risk | Impact | Mitigation |
|---|---|---|

## Open questions
- [needs a human answer before/during implementation]
```

### tasks.md template

```markdown
# PROJ-412 — tasks
Plan: ./plan.md

## Task 1: …
[Step 5 format]

### Checkpoint: after Tasks 1–3
- [ ] …
```

## Failure Modes

| Rationalization | Reality |
|---|---|
| "I'll write the tests after" | Then they'll be written to match what the code does, not what it should do. The catalogue is the spec; it comes first |
| "This one really needs the real database" | Then the seam is in the wrong place, or the assertion is about an internal. Real infrastructure in a test buys flakiness and slowness, not confidence |
| "The layer is obvious" | Write the row anyway. The rows nobody writes down are the migration, the DI registration, and the docs |
| "It's just a small change" | Then the inventory is three rows and takes a minute. Small changes that skip the inventory are how a missed `n/a` becomes a production bug |
| "I'll decide the error behaviour when I get there" | Deciding it at 2am inside a handler is how you get a 500 where a 409 belongs. Unhappy paths are designed, not discovered |
| "The old plan is stale, I'll just overwrite it" | Unchecked tasks may be mid-build in another session. Archive on request; never in silence |
| "I'll read the whole repo myself first" | Recon detail is needed once, in Step 1, and never again. Carrying it for the rest of the session spends the context the actual planning needs. Delegate it; keep the summary |
| "Running every task at once will be faster" | Two tasks sharing a file, or sharing a contract one of them is still deciding, will overwrite each other's work. Parallel is something the inventory proves, not something you hope for |

### Red Flags

- A plan whose tasks say "implement the feature" or "update the service"
- Any canonical layer missing from the inventory — including the `n/a` rows
- A surface with only happy-path tests
- A test that asserts a mock was called, rather than an output at the seam
- A test that opens a real connection to anything
- Tasks ordered by layer instead of by slice
- Behaviour appearing in `tasks.md` that no catalogue ID covers
- Two tasks in one wave that touch the same file
- A sub-agent handed the whole plan instead of its own task block
- More than one `plan.md` outside `archive/`
- Implementation starting before the human approved the plan

## Verification

- [ ] `plan.md` and `tasks.md` are in the resolved plans dir, with a key in frontmatter
- [ ] Any pre-existing plan was archived only with explicit user approval
- [ ] Every canonical layer appears in the inventory, `n/a` included
- [ ] Every inventory row names a concrete artifact
- [ ] The seam is stated, and the harness names the existing helpers it reuses
- [ ] Every surface has happy **and** unhappy cases, and answers the coverage checklist
- [ ] Every task names the test IDs it turns green and the files it touches
- [ ] Every task carries a size of XS–M, and checkpoints exist between slices
- [ ] Every task carries a wave, and no wave pairs two tasks that share a file
- [ ] Recon and any per-layer or per-surface drafting was delegated, with only the
      summaries kept in context
- [ ] Open questions are listed rather than guessed at
- [ ] The human has reviewed and approved the plan
- [ ] The relevant items in [definition-of-done](../../references/definition-of-done.md) hold
