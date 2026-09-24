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
| [`tha-planning`](tha-planning/SKILL.md) | Turns a spec into a per-layer change inventory (`plan.md`) and a test-first, wave-ordered task list (`tasks.md`) |

To add one:

1. `cp -r templates/skill-template skills/<your-skill-name>`
2. Set `name:` in the frontmatter to match the directory name exactly
3. Write a `description` that says what the skill does *and* carries a
   `Use when …` clause — that clause is what makes an agent load it
4. Fill in the five required sections (see [docs/skill-anatomy.md](../docs/skill-anatomy.md))
5. `npm run check`
