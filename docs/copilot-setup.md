# GitHub Copilot

*Verified against [GitHub's agent skills documentation](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills), September 2026. Copilot added `SKILL.md` support in April 2026.*

## Skill discovery

| Scope | Paths |
|---|---|
| Personal | `~/.copilot/skills`, `~/.agents/skills` |
| Repository | `.github/skills`, `.claude/skills`, `.agents/skills` |

These apply to the Copilot coding agent and Copilot CLI alike. Each skill needs
its own subdirectory containing `SKILL.md`.

## Install

```sh
mkdir -p .github/skills
cp -r /path/to/agent-skills/skills/<skill-name> .github/skills/
```

Commit them so the cloud coding agent picks them up on its next run. Cloning this
repo into your project also works — it ships `.agents/skills` and `.claude/skills`
symlinks, both of which Copilot reads.

## Frontmatter

Copilot requires `name` and `description`. This pack's linter enforces both, plus
the `Use when …` trigger clause, so anything that passes `npm run check` is valid
for Copilot.

When Copilot selects a skill, the `SKILL.md` is injected into the agent's
context — the same portable file that works in Claude Code, Cursor, and the rest.
