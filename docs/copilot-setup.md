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

## Skills that run scripts

`tha-theseus` enforces its gates with `scripts/theseus.js`, which ships inside
the skill directory, so copying the directory brings it along. It needs Node 20+
and git on the machine or runner where Copilot works; it has no npm
dependencies. Copilot has no equivalent here of the Claude Code `Stop` hook this
pack registers, so under Copilot the gates are held by the script's refusals alone.

Its state goes in `.theseus/` in the directory Copilot is working in.

### The live viewer

`theseus.js serve` starts a local page on `127.0.0.1` and prints a link to it.

- **Locally (VS Code or Copilot CLI):** the link opens in your browser. That is where
  you follow the run and approve checkpoints.
- **VS Code Remote and Codespaces:** port forwarding may expose the link. This pack
  has not verified that.
- **The cloud coding agent on GitHub.com:** the link points at the agent's own
  runner, so you can't open it. Start those runs with `--approvals any` or
  `--autonomy unattended`, and approve in the PR.

### Custom agents with their own model

`theseus.js agents` writes `.github/agents/theseus-planner.agent.md` and
`theseus-reviewer.agent.md`, so planning and review can run on a different model
from the main session:

```sh
node <skill-dir>/scripts/theseus.js agents --target copilot \
  --planner-model-copilot "<model name as Copilot shows it>"
```

*Unverified: docs.github.com was unreachable when this was written (October 2026).*
The format follows repository custom agents in `.github/agents/*.agent.md`, with
`name`, `description`, `tools` and `model` frontmatter, as shown in the Copilot CLI
issue tracker. Two open issues there affect this:

- [github/copilot-cli#2133](https://github.com/github/copilot-cli/issues/2133): the
  CLI rejects a list in `model`. The generator always writes a single string.
- [github/copilot-cli#2758](https://github.com/github/copilot-cli/issues/2758): the
  CLI silently downgrades a subagent to the session's model when the subagent's
  model costs more. Start the session on at least the model you pinned.
