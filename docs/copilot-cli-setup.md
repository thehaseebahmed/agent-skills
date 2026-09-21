# GitHub Copilot CLI

*Verified against [GitHub's Copilot CLI skills documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills), September 2026.*

Copilot CLI reads the same skill directories as the rest of Copilot — see
[copilot-setup.md](copilot-setup.md) for the path table (`~/.copilot/skills`,
`~/.agents/skills` personally; `.github/skills`, `.claude/skills`,
`.agents/skills` per repository).

## Adding a skill

```sh
copilot skill add /path/to/agent-skills/skills/<skill-name>
copilot skill list
```

`copilot skill add` accepts a file, a URL, or a directory.

## In-session commands

| Command | Does |
|---|---|
| `/skills list` | List available skills |
| `/skills info` | Show a skill's details, including where it was loaded from |
| `/skills add` | Add an additional skill location |
| `/skills reload` | Reload skills without restarting |
| `/skills remove SKILL-DIRECTORY` | Remove a directly-added skill |

If a skill is not firing, `/skills info` is the fastest way to confirm which copy
is actually loaded — duplicates across personal and repository scope are the
usual cause.
