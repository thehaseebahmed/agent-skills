# Agent Skills

Reusable engineering workflow skills for AI coding agents — portable `SKILL.md`
files that load when a task matches, and tell the agent what to do, how to check
it, and how it usually goes wrong.

> **Status: scaffolding complete, no skills yet.**
> The validators, per-agent integrations, plugin manifests and CI are in place.
> `skills/` is intentionally empty — content comes next. See
> [skills/README.md](skills/README.md) to add the first one.

## Why skills and not a rules file

A rules file is always in context, so it has to stay short, and everything in it
competes with the actual task. A skill is loaded on demand: the agent sees only
the name and description until a task matches, then pulls in the full workflow.
That inverts the trade-off — skills can be long and specific precisely because
they are absent most of the time.

The corollary is that **a skill is a workflow, not a document**. If nothing an
agent could do would violate it, it is reference material, and it belongs in
[`references/`](references/).

## Install

```sh
npx skills add thehaseebahmed/agent-skills
```

In Claude Code, install it as a plugin instead:

```
/plugin marketplace add thehaseebahmed/agent-skills
/plugin install agent-skills@haseeb-agent-skills
```

Per-agent instructions — Claude Code, Codex, Cursor, Gemini CLI, Copilot,
Copilot CLI, OpenCode, Windsurf, Cline, Kiro, Antigravity, Command Code — are in
[docs/getting-started.md](docs/getting-started.md), each verified against that
tool's own documentation.

## Layout

```
skills/            one directory per skill, each with a SKILL.md
templates/         copy-me starting point for a new skill
references/        checklists shared by more than one skill
commands/          slash-command wrappers (generic TOML)
.claude/           Claude Code commands + skills symlink
.agents/           portable plugin manifest + skills symlink
.codex-plugin/     Codex plugin manifest
.gemini/           Gemini CLI commands
.opencode/         OpenCode skills symlink
hooks/             SessionStart hook that prints the skill inventory
scripts/           validators and their unit tests
docs/              setup guides and the skill contract
```

The `.agents/skills`, `.claude/skills` and `.opencode/skills` symlinks all point
at `skills/`, so cloning this repo into a project makes the pack visible to
Codex, Gemini CLI, Copilot, Claude Code and OpenCode without copying anything.

## Adding a skill

```sh
cp -r templates/skill-template skills/my-skill
$EDITOR skills/my-skill/SKILL.md      # set name: my-skill, then write it
npm run check
```

Every skill must carry `name` (matching its directory) and a `description` with
a `Use when …` trigger clause, and must have all five required sections. The
full contract is [docs/skill-anatomy.md](docs/skill-anatomy.md); the linter in
[`scripts/lib/skill-lint.js`](scripts/lib/skill-lint.js) enforces it.

## Checks

```sh
npm run lint     # validate skills and plugin manifests
npm test         # unit tests for the linter
npm run check    # both
```

No dependencies — Node 20+ and its built-in test runner. CI runs the same
commands on every push.

## Credits

The structure of this repo — the lifecycle framing, the five-layer layout, the
validator-and-eval approach — is modeled on
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), which is
worth reading if you want a mature pack with its skills already written. All code
and prose here is original.

## License

MIT — see [LICENSE](LICENSE).
