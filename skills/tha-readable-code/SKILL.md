---
name: tha-readable-code
description: Keep changed code readable and low in complexity — small single-purpose functions, well-named functions instead of explanatory comments, reuse of the helpers a codebase already has, and names that still match what the code does after its behaviour changes. Use when writing, refactoring or reviewing a diff for readability or complexity, when a function has grown large or deeply nested, when a change widens what a function does and its name may no longer fit, or as the readability lens of a tha-theseus code reviewer. Not for formatting, lint-only fixes or performance work.
---

# THA Readable Code

## Overview

Code is read far more often than it is written, and complexity arrives one
reasonable-looking change at a time: a function gains a branch, a comment
explains the new branch, a helper is written because nobody looked for the one
that exists, and a name stops describing what its function does. Each step
passes review alone. Together they produce code nobody can change safely.

This skill makes the agent check every change it writes or reviews against four
rules, and fix or report what breaks them:

| Rule | Broken when |
|---|---|
| **Small functions** | a function the change adds or grows does more than one job, runs long, or nests deep |
| **Names over comments** | a comment explains *what* code does, where a well-named function or variable could say it instead |
| **Reuse first** | new code does what an existing function, the standard library or an existing dependency already does |
| **Names track behaviour** | a function's behaviour changed and its name, or its callers' reading of it, no longer fits |

It works on its own, for an author tidying their change or a reviewer reading
someone else's. It is also the readability standard the
[tha-theseus](../tha-theseus/SKILL.md) code reviewers apply at gate 3, so its
findings use the same shape as theirs.

## When to Use

- Finishing a change, before calling it done: a refactor pass over your own diff
- Reviewing a diff, a pull request or a theseus checkpoint for readability
- A function has grown past what fits on a screen, or gained another level of nesting
- A change made a function do more, or less, than its name says
- About to write a helper, and not yet sure the codebase lacks one

**When NOT to use:**
- Formatting, whitespace and import order: that is the formatter's and linter's job.
- Code the change does not touch. A large function the diff only calls is not in
  scope; one the diff grows is.
- Performance or correctness review. Those come first; readability never excuses
  a behaviour change.
- Generated code, vendored code, and migrations or snapshots a tool writes.

## Workflow

The scope is always **the change**: the code the diff adds or modifies. Find it
first, then run the four checks over it in this order, because each one changes
what the next one sees.

### Step 1: Find the change and the house rules

```bash
git diff --stat <base>...HEAD     # or the working tree: git diff --stat
git diff <base>...HEAD
```

List every function, method or module-level block the diff adds or modifies.
Then look for the repository's own limits: a linter config with function-length,
complexity or nesting rules (`max-lines-per-function`, `max-depth`, `complexity`,
`C901`, `funlen`, `gocyclo`), a style guide, or `CONTRIBUTING.md`. **The repo's
limit wins** over the defaults below wherever it sets one.

### Step 2: Reuse first

For every function or block of logic the change introduces, search before
accepting it:

```bash
git grep -n -i "<verb>\|<noun>"     # e.g. "slug", "retry", "parseDate", "chunk"
```

- Look in the places helpers live: `utils/`, `lib/`, `helpers/`, `common/`,
  `shared/`, and the module the new code sits in.
- Check the language's standard library and the dependencies already in the
  manifest. Do not add a dependency to satisfy this rule.
- **Found one that fits:** call it, and delete the new code.
- **Found one that almost fits:** extend it, when the change is small and every
  existing caller keeps working. Otherwise keep the new code, and say why in one
  line of the review or commit body.
- **Found two that already do the same thing:** note it, but leave it unless the
  change touches both.

### Step 3: Small, single-purpose functions

A function the change adds or grows is too large when any of these holds, unless
the repo's limit says otherwise:

- its body runs past **about 30 lines**, not counting blank lines and closing braces;
- it does more than one job. The tells: blank-line-separated "paragraphs", a
  comment heading a block, an `and` in the name or in the honest description of it;
- it nests more than **three levels** of `if`/loop/`try`;
- it takes a boolean or mode argument that switches it between two behaviours.

Fix it by extracting each job into a function named for that job, with guard
clauses and early returns to flatten nesting, and by splitting a mode-switched
function into one function per mode. The original becomes a short sequence of
calls that reads like the description of what it does.

Do not extract one-line wrappers that only rename a call, or pull apart a
function that is long only because it is a flat list (a table, a switch over
cases, a builder chain): length alone is not complexity there.

### Step 4: Names instead of comments

For every comment the change adds:

```bash
git diff <base>...HEAD | grep -E '^\+\s*(//|#|/\*|\*|--|;)'
```

- **It explains what the next lines do** ("validate the input", "build the
  headers"): extract those lines into a function whose name says it, or rename the
  variable that needed explaining, and delete the comment.
- **It explains a magic value:** give the value a named constant.
- **It is stale or restates the code:** delete it.
- **It keeps, when** removing it would lose something no name can carry: *why*
  the code is unusual (an external API's quirk, a workaround with its issue link,
  an invariant enforced elsewhere), a doc comment on a public API that the repo's
  convention requires, a licence header, or a tool directive (`eslint-disable`,
  `type: ignore`, `nolint`).

The test is: delete the comment, then reread the code. If nothing is lost, or
a rename or an extraction would restore it, the comment goes.

### Step 5: Names still match behaviour

For every function, method, variable, parameter, file and type whose behaviour
the change altered, reread its name against its new body:

- **Widened:** a function that rewrote entries now also deletes them.
  `applyRewrites` becomes `applyChanges`. Prefer the most specific name that is
  still true of everything it does.
- **Narrowed:** it no longer does something its name promises. Rename it to
  what is left.
- **Changed kind:** `getUser` now creates the user when missing, so it is
  `findOrCreateUser`; `isValid` now also normalises, so split it.
- **Callers:** a call site that reads wrongly with the new behaviour is part of
  the rename.

Rename everywhere in the same change, then prove the old name is gone:

```bash
git grep -n "<oldName>"     # must print nothing outside changelogs and migrations
```

A rename across a public API that other packages or services call is not done
silently: keep the old name as a deprecated alias, or ask the human.

### Step 6: Prove nothing else changed

Every fix above is a refactor: behaviour must be identical. Run the repo's own
test command after the pass and read the output. A readability pass that turns a
test red has changed behaviour; undo the step that did it.

### As a reviewer

When reviewing rather than authoring, run Steps 1–5 and **report** instead of
fixing. Each finding names the place, the rule, and what correct looks like:

```
<file:line> — <what is wrong> — <rule: small functions | names over comments | reuse first | names track behaviour> — <what correct looks like>
```

- Reuse findings must cite the existing function by `file:line`. "There is
  probably a helper for this" is not a finding; search until you can cite it or
  drop it.
- Name findings must give the proposed name.
- Only the change is in scope. A pre-existing problem the diff does not touch is
  not a finding.
- Inside a tha-theseus run, use the reviewer brief's output block exactly; these
  findings count toward its `FINDINGS:` total like any other.

## Failure Modes

| Rationalization | Why it fails | Do this instead |
|---|---|---|
| "The comment helps the next reader" | It helps until the code changes and the comment does not; then it lies. A name is checked by every call site, a comment by nobody | Extract the commented lines into a function with that comment as its name |
| "It's only 45 lines, and it's all related" | Related is not the same job. The reader still has to hold every paragraph in mind to change one of them | Extract each paragraph; the parent should read as the list of steps |
| "Writing the helper is faster than finding one" | It is faster once. Then the two copies drift, and a bug is fixed in one | Spend the `git grep`. Cite what you found, or say you looked and there is none |
| "The name is close enough" | A name that is mostly true is the most misleading kind: readers trust it and skip the body | Rename to what it does now, at every call site, in the same change |
| "Renaming touches too many files" | That is the cost of the behaviour change already made, not of the rename | Rename with the editor's or language server's rename; check with `git grep` |
| "I'll clean it up in a follow-up" | The follow-up rarely comes, and the next change builds on the mess | Do it in this change while the context is loaded; it is a refactor and the tests guard it |
| "This old function is huge too, I'll split it while I'm here" | Out of scope; it bloats the diff and buries the real change | Leave code the diff does not touch. Mention it, at most |
| "Every comment is bad, so delete them all" | A comment that carries *why* — a vendor quirk, an issue link — is information no name can hold | Keep the why; remove only the what |
| "The extracted function is called once, so it's pointless" | A function's first job is to name a step; reuse is a bonus | Extract for the name. Inline only one-line wrappers that add no meaning |

## Verification

The skill was applied correctly when, for the change in scope:

- [ ] No function the change adds or grows exceeds the repo's limit, or ~30 lines,
      three levels of nesting and one job where the repo sets none
- [ ] `git diff <base>...HEAD | grep -E '^\+\s*(//|#|/\*|\*|--|;)'` lists only
      comments that carry a *why*, a required doc comment, a licence header or a
      tool directive
- [ ] Every new helper was searched for first, and either replaced by the existing
      one or kept with a stated reason
- [ ] Every function whose behaviour changed has a name true of all it now does,
      and `git grep -n "<oldName>"` prints nothing for each rename
- [ ] As a reviewer: every finding names a place, a rule and a fix, and every reuse
      finding cites the existing function by `file:line`
- [ ] The repo's full test suite passes after the pass, run with its own command
- [ ] The relevant items in [definition-of-done](../../references/definition-of-done.md) hold
