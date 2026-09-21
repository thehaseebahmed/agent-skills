# Claude Code

*Verified against [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills), September 2026.*

## As a plugin (recommended)

This repo ships a plugin manifest and marketplace entry, so Claude Code can
install it directly:

```
/plugin marketplace add thehaseebahmed/agent-skills
/plugin install agent-skills@haseeb-agent-skills
```

Plugin skills are namespaced — a skill named `my-skill` is invoked as
`/agent-skills:my-skill`, and slash commands from `.claude/commands/` come along
with it.

## As project skills

Copy the skills you want into the project:

```sh
cp -r skills/<skill-name> /path/to/project/.claude/skills/
```

Commit them to share with the team. Project skills live at
`.claude/skills/<name>/SKILL.md`.

## As personal skills

```sh
cp -r skills/<skill-name> ~/.claude/skills/
```

Available in every project on your machine.

## Precedence

Personal skills load first, then project, then enterprise managed settings.
A user-defined skill replaces a bundled one with the same name — useful when you
want to override a pack skill without editing the pack.

## Session hook

`hooks/hooks.json` registers a `SessionStart` hook that prints the installed
skill inventory. It resolves `${CLAUDE_PLUGIN_ROOT}` first and falls back to
`${CLAUDE_PROJECT_DIR}/.claude/hooks/`, and it exits 0 on every path — a hook
that fails must never block a session.
