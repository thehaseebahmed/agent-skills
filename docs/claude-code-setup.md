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

## Stop hook

The same file registers a `Stop` hook for `tha-theseus`. It runs
`theseus.js check`, which does nothing unless a Theseus run is active in the
project. While a checkpoint is being built with gates still open, it exits 2 —
Claude Code's documented way for a `Stop` hook to block stopping and feed its
stderr back to the model — so the agent keeps going instead of declaring victory
early. It lets the session stop while a checkpoint waits for human approval,
gives up after three blocks per checkpoint, and exits 0 on any error, including
a missing `node`.

## Theseus viewer and agents

- **Viewer:** `theseus.js serve` starts a local viewer on `127.0.0.1` and prints its
  link. In Claude Code on your own machine, open it in a browser to follow the run and
  approve checkpoints. In Claude Code on the web, the link points inside the cloud
  container and is not reachable. Start those runs with `--approvals any` or
  `--autonomy unattended`.
- **Several repos:** start the session in the folder that holds them and run
  `theseus.js init --repos api,web …` there. The Stop hook finds that run from inside
  any of the listed repos. Run `theseus.js agents` in that same folder, since Claude
  Code reads `.claude/agents/` from the session's project folder.
- **Agents:** `theseus.js agents --target claude` writes
  `.claude/agents/theseus-planner.md`, `theseus-builder.md` and
  `theseus-reviewer.md`. These are lean by default, to cut the start-up cost of each
  subagent.

  | Agent | tools | effort | maxTurns | omitClaudeMd |
  |---|---|---|---|---|
  | planner | Read, Grep, Glob | medium | 40 | true |
  | builder | Read, Edit, Write, Bash, Grep, Glob | session's | 80 | — (keeps project rules) |
  | reviewer | Read, Grep, Glob | medium | 30 | true (blind to project rules by design) |

  - **Overrides:** `--<role>-model`, `--<role>-effort` (`inherit` drops the line) and
    `--<role>-max-turns`.
  - **`model`** accepts `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or
    `inherit`. All of these fields are documented at
    [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)
    (checked October 2026).
  - **`omitClaudeMd`** needs Claude Code v2.1.271 or later, per that page. On older
    versions, expect the field to be ignored and the agent to load CLAUDE.md as
    before.
- **Settings mid-run:** autonomy, approvals, visual review (on/off) and the number of
  code reviewers (0–2) can be changed at any time by clicking their chip in the
  viewer's header. The agent sees a `settings changed` line on
  its next command.
