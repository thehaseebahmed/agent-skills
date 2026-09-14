# Testing Patterns

A shared reference for skills that ask for test evidence.

## Find the project's own commands first

Before writing a test, find how this repository runs them: `package.json`
scripts, `Makefile`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or the CI
workflow. Prefer the repo's wrappers (`./gradlew`, `./mvnw`, `make test`) over
globally installed tools — the wrapper pins the version CI uses.

## Shape of a good test

- **Arrange, act, assert** — three visible sections, in that order
- **One behavior per test** — a test that asserts four things reports one failure
- **Named for the behavior** — the name should read as a requirement
- **Independent** — it sets up and tears down its own state; order must not matter
- **Deterministic** — no wall-clock sleeps, no shared mutable fixtures, no network

## Assert on outcomes, not on interactions

Verify what the code produced, not which internal methods it called on the way.
Tests that assert call sequences break during correct refactoring and pass during
incorrect ones — the worst possible pairing.

## Prefer the least-fake double available

1. The real implementation — highest confidence
2. A fake — an in-memory implementation that actually works
3. A stub — canned answers
4. A mock — call verification; reach for it last

Mocks earn their place for code that is slow, non-deterministic, or reaches an
external service. Everywhere else they mostly test your own wiring.

## Duplication is cheaper than indirection in tests

Test code is read under pressure, usually while something is broken. A little
repetition that keeps each case readable on its own beats a helper the reader
must go find.

## Reproduce before you fix

For a bug, write the failing test first and watch it fail for the reported
reason. A fix without a red-first test is a guess that happens to end green.
