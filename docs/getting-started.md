# Getting Started

This repo is a **skill pack**: a directory of portable `SKILL.md` workflows that
AI coding agents load when a task matches. The format is shared across agents, so
one pack serves all of them.

> **Status:** the scaffolding, validators and integrations are in place; no
> skills have been added yet. Installing the pack today wires up the plumbing and
> gets you nothing to run. See [skills/README.md](../skills/README.md).

## The fastest path

The [`skills` CLI](https://www.npmjs.com/package/skills) installs any GitHub skill
repo into whichever agents it detects:

```sh
npx skills add thehaseebahmed/agent-skills
```

## Clone in place

Because `SKILL.md` discovery converged on a few directory names, cloning this
repo into a project makes it visible to several agents at once. The repo ships
symlinks that point the common discovery paths at `skills/`:

| Symlink | Read by |
|---|---|
| `.agents/skills/` | Codex, Gemini CLI, GitHub Copilot, OpenCode |
| `.claude/skills/` | Claude Code |
| `.opencode/skills/` | OpenCode |

```sh
git clone https://github.com/thehaseebahmed/agent-skills.git
```

Then point your agent at the clone, or copy the `skills/` directory into your own
project's discovery path.

## Where each agent looks

Verified against each tool's own documentation at the dates noted in the setup
guides. These move — if a path here disagrees with the vendor's docs, the
vendor's docs are right.

| Agent | Project scope | User scope | Guide |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | [claude-code-setup](claude-code-setup.md) |
| Codex | `.agents/skills/` | `~/.agents/skills/` | [codex-setup](codex-setup.md) |
| Cursor | `.cursor/skills/` | — | [cursor-setup](cursor-setup.md) |
| Gemini CLI | `.agents/skills/`, `.gemini/skills/` | `~/.gemini/skills/` | [gemini-cli-setup](gemini-cli-setup.md) |
| GitHub Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/` | [copilot-setup](copilot-setup.md) |
| Copilot CLI | same as Copilot | same as Copilot | [copilot-cli-setup](copilot-cli-setup.md) |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.config/opencode/skills/` | [opencode-setup](opencode-setup.md) |
| Windsurf | `.windsurf/skills/` | `~/.codeium/windsurf/skills/` | [windsurf-setup](windsurf-setup.md) |
| Cline | `.cline/skills/` | `~/.cline/skills/` | [cline-setup](cline-setup.md) |
| Kiro | `.kiro/skills/` | `~/.kiro/skills/` | [kiro-setup](kiro-setup.md) |
| Antigravity | see guide — unverified | — | [antigravity-setup](antigravity-setup.md) |
| Command Code | see guide — unverified | — | [commandcode-setup](commandcode-setup.md) |

Any agent that reads Markdown instructions can use these skills even without
native discovery — paste the `SKILL.md` body into that agent's rules or system
prompt.

## Adding your own skill

```sh
cp -r templates/skill-template skills/my-skill
$EDITOR skills/my-skill/SKILL.md     # set name: my-skill, write the content
npm run check
```

[docs/skill-anatomy.md](skill-anatomy.md) is the full contract.
