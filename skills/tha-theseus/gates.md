# The gates

What each gate demands, what evidence it records, and what must run again after a
fix. `theseus.js` enforces everything marked **enforced**. The rest is on you.

Every gate pass stores a **fingerprint**: a hash of every file that differs from the
commit the checkpoint began on. It covers tracked and untracked files alike, and
ignores the state directory.

- `advance` re-computes it and refuses any gate whose fingerprint no longer matches.
- Committing mid-checkpoint does not change it; editing a file does.

## Red (before gate 1)

- The builder writes the checkpoint's planned tests. No implementation yet.
- `theseus record CP red [--cmd "<narrower command>"]` runs the command, and
  **requires a non-zero exit** (enforced).
- A failure caused by a syntax error is not a red run. Read the recorded tail and make
  sure the tests fail *for the right reason*: the behaviour is missing.

## Gate 1: Behaviour

- `theseus record CP tests` runs the test command and requires exit 0 (enforced). The
  exit code and the last 40 lines of output are stored as evidence.
- **Requires** a recorded red run (enforced).
- Test everything that doesn't need a browser here: permissions, rules, data
  transformations, error paths. A manager approving leave is a function call, not a
  click-through.
- Use `--cmd` to run the checkpoint's tests narrowly while iterating. Run the full
  suite at least once before `advance`, so a regression elsewhere can't hide.
- **Multi-repo runs:** the test command runs in each repo the checkpoint lists, in
  that repo's root.
  - Red needs at least one repo failing; gate 1 needs every one passing.
  - A change in *any* repo of the run makes passed gates stale, including repos the
    checkpoint doesn't list.
  - `theseus diff` shows every repo, with each path prefixed by its repo's name.

## Gate 2: Visual

**Requires** gate 1 passed at the current code (enforced).

### `ui: false`

`theseus record CP visual --skip "<reason>"` needs a reason, and is refused on a
`ui: true` checkpoint (enforced).

### `ui: true`

1. **Match state.** Put the reference and the build into the same state before
   capturing anything: same data, same step, same validation state. Comparing a
   submitted form with an untouched one produces noise, not findings.
2. **Capture** both at the same viewport size, using whatever drives the UI in this
   repo (Playwright, a simulator, a browser tool). Save the screenshots under
   `.theseus/current/evidence/<CP>/`, where the viewer shows them side by side.
3. **Two blind reviewers**, in separate subagents. Each is given only:
   - the reference capture
   - the build capture
   - the design doc, if there is one
   - [reviewer.md](reviewer.md)

   They are *not* given the code, the plan or the project instructions. One judges
   **appearance** (spacing, size, alignment, typography, colour, copy). The other
   judges **interaction** (what happens on tap, type, submit and error, and the
   transitions between states).
4. Record each:
   `theseus record CP visual --reviewer look --findings N` and
   `--reviewer behave --findings N`. The gate passes when two distinct reviewers report
   zero findings at the current code (enforced).

**Model choice:** if the harness lets you pick a reviewer's model, consider a
different model from the builder's. Shopify reportedly found some models markedly
better at spatial comparison. This is optional and not portable; same-model isolated
reviewers still work.

### After a fix

- If the fix could change anything visible, run gate 2 again.
- If it provably cannot (a rename, a pure-logic change), record
  `--carry "<why nothing visible changed>"`. This is allowed only after an earlier
  visual pass (enforced), and the reason is shown in the evidence.

## Gate 3: Adversarial review

**Requires** gates 1 and 2 passed at the current code (enforced).

- Two reviewer subagents, dispatched separately. Each is given:
  - [reviewer.md](reviewer.md)
  - the checkpoint's diff (`git diff <base>`, where `base` is in `checkpoints.json`)
  - the architecture docs named at `init`
  - the output of `theseus learnings`

  Not the plan, not the builder's notes, not your summary.
- Each returns a verdict. Record it:
  `theseus record CP review --reviewer a --findings N [--note "<summary>"]`.
- The gate passes only when two **distinct** reviewer ids report **zero** findings,
  both at the current code (enforced). One reviewer, or the same id twice, is refused.

### When there are findings

1. A fresh `theseus-builder` in **fix mode** gets the findings, the diff and the
   learnings, and fixes all of them. It must be a new spawn, not the one that built
   the checkpoint: a context that wrote the code tends to defend it.
2. Re-run gate 1: `record CP tests`. The fix changed the fingerprint, so this is
   enforced.
3. Re-run gate 2, or `--carry` it with a reason.
4. Dispatch **both** reviewers again, fresh. Each gets its own previous findings and
   `theseus diff CP --since-review`: only what changed since the last review. A full
   diff is cheaper to skip and adds nothing the first round didn't see. The gate rule
   doesn't change: both must be clean at the current code.
5. Repeat until both are clean.

If a reviewer and the human disagree about a rule, the human decides. Update the
architecture doc or the learnings (`theseus learn`), then re-review. Never mark a finding "won't fix"
on your own authority.

## Gate 4: Human

**Requires** gates 1–3 passed at the current code (enforced by `advance`).

| Autonomy | `advance CP` |
|---|---|
| `step` | stops at `awaiting-approval` (exit 1) until the human approves |
| `batch:N` | succeeds while approval credit remains from the human's last approval; otherwise stops |
| `unattended` | succeeds; approval is recorded as deferred to PR review |

**Where the approval comes from:**
- **`--approvals viewer` (default):** the human clicks **Approve** in the viewer,
  which already shows the test output, the reviewers' notes and, for UI checkpoints,
  the paired screenshots. The agent runs `theseus wait`. Approvals typed on the CLI
  are refused.
- **`--approvals any`:** the human may approve in chat instead, recorded with
  `advance CP --approved-by NAME`. These are marked "reported by agent".
- **The viewer re-checks every gate at the current code before approving.** A
  checkpoint whose code changed after review cannot be approved there either.

Their feedback is distilled into the learnings either way. Change requests become new
checkpoints via `add`; they are not patched in silently.

## Isolation

Record `--isolation none` on any visual or review verdict obtained without a fresh
context, whether because the harness had no subagents or a headless session failed.
`theseus status` prints a warning for every checkpoint that has one. Tell the human.
