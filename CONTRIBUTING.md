# Contributing

## Before adding a skill

1. **Check it is a skill.** A skill is a workflow with exit criteria. If nothing
   an agent could do would violate the content, it is reference material — send
   it to [`references/`](references/) instead.
2. **Check for overlap.** Two skills that fire on the same situation compete, and
   the wrong one wins often enough to matter. Extend an existing skill in
   preference to adding a neighbour to it.
3. **Read [docs/skill-anatomy.md](docs/skill-anatomy.md).** It is the contract the
   linter enforces.

## Adding one

```sh
cp -r templates/skill-template skills/my-skill
$EDITOR skills/my-skill/SKILL.md
npm run check
```

Requirements, all enforced by CI:

- Directory name is kebab-case; frontmatter `name` matches it exactly
- `description` is under 1024 characters and contains a `Use when …` clause
- The five required sections are present (see the anatomy doc for alternatives)
- Every relative link resolves to a file that exists

## The quality bar

- **Specific** — steps an agent can follow, not principles it can agree with
- **Verifiable** — the Verification section names commands, not feelings
- **Grounded** — describe workflows that have actually been used, not idealized ones
- **Minimal** — every sentence occupies a context window; cut the ones that don't work

The `## Failure Modes` section deserves the most attention and usually gets the
least. Write down the specific excuse an agent would use to skip this workflow,
and the rebuttal. That table is what makes a skill hold up under time pressure.

## Modifying a skill

Keep the change focused, preserve the existing structure, and re-run
`npm run check` — a broken frontmatter field silently stops a skill from loading
at all, which is worse than a bad skill.

## Changing the rules themselves

The lint rules live in [`scripts/lib/skill-lint.js`](scripts/lib/skill-lint.js)
and are documented in `docs/skill-anatomy.md`. A rule change needs three things
in the same PR: the rule, a fixture under `scripts/__fixtures__/` that provokes
it, and a test asserting on the specific error message. A test that only checks
"something failed" will pass while the rule quietly breaks.

## Repo-scoped files

`AGENTS.md` and `CLAUDE.md` configure agents working on *this repository*. They
are not meant to be copied into your own project — the reusable assets are the
skills in `skills/`.
