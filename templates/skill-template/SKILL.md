---
name: skill-template
description: Starting point for a new skill in this pack. Use when adding a skill, so the required frontmatter and sections are in place before you write any content.
---

# Skill Template

> Copy this directory to `skills/<your-skill-name>/`, rename the `name` field to
> match the new directory, then replace every section below. Delete this block.

## Overview

One paragraph: what this skill makes the agent do, and why that matters. Name the
failure it prevents. A skill is a workflow the agent follows, not background
reading — if this paragraph is describing a topic rather than an action, the idea
is not a skill yet.

## When to Use

- The concrete situation that should trigger this skill
- Another triggering situation
- A third

**When NOT to use:** the cases that look similar but are out of scope. This
section is what keeps the skill from firing on everything.

## Workflow

1. **First step** — what the agent does, and the observable output it produces.
2. **Second step** — including the checkpoint that must hold before moving on.
3. **Third step** — and so on. Steps are ordered and each one is checkable.

## Failure Modes

| Rationalization | Why it fails | Do this instead |
|---|---|---|
| "This change is too small to bother" | Small changes are where unverified assumptions hide | Run the same check regardless of size |
| "The tests are slow, I'll run them at the end" | The end is where several failures arrive at once and no longer isolate | Run the narrow check now, the full suite before you finish |

## Verification

The skill was applied correctly when:

- [ ] A concrete, checkable outcome
- [ ] Another one, with the command that proves it
- [ ] The relevant items in [definition-of-done](../../references/definition-of-done.md) hold
