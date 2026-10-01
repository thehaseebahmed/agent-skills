---
name: tha-theseus
description: Build, port, or migrate work one small checkpoint at a time, where no checkpoint may start until the last one has passed four enforced gates — failing-then-passing tests, a visual match against the reference, two independent context-isolated adversarial reviewers, and human approval — with every piece of feedback kept in a learnings file that later checkpoints read. Use when asked to migrate or port a screen, module or app to a new stack, rebuild something while keeping its behaviour identical, build a large feature under strict quality gates, run a Helix-style or checkpoint-and-gate loop, or keep an agent working for hours without its quality drifting. Not for deciding what to build — that is tha-planning.
---

# THA Theseus

## Overview

The ship of Theseus had every plank replaced, one at a time, while it kept sailing.
This skill rebuilds software the same way, so the question "is it still the same
ship?" can be answered with evidence at every plank.

It is modelled on Shopify's Helix, the workflow behind rebuilding the Shop app with
coding agents. The idea is that **an attempt is allowed to be wrong, but it is not
allowed to move on until it isn't.** Work is split into small ordered checkpoints, and
each one must pass four gates:

| Gate | Proves | Passed when |
|---|---|---|
| 1 Behaviour | it works | the planned tests failed before the code, and pass now |
| 2 Visual | it looks and behaves like the reference | two blind reviewers find no differences (or `ui: false`, skipped with a reason) |
| 3 Review | the code underneath is sound | two independent, isolated adversarial reviewers both report zero findings |
| 4 Human | a person agrees | approval, at the cadence the autonomy level sets |

A gate written as prose is advice, and agents talk their way past advice. So the gates
are enforced by `scripts/theseus.js`, the only thing that can mark a checkpoint done.

- It runs the test commands itself.
- It fingerprints the code at every gate. A fix made after a review cannot ride
  through on the old verdict.
- It refuses any step taken out of order.

**Honest limit:** the script blocks mistakes and shortcuts, not malice. An agent that
records a reviewer verdict it never obtained will get past it. Don't.

In the steps below, `theseus` means `node <this skill's directory>/scripts/theseus.js`,
run from inside the target repository. It needs git and Node 20+, and has no
dependencies.

## When to Use

- Migrating or porting a screen, module, service or whole app to a new language,
  framework or platform, where it must still behave the same
- Rebuilding something against a reference: a legacy implementation, a running app, a
  design mock or prototype, or a written spec
- Building a feature large enough that one agent session would drift, which needs
  enforced quality over many hours
- Any request for a "Helix", checkpoint-and-gate, or "gated" build loop

**When NOT to use:**
- Deciding *what* to build, or producing a per-layer change inventory. That is
  `tha-planning`. Theseus executes; it does not scope.
- A one-file fix, a config change, or anything you would review in one sitting. The
  gates cost more than they save.
- Exploratory spikes whose code will be thrown away.

## Workflow

### The orchestrator rule

You are the **orchestrator**. You coordinate; you do not build. Each of these runs in
a **fresh subagent**, given only its brief:

- pre-flight checker
- checkpoint planner
- test planner
- test writer
- builder
- fixer
- each reviewer

Long runs fail when one context window carries everything, so you keep only
summaries.

How to get a fresh context:

| Harness | Mechanism |
|---|---|
| Claude Code | the Agent tool (subagents) |
| GitHub Copilot (VS Code, CLI) | its subagent / custom-agent mechanism |
| Neither available | a fresh headless session: `claude -p "<brief>"` or `copilot -p "<brief>"` |
| None of the above | do the work inline. For reviewers, record `--isolation none` |

Never claim isolation you did not have. `theseus status` reports every review done
without it.

### Step 0: Locate or resume the run

State lives beside `tha-planning`'s: `$THA_PLANS_DIR/<repo>/theseus/` if that is set,
otherwise `<repo>/plans/theseus/`. Inside it, `current/` holds the active run and
`learnings.md` holds the memory, which outlives every run.

```bash
theseus status
```

- **There is an active run:** resume it at the step `next:` names. Never start a
  second one.
- **There is none:** go to Step 1.

### Step 1: Pin the reference and the rules

Settle these with the human before anything else:

1. **Reference:** what defines "correct". The legacy code path, how to run the
   reference app, a design mock or prototype, or a spec.
   - **No visual reference for UI work?** Have a static HTML prototype or mock made
     and approved now. Gate 2 cannot run against nothing.
2. **Architecture docs:** the written standards the reviewers judge against
   (`ARCHITECTURE.md`, UI guidelines, `CONTRIBUTING.md`). If none exist, the human
   names the rules, and they go in `learnings.md` as the starting rules.
3. **Test command:** the repo's own command.
4. **Autonomy:**

   | Level | Human approves |
   |---|---|
   | `step` (default) | every checkpoint |
   | `batch:N` | once per N checkpoints |
   | `unattended` | nothing until the PR; every approval is recorded as deferred |

```bash
theseus init --key HR-7 --reference "legacy/LeaveForm.tsx + docs/mock.html" \
  --test-cmd "npm test" --arch "ARCHITECTURE.md,docs/ui.md" --autonomy step
```

**Pre-flight:** a subagent confirms that the test command runs and that the app (and
the reference app, if there is one) starts. Gates mean nothing on a project that is
already broken. Fix that first, or tell the human.

### Step 2: Plan the checkpoints, with their tests

Dispatch the **checkpoint planner** with [checkpoints.md](checkpoints.md) and the
reference. It returns an ordered list:

- small checkpoints (XS–S)
- smallest and most foundational first
- each one with an observable `done` and a `ui` flag

Then dispatch the **test planner**. It attaches the test cases to every checkpoint, so
the human approves what "done" means, not just titles.

```bash
theseus plan --file /tmp/checkpoints.json
```

This writes `checkpoints.md`, a plain-language view. Show it to the human.

**Stop here.** Nothing is built until the human approves the list:

```bash
theseus approve-plan --by <name>
```

### Step 3: The checkpoint loop

For each checkpoint, in order:

1. **Begin.**
   - `theseus begin CP1` refuses a dirty tree, an unapproved checkpoint, or a
     checkpoint whose predecessor isn't done.
   - Read `learnings.md` and hand it to every subagent below.
2. **Red.**
   - The test writer writes this checkpoint's planned tests.
   - Run `theseus record CP1 red`. The script runs the tests and **requires them to
     fail**: a test that has never failed has proven nothing.
3. **Build.** The builder implements against the tests and the reference. Its brief is:
   - the checkpoint block
   - the reference
   - `learnings.md`
   - the files in scope

   It is not given the whole plan.
4. **Gate 1, behaviour:** `theseus record CP1 tests` runs the tests. They must pass.
5. **Gate 2, visual.**
   - **`ui: false`:**
     `theseus record CP1 visual --skip "<why nothing visible changed>"`.
   - **`ui: true`:** follow [gates.md](gates.md#gate-2-visual).
     1. Put the reference and the build in the **same state**.
     2. Screenshot both.
     3. Dispatch two blind reviewers, one for appearance and one for interaction.
     4. Record each:
        `theseus record CP1 visual --reviewer look --findings N`.
6. **Gate 3, adversarial review.**
   - Dispatch **two separate reviewer subagents**, each given only
     [reviewer.md](reviewer.md), the diff, the architecture docs and `learnings.md`.
     Never give them your reasoning, or the builder's.
   - Record each verdict:
     `theseus record CP1 review --reviewer a --findings N`.
7. **Any findings.**
   - A fresh **fixer** subagent fixes every one. Not the builder, and not you.
   - Re-run gate 1, and gate 2 if anything visible could have changed. Otherwise
     record `visual --carry "<reason>"`.
   - Then dispatch **both** reviewers again.
   - The script rejects any gate that passed before the code changed, so there is no
     way around this.
8. **Memory.** Distil every finding and every piece of human feedback into one
   reusable line:
   `theseus learn --cp CP1 --source reviewer "<rule>"`.
   Write rules, not incidents: "inject the clock, never call `Date.now` in handlers",
   not "fixed the date bug".
9. **Gate 4, human.**
   - Run `theseus advance CP1`. The script checks gates 1–3 at the current code.
   - Under `step` it stops at `awaiting-approval`. Show the human:
     - the diff
     - the test output
     - the reviewers' summaries
   - When they approve: `theseus advance CP1 --approved-by <name>`.
10. **Commit** the checkpoint (code and tests) in the repo's commit style. Then begin
    the next one.

The full pass/fail criteria and re-run rules are in [gates.md](gates.md).

### Step 4: Close the run

When every checkpoint is done, the human tries the whole feature as a user would.

- **Change requests** become new checkpoints. Run `theseus add --file`, then
  `approve-plan`, then they go through the same loop. Each request is also distilled
  into `learnings.md`.
- **When nothing is left:** run `theseus archive`. Under `unattended`, the PR
  description lists every deferred approval from `theseus status`.

### Enforcement in Claude Code

The plugin's `hooks/hooks.json` registers a `Stop` hook that runs `theseus check`.

- While a checkpoint is `building` with gates open, it blocks the stop (exit 2) and
  says what is next.
- It allows the stop while the run waits on a human.
- It gives up after three blocks per checkpoint, so it can never trap a session.

Other harnesses rely on the script's refusals alone.

## Failure Modes

| Rationalization | Reality |
|---|---|
| "The reviewer's finding is just a nit" | Every finding is fixed or the gate stays shut. If a rule is wrong, change the architecture doc with the human, then re-review. Don't argue it away mid-checkpoint |
| "I fixed it after the review; it's obviously fine" | The fix is new code nobody has reviewed. The fingerprint check exists because this is the commonest way bad code ships |
| "The tests pass, so the UI is fine" | Gate 1 proves behaviour. Spacing, states and interaction are gate 2's job, and they drift silently |
| "One reviewer is enough" | Two independent reviewers fail differently; one misses what the other catches. That is the whole point of the gate |
| "I'll review it myself; I know the code" | You know what you *meant*. The reviewer must not, which is why it gets only the diff and the docs |
| "These three checkpoints are tiny; I'll do them together" | Then a failure can't be isolated, and an early wrong decision is built on twice. Raise the autonomy level instead, which batches approval, not gates |
| "The red run is a formality" | A test that never failed may not test anything. Writing the test after the code produces a test of what the code does, not what it should do |
| "I'll just build it myself; spinning up a subagent is slow" | Over 30 checkpoints your context fills, and quality falls where nobody is looking. Coordinate; delegate |
| "No subagents here, so I'll say the review was isolated anyway" | Record `--isolation none`. A false claim of isolation is worse than none |
| "The human is busy; I'll approve and move on" | Only a human approves. If they want fewer interruptions, the fix is `batch:N` or `unattended`, chosen by them |
| "The learning is specific to this checkpoint" | Then generalise it until it isn't, or it will be relearned on the next screen |

### Red Flags

- A checkpoint larger than S, or one whose `done` cannot be observed
- Code written before the plan was approved
- A reviewer brief that contains the builder's reasoning or the plan
- The same subagent building and fixing, or reviewing its own fix
- `learnings.md` unchanged after a checkpoint that had findings
- Hand-edits to anything under `plans/theseus/current/`: that is the script's state

## Verification

The skill was applied correctly when:

- [ ] `theseus status` shows every checkpoint `done`, and `next:` says the run is
      finished or archived
- [ ] No checkpoint shows `WARNING: reviewed without context isolation`, or the human
      was told about each one that does
- [ ] Every checkpoint is its own commit, in order
- [ ] `learnings.md` gained a rule for every finding and every piece of human feedback
- [ ] Under `unattended`, the PR description lists the deferred approvals
- [ ] The repo's full test suite passes on the final commit, run with its own command
- [ ] The relevant items in [definition-of-done](../../references/definition-of-done.md) hold
