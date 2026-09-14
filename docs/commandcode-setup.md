# Command Code

*Unverified, September 2026.* No primary documentation for Command Code's skill
discovery was reachable when this guide was written, so this page deliberately
makes no claim about specific directories. Treat anything below as the generic
fallback, not as vendor guidance.

## Generic install

Try the universal CLI first — it detects supported agents and writes to the right
place for each:

```sh
npx skills add thehaseebahmed/agent-skills
```

If Command Code is not among the agents it handles, use the portable path that
works in any Markdown-driven agent:

1. Open the `SKILL.md` of the skill you want
2. Paste its body into the agent's rules, system prompt, or custom-instructions
   configuration
3. Keep the `description` line at the top — it is the part that tells the agent
   when the workflow applies

## Help wanted

If you know Command Code's skill discovery paths, a PR replacing this page with
verified instructions is welcome.
