# Antigravity

*Partially verified, September 2026.* Google publishes skills documentation at
[antigravity.google/docs/skills](https://antigravity.google/docs/skills/), which
was unreachable from the environment this guide was written in. The exact
discovery directories are therefore **not verified here** — check that page
before relying on a path below.

## What is known

Antigravity supports the portable Agent Skills format: a directory per skill
containing a `SKILL.md` with `name` and `description` frontmatter. Skills from
this pack are in that format, so no conversion is needed.

## Install

The universal CLI detects Antigravity among its supported agents:

```sh
npx skills add thehaseebahmed/agent-skills
```

Failing that, copy a skill directory into whichever skills path the official
documentation names for your version, or paste the `SKILL.md` body into
Antigravity's rules/system-prompt configuration — a skill is plain Markdown and
works that way in any agent.

## Help wanted

If you install this pack into Antigravity and confirm the discovery paths, a PR
correcting this page is welcome.
