# Planning checkpoints

The brief for the checkpoint planner and test planner subagents. The output is a JSON
array that `theseus plan --file` loads.

## What a checkpoint is

One small, ordered unit of work, finished and verified before the next begins.

| Property | Rule |
|---|---|
| Size | XS or S: one component, one rule, one endpoint. If you can't review it in a few minutes, split it |
| `done` | Observable: a test outcome or a visible state. Never "implemented" or "refactored" |
| `ui` | `true` if anything a user sees or touches could change. When in doubt, `true`: a wrong `false` lets a visual regression skip gate 2 |
| `tests` | The cases that prove `done`: happy path first, then each unhappy path. Plain language; the test writer turns them into code |

## Ordering: smallest and most foundational first

Each checkpoint builds on the ones before it, so order by **increasing complexity**:

1. pure rules
2. data shapes
3. single components
4. their composition
5. the screen or flow
6. the edge-case polish

A wrong early decision is then caught while it is still small and cheap to change.

This deliberately differs from `tha-planning`, which orders slices **riskiest first**
to fail fast on uncertainty. The two answer different questions. A plan decides
whether the work is feasible; a checkpoint sequence assumes it is and minimises the
cost of rework. If a large risk is still open, it belongs in planning before Theseus
starts.

## From a reference

| Reference | How to derive checkpoints |
|---|---|
| Legacy code (migration) | Read the old screen or module and list its behaviours, states and edge cases. Each behaviour becomes a checkpoint and the old code is the spec. Note where the old code is wrong; ask the human whether to preserve or fix it |
| Running app | Walk each state (empty, loading, filled, error, success) and each interaction. Screenshots of each become gate 2's reference |
| Design mock or prototype | One checkpoint per component, then per composed region, then interactions |
| Written spec | One checkpoint per acceptance criterion, split until each is XS–S |

If a `tha-planning` `tasks.md` exists for this work, seed from it rather than
re-deriving:

- each task becomes one or more checkpoints
- anything larger than S is split
- its test IDs (`T1.4`) go into `tests`

## Output format

```json
[
  {
    "title": "Leave balance never goes negative",
    "done": "requesting more days than the balance is rejected with a message naming the balance",
    "ui": false,
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

The script assigns the ids (`CP1`, `CP2`, …). Write titles and `done` in plain
language: the human approves this list by reading `checkpoints.md`, and if they can't
follow it, they can't catch what it's missing.

## Questions

When the reference is ambiguous (two plausible behaviours, or old behaviour that looks
like a bug), the planner asks. It does not guess. Unanswered questions go to the human
with the list, before approval.
