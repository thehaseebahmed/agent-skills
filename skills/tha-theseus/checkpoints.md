# Planning checkpoints

The brief for the `theseus-planner` subagent: it plans the checkpoints and their tests. The output is a JSON
array that `theseus plan --file` loads.

You are also given the viewer-approved **requirements brief**. The human agreed to it,
so every item in its `checkpoint_areas` and `acceptance_criteria` must be covered by
at least one checkpoint. If one cannot be, say which and why rather than dropping it
silently. Respect its `scope_boundaries`, `assumptions`, `risks`, and
`resolved_decisions`; unresolved questions are never permitted in a submitted brief.

You are dispatched only after viewer approval. Do not reopen requirements discovery,
create implementation code, or substitute your own approval for a missing decision;
return a targeted question to the orchestrator if the approved brief and reference
materially conflict.

## What a checkpoint is

One small, ordered unit of work, finished and verified before the next begins.

| Property | Rule |
|---|---|
| Size | Set per run, and `theseus plan` prints it. **`s-m`** (default): a small vertical slice, about 2–5 files, reviewable in under ten minutes. **`xs-s`**: one component, one rule, one endpoint, reviewable in a few minutes. Larger than the run's size means split it; much smaller means merge it with its neighbour, since every checkpoint costs a full round of subagents |
| `done` | Observable: a test outcome or a visible state. Never "implemented" or "refactored" |
| `ui` | `true` if anything a user sees or touches could change. When in doubt, `true`: a wrong `false` lets a visual regression skip gate 2 |
| `tests` | The cases that prove `done`: happy path first, then each unhappy path. Plain language; the builder turns them into code |

## Ordering: smallest and most foundational first

Each checkpoint builds on the ones before it, so order by **increasing complexity**:

1. pure rules
2. data shapes
3. single components
4. their composition
5. the screen or flow
6. the edge-case polish

A wrong early decision is then caught while it is still small and cheap to change.

This is not "riskiest first". A checkpoint sequence assumes the work is feasible and
minimises the cost of rework; it is not the place to find out whether the work can be
done at all. If a large risk is still open (an unproven library, an unknown API, a
performance question), settle it with the human, with a spike if needed, before
Theseus starts.

## From a reference

| Reference | How to derive checkpoints |
|---|---|
| Legacy code (migration) | Read the old screen or module and list its behaviours, states and edge cases. Each behaviour becomes a checkpoint and the old code is the spec. Note where the old code is wrong; ask the human whether to preserve or fix it |
| Running app | Walk each state (empty, loading, filled, error, success) and each interaction. Screenshots of each become gate 2's reference |
| Design mock or prototype | One checkpoint per component, then per composed region, then interactions |
| Written spec | One checkpoint per acceptance criterion, split until each is XS–S |

If the human already has a task list or ticket breakdown, seed from it rather than
re-deriving: each task becomes one or more checkpoints, and anything larger than S is
split.

## Writing the tests

The planner fills each checkpoint's `tests`. Every case should drive the
**outermost in-process entry point** a real caller would reach: the route, command,
tool handler or public function. It asserts only what is observable there:

- output
- status
- error shape
- state visible through the substituted boundary

Substitute only what leaves the process: database, network, clock, randomness,
filesystem. A case whose expected result can only be stated as "calls X internally" is
asserting an implementation detail. Rewrite it.

- Happy paths come first.
- Then the unhappy paths: invalid input, missing resource, permission, conflict,
  dependency failure, boundaries.

Per-stack recipes (ASP.NET, FastAPI, Express, MCP, CLI) are in
[seams](../../references/seams.md). The reasoning behind the choice of test double is
in [testing-patterns](../../references/testing-patterns.md).

## Output format

```json
[
  {
    "title": "Leave balance never goes negative",
    "done": "requesting more days than the balance is rejected with a message naming the balance",
    "ui": false,
    "repos": ["api"],
    "tests": [
      "request within balance is accepted and balance decreases",
      "request equal to balance is accepted and balance reaches zero",
      "request beyond balance is rejected; balance unchanged; message names remaining days"
    ]
  },
  {
    "title": "Leave request form, empty and error states",
    "done": "form matches docs/mock.html in its empty and validation-error states",
    "ui": true,
    "tests": [
      "submit with no dates shows the required-field error under both date inputs",
      "end date before start date shows the range error and disables submit"
    ]
  }
]
```

`repos` names the repos a checkpoint changes. It is required when the run spans
several repos, and is left out otherwise. One checkpoint may span repos when the
change is one vertical slice, such as an API field and the form that shows it.

The script assigns the ids (`CP1`, `CP2`, …). Write titles and `done` in plain
language: the human approves this list by reading it in the viewer, and if they can't
follow it, they can't catch what it's missing.

## Questions

When the reference is ambiguous (two plausible behaviours, or old behaviour that looks
like a bug), the planner asks. It does not guess. Unanswered questions go to the human
with the list, before approval.
