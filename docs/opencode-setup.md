# OpenCode

*Verified against the [OpenCode skills documentation](https://opencode.ai/docs/skills/), September 2026.*

## Skill discovery

OpenCode reads several directory conventions, project scope first:

| Scope | Paths |
|---|---|
| Project | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` |
| Global | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |

Each skill is a directory containing `SKILL.md` with YAML frontmatter.

## Install

This repo ships an `.opencode/skills` symlink pointing at `skills/`, so a clone
is discovered without copying anything:

```sh
git clone https://github.com/thehaseebahmed/agent-skills.git
```

To install into an existing project instead:

```sh
mkdir -p .opencode/skills
cp -r /path/to/agent-skills/skills/<skill-name> .opencode/skills/
```

Globally:

```sh
mkdir -p ~/.config/opencode/skills
cp -r /path/to/agent-skills/skills/<skill-name> ~/.config/opencode/skills/
```

OpenCode follows the AGENTS.md standard, so `.agents/skills/` works too and is
the path to prefer if you want one copy serving Codex and Gemini CLI as well.
