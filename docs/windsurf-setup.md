# Windsurf

*Verified against the [Cascade Skills documentation](https://docs.windsurf.com/windsurf/cascade/skills), September 2026.*

## Skill discovery

| Scope | Path |
|---|---|
| Workspace | `.windsurf/skills/<skill-name>/` |
| Global | `~/.codeium/windsurf/skills/<skill-name>/` |

Each directory needs a `SKILL.md` with YAML frontmatter. Supporting files placed
alongside it become available to Cascade when the skill is invoked.

## Install

```sh
mkdir -p .windsurf/skills
cp -r /path/to/agent-skills/skills/<skill-name> .windsurf/skills/
```

Globally:

```sh
mkdir -p ~/.codeium/windsurf/skills
cp -r /path/to/agent-skills/skills/<skill-name> ~/.codeium/windsurf/skills/
```

## Notes

In Windsurf the frontmatter `name` is both the display name in the UI and the
handle for @-mentioning a skill, so keep it identical to the directory name —
which this pack's linter enforces anyway. The `description` is what Cascade uses
to decide when to invoke the skill.
