# Definition of Done

A shared checklist skills can link to instead of restating. "Done" is a claim
about evidence, not about effort spent.

## The work itself

- [ ] The change does what was asked — the whole ask, not the easy part of it
- [ ] Anything deliberately left out is stated plainly, with the reason
- [ ] No debugging scaffolding, commented-out code, or stray `TODO` left behind
- [ ] The change reads like the code around it: same naming, same idioms

## Evidence

- [ ] The relevant tests were run, and the output was read — not assumed
- [ ] New behavior has a test that fails without the change
- [ ] A bug fix has a test that reproduced the bug before the fix landed
- [ ] The full suite passes using the repository's own commands
- [ ] Failures, skips, and flakes are reported as such, never rounded up to "passing"

## Fit

- [ ] Public interfaces that changed are documented where the project documents them
- [ ] Config, migration, or rollout steps a reader would need are written down
- [ ] The commit message says what changed and why, not just which files moved

## The honesty check

- [ ] Every claim in the summary is one you could demonstrate on request
- [ ] Nothing is described as verified that was only inspected
