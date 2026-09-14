# Working on this repository

Context for AI agents making changes here. This is a **skill pack**: the product
is the content of `skills/`, and everything else exists to keep that content
valid and installable.

## Before you finish

```sh
npm run check     # validators + unit tests; CI runs the same thing
```

Read the output. A skill with broken frontmatter does not load at all, and
nothing at runtime will tell you so.

## Layout that matters

| Path | Role |
|---|---|
| `skills/<name>/SKILL.md` | The product. One workflow per directory. |
| `templates/skill-template/` | Copy this to start a skill; it lints clean as-is. |
| `references/` | Checklists shared by several skills. Not skills themselves. |
| `scripts/lib/skill-lint.js` | The rules. Change here, document in `docs/skill-anatomy.md`. |
| `scripts/__fixtures__/` | Fixture skills the linter tests run against. |
| Five plugin manifests | `plugin.json`, `.claude-plugin/{plugin,marketplace}.json`, `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` |

## Rules with teeth

- **Version bumps touch all five manifests.** `scripts/validate-manifests.js`
  fails the build otherwise — that is the entire reason it exists.
- **A lint rule change needs a fixture and a test** asserting the specific error
  message, not merely that linting failed.
- **Skills are workflows, not documents.** Content that cannot be violated goes
  in `references/`.
- **Setup docs make factual claims about other people's tools.** Every path in
  `docs/*-setup.md` was verified against that vendor's documentation, with the
  date noted. Do not add or edit one from memory — check the vendor's docs, and
  if you cannot reach them, say the page is unverified rather than guessing.
- **The symlinks are load-bearing.** `.agents/skills`, `.claude/skills` and
  `.opencode/skills` point at `skills/` so a clone is discoverable in place.
  Don't replace them with copies.

## Conventions

- No runtime dependencies. Node builtins only, so `npm install` is never needed.
- Scripts exit 0 on success and 1 on error, and print what failed.
- The `SessionStart` hook must exit 0 on every path, including failure.
