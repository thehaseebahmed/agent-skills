# Codex

*Verified September 2026. Codex CLI made plugins a first-class primitive in
v0.117.0 (March 2026); check `codex --version` if the plugin commands are missing.*

## Skill discovery

Codex scans these locations for immediate child directories containing a
`SKILL.md` (no recursive search — only first-level subdirectories count):

| Scope | Path |
|---|---|
| Current directory | `$CWD/.agents/skills` |
| Parent directory | `$CWD/../.agents/skills` |
| Repository root | `$REPO_ROOT/.agents/skills` |
| User | `$HOME/.agents/skills` |
| System | `/etc/codex/skills` |

## Install

Project scope:

```sh
mkdir -p .agents/skills
cp -r /path/to/agent-skills/skills/<skill-name> .agents/skills/
```

User scope, all projects:

```sh
mkdir -p ~/.agents/skills
cp -r /path/to/agent-skills/skills/<skill-name> ~/.agents/skills/
```

Or clone this repo into your project — it ships an `.agents/skills` symlink
pointing at `skills/`, which is exactly what Codex looks for.

## As a plugin

`.codex-plugin/plugin.json` describes the pack for Codex's plugin system,
including the interface metadata (display name, category, capabilities) that
plugin listings render.

## AGENTS.md

`AGENTS.md` at the repo root is persistent context for agents working on *this*
repository. It is not something to copy into your own project — the reusable
assets are the skills in `skills/`.
