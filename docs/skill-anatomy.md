# Skill Anatomy

The contract every `SKILL.md` in this repo must satisfy. `scripts/lib/skill-lint.js`
enforces it; this document explains it.

## The shape

```
skills/<skill-name>/
  SKILL.md          # required
  <supporting>.md   # optional, only when SKILL.md would run long
  scripts/          # optional, only when the skill ships runnable helpers
```

The directory name is kebab-case and is the skill's identity. `SKILL.md` is
spelled exactly that way — discovery is case-sensitive on Linux and in CI.

## Frontmatter

```yaml
---
name: your-skill-name
description: What the skill does, in one clause. Use when <the situation that should trigger it>.
---
```

| Field | Rule |
|---|---|
| `name` | Required. Must equal the directory name exactly. |
| `description` | Required. 1024 characters maximum. Must contain a `Use when …` clause. |

The description carries more weight than anything else in the file. Agents keep
only the name and description in context and load the body when a task looks
like a match — so a description that describes the topic instead of the trigger
produces a skill that never fires. Write the trigger in the words a user would
actually use.

## Required sections

Five `##` headings, in this order. The linter accepts the listed alternatives.

| Section | Accepted alternatives | What goes in it |
|---|---|---|
| `## Overview` | Summary, What This Does | What the skill makes the agent do, and the failure it prevents |
| `## When to Use` | Triggers | Triggering situations, plus an explicit "when NOT to use" |
| `## Workflow` | Process, Steps | Ordered steps with checkpoints between them |
| `## Failure Modes` | Anti-Patterns, Red Flags | The rationalizations agents use to skip steps, and the rebuttals |
| `## Verification` | Exit Criteria, Definition of Done | Checkable exit criteria with the commands that prove them |

`## Failure Modes` is the section most often written as filler and is the one
that does the most work. An agent under time pressure looks for a reason the
workflow does not apply to this case; if the reason is listed with its rebuttal,
the shortcut is much harder to take.

## What makes something a skill

A skill is a **workflow with exit criteria**, not a reference document. The test:
if the content cannot fail — if there is nothing an agent could do that would
violate it — it is background reading, and it belongs in `references/`.

- **Actionable** — steps, not principles
- **Verifiable** — a stated way to tell whether it was followed
- **Scoped** — one job; overlapping skills compete and the wrong one wins
- **Minimal** — every sentence earns its place in a context window

## Supporting files and references

Keep `SKILL.md` under ~500 lines; past that the linter warns and the content
should move into a sibling file the skill links to. Material shared by more than
one skill goes in top-level [`references/`](../references/), not inside a skill
directory — that is what keeps two skills from drifting into two versions of the
same checklist.

Relative links are validated: a link to a file that does not exist fails the
build.

## Checking your work

```sh
npm run check          # lints skills and manifests, then runs the unit tests
```
