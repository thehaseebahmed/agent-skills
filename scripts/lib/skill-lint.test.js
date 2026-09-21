'use strict';

/**
 * Unit tests for the skill linter, run with `node --test scripts/`.
 *
 * Each invalid fixture asserts on the specific error it is meant to provoke,
 * not merely that "something failed" — otherwise a rule could break silently
 * while another rule kept the test green.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { lintSkill, parseFrontmatter, splitFrontmatter, headings, localLinks } = require('./skill-lint');

const FIXTURES = path.resolve(__dirname, '..', '__fixtures__');

/** Lint a fixture directory by name. */
function lintFixture(name) {
  return lintSkill(path.join(FIXTURES, name), { repoRoot: FIXTURES });
}

/** Assert that at least one error matches the given pattern. */
function assertError(result, pattern) {
  assert.ok(
    result.errors.some(message => pattern.test(message)),
    `expected an error matching ${pattern}, got: ${JSON.stringify(result.errors)}`
  );
}

test('a well-formed skill passes with no errors or warnings', () => {
  const result = lintFixture('valid-skill');
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.warnings, []);
});

test('frontmatter name must match the directory name', () => {
  assertError(lintFixture('name-mismatch'), /does not match directory name/);
});

test('a description without a trigger clause is rejected', () => {
  assertError(lintFixture('no-trigger'), /no trigger clause/);
});

test('a description over the character limit is rejected', () => {
  assertError(lintFixture('long-description'), /the limit is 1024/);
});

test('a missing required section is named in the error', () => {
  assertError(lintFixture('missing-section'), /Missing required section: ## Verification/);
});

test('a SKILL.md with no frontmatter is rejected', () => {
  assertError(lintFixture('missing-frontmatter'), /Missing YAML frontmatter/);
});

test('a relative link to a nonexistent file is reported', () => {
  assertError(lintFixture('broken-link'), /Broken link: '\.\.\/references\/does-not-exist\.md'/);
});

test('a directory name that is not kebab-case is rejected', () => {
  assertError(lintFixture('Bad_Name'), /is not kebab-case/);
});

test('a directory with no SKILL.md is rejected and stops early', () => {
  const result = lintFixture('no-skill-file');
  assert.deepStrictEqual(result.errors, ['Missing SKILL.md']);
});

test('splitFrontmatter tolerates CRLF line endings and a BOM', () => {
  const text = '﻿---\r\nname: x\r\n---\r\n\r\n# Body\r\n';
  const { raw, body } = splitFrontmatter(text);
  assert.match(raw, /name: x/);
  assert.match(body, /# Body/);
});

test('splitFrontmatter returns null when the block is never closed', () => {
  assert.strictEqual(splitFrontmatter('---\nname: x\n').raw, null);
});

test('parseFrontmatter strips quotes and reads block scalars', () => {
  const fields = parseFrontmatter('name: "quoted"\ndescription: >\n  first line\n  second line\n');
  assert.strictEqual(fields.name, 'quoted');
  assert.strictEqual(fields.description, 'first line second line');
});

test('headings ignore lines inside fenced code blocks', () => {
  const found = headings('## Real\n\n```sh\n## Not a heading\n```\n\n## Also Real\n');
  assert.deepStrictEqual(found, ['Real', 'Also Real']);
});

test('localLinks skips URLs and pure anchors', () => {
  const found = localLinks('[a](./x.md) [b](https://example.com) [c](#section) [d](../y.md)');
  assert.deepStrictEqual(found, ['./x.md', '../y.md']);
});
