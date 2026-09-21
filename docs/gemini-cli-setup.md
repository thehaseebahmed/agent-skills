# Gemini CLI

*Verified against the [Gemini CLI skills docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md), September 2026.*

## Skill discovery

Resolved in this order, later tiers overriding earlier ones:

1. Built-in skills shipped with the CLI
2. Extension skills bundled in installed extensions
3. **User skills** — `~/.gemini/skills/` or the `~/.agents/skills/` alias
4. **Workspace skills** — `.gemini/skills/` or the `.agents/skills/` alias

Within a tier the `.agents/skills/` alias takes precedence over `.gemini/skills/`.
This repo ships an `.agents/skills` symlink, so a clone is discovered as-is.

## Install

From a git URL:

```sh
gemini skills install https://github.com/thehaseebahmed/agent-skills.git --consent
```

Or link a local checkout:

```
/skills link /path/to/agent-skills --scope workspace
```

Or copy directly:

```sh
mkdir -p .agents/skills
cp -r /path/to/agent-skills/skills/<skill-name> .agents/skills/
```

## Managing skills

| In session | In terminal |
|---|---|
| `/skills list [all] [nodesc]` | `gemini skills list --all` |
| `/skills link <path> [--scope user\|workspace]` | — |
| `/skills disable <name>` / `/skills enable <name>` | — |
| `/skills reload` (or `/skills refresh`) | — |
| — | `gemini skills uninstall <name> --scope workspace` |

`/skills reload` picks up a newly written skill without restarting the CLI —
worth knowing while iterating on one.

## Commands

`.gemini/commands/*.toml` holds Gemini CLI command wrappers. This repo ships
`example.toml` as a template only; real commands arrive with the first skills.
