---
name: valid-skill
description: Demonstrates a skill description that forgets to say anything about triggers.
---

# Valid Skill

## Overview

A minimal skill that exists so the linter has something correct to agree with.

See the [shared checklist](../references/shared-checklist.md).

## When to Use

- When testing the linter
- When you need a known-good example

## Workflow

1. Read the frontmatter rules
2. Write the five required sections
3. Run the validator

## Failure Modes

| Excuse | Reality |
|---|---|
| "The description is obvious" | An agent that never loads the skill cannot follow it. |

## Verification

- [ ] `node scripts/validate-skills.js` reports no errors
