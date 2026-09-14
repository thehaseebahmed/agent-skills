# Cursor

*Verified September 2026. Cursor added `SKILL.md` support in 2.4; Cursor 3
("Glass") carries it forward.*

## Skill discovery

```
.cursor/skills/<skill-name>/SKILL.md
```

One directory per skill, at the project root. The filename is exactly `SKILL.md`,
and the Markdown file is not nested deeper than one level — Cursor does not
search recursively.

## Install

```sh
mkdir -p .cursor/skills
cp -r /path/to/agent-skills/skills/<skill-name> .cursor/skills/
```

Or let the CLI place them:

```sh
npx skills add thehaseebahmed/agent-skills
```

## How Cursor uses them

Cursor reads the frontmatter descriptions up front and pulls in the full
instructions — plus any bundled scripts or reference files — only when a task
matches. That is why the `Use when …` clause in each description matters more
than the body: it is the only part the agent sees while deciding.

Cursor treats Agent Skills as the preferred extension mechanism over always-on
rules, precisely because skills keep the context window lean.
