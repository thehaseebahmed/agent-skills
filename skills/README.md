# skills/

Each subdirectory here is one skill: a workflow an agent follows, keyed by a
`SKILL.md` whose frontmatter says when it applies.

```
skills/
  <skill-name>/
    SKILL.md          # required — frontmatter + the five required sections
    <supporting>.md   # optional — only when SKILL.md would exceed ~500 lines
    scripts/          # optional — only when the skill ships runnable helpers
```

| Skill | What it does |
|---|---|
| [`tha-theseus`](tha-theseus/SKILL.md) | Builds or migrates work one small checkpoint at a time behind four enforced gates — red-then-green tests, visual parity, two isolated adversarial reviewers, human approval — with a learnings file that later checkpoints read, and a live local viewer where the human approves |
| [`tha-readable-code`](tha-readable-code/SKILL.md) | Keeps a change readable: small single-purpose functions, well-named functions instead of explanatory comments, reuse of existing helpers, and names that still fit after behaviour changes. Standalone, and the readability lens of the theseus code reviewers |

To add one:

1. `cp -r templates/skill-template skills/<your-skill-name>`
2. Set `name:` in the frontmatter to match the directory name exactly
3. Write a `description` that says what the skill does *and* carries a
   `Use when …` clause — that clause is what makes an agent load it
4. Fill in the five required sections (see [docs/skill-anatomy.md](../docs/skill-anatomy.md))
5. `npm run check`
