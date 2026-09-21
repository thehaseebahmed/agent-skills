# Cline

*Verified against the [Cline skills documentation](https://docs.cline.bot/customization/skills), September 2026. Skills landed in Cline 3.48.0.*

## Skill discovery

| Scope | Path |
|---|---|
| Workspace | `.cline/skills/<skill-name>/SKILL.md` |
| Global | `~/.cline/skills/<skill-name>/SKILL.md` |

Cline detects them automatically. Each skill is a directory with a `SKILL.md`
carrying `name` and `description` frontmatter, plus any supporting files.

## Install

```sh
mkdir -p .cline/skills
cp -r /path/to/agent-skills/skills/<skill-name> .cline/skills/
```

## Skills vs. rules

`.clinerules` holds always-on instructions; skills are lazy-loaded — Cline reads
only the descriptions and pulls a skill's body in when the prompt matches its
trigger. Put standing project conventions in `.clinerules`, and put workflows
that apply to particular tasks here. Moving a long rules file into skills is
usually a net win for context budget.
