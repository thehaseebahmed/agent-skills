# Kiro

*Verified against the [Kiro agent skills documentation](https://kiro.dev/docs/skills/), September 2026.*

## Skill discovery

| Scope | Path |
|---|---|
| Workspace | `.kiro/skills/<skill-name>/SKILL.md` |
| User | `~/.kiro/skills/<skill-name>/SKILL.md` |

Kiro addresses skills through a `skill://` URI scheme that accepts those paths,
glob patterns, and home-directory expansion.

## Install

```sh
mkdir -p .kiro/skills
cp -r /path/to/agent-skills/skills/<skill-name> .kiro/skills/
```

## Layout

A Kiro skill folder is the standard portable shape: `SKILL.md` at the root, with
optional `scripts/`, `examples/`, and `resources/` subdirectories. Skills written
for this pack drop in unchanged.
