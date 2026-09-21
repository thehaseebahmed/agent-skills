'use strict';

/**
 * skill-lint.js — the rule engine behind `validate-skills.js`.
 *
 * The rules implemented here are the contract documented in
 * docs/skill-anatomy.md. Keeping them in one importable module means the CLI
 * and the unit tests check the same thing, and there is exactly one place to
 * change when the contract changes.
 *
 * No third-party dependencies: Node builtins only.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_LINES = 500;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A description has to say when the skill applies, not only what it does —
// the trigger text is what decides whether an agent loads the skill at all.
const TRIGGER_PHRASE = /use when/i;

// Required sections, each with the alternative headings we accept for it.
// The first entry is the canonical name used in error messages.
const REQUIRED_SECTIONS = [
  ['Overview', 'Summary', 'What This Does'],
  ['When to Use', 'When To Use', 'Triggers'],
  ['Workflow', 'Process', 'Steps'],
  ['Failure Modes', 'Anti-Patterns', 'Red Flags'],
  ['Verification', 'Exit Criteria', 'Definition of Done'],
];

/**
 * Split a SKILL.md into its YAML frontmatter block and the body below it.
 * Returns { raw, body } where raw is null when no frontmatter is present.
 */
function splitFrontmatter(text) {
  // Tolerate a UTF-8 BOM and CRLF line endings; reject anything else that
  // puts content above the opening fence.
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { raw: null, body: normalized };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    return { raw: null, body: normalized };
  }
  const raw = normalized.slice(4, end + 1);
  const afterFence = normalized.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1);
  return { raw, body };
}

/**
 * Parse the small subset of YAML a SKILL.md frontmatter needs: top-level
 * `key: value` scalars, optionally quoted, plus block scalars (`|` and `>`).
 * Anything richer belongs in a supporting file, not in frontmatter.
 */
function parseFrontmatter(raw) {
  const fields = {};
  const lines = raw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rest] = match;
    const value = rest.trim();

    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      // Block scalar: consume the indented lines that follow.
      const collected = [];
      while (i + 1 < lines.length && (lines[i + 1].startsWith('  ') || !lines[i + 1].trim())) {
        collected.push(lines[++i].trim());
      }
      const joiner = value.startsWith('>') ? ' ' : '\n';
      fields[key] = collected.join(joiner).trim();
      continue;
    }

    fields[key] = value.replace(/^["'](.*)["']$/, '$1');
  }

  return fields;
}

/** Collect the `## Heading` lines from a SKILL.md body. */
function headings(body) {
  const found = [];
  // Skip fenced code blocks so a `## foo` inside a shell sample is not a heading.
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

/** Extract every local (non-URL, non-anchor) markdown link target in the body. */
function localLinks(body) {
  const targets = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, etc.
    if (target.startsWith('#')) continue; // same-document anchor
    targets.push(target);
  }
  return targets;
}

/**
 * Lint one skill directory.
 *
 * @param {string} skillDir Absolute path to the skill directory.
 * @param {object} [options]
 * @param {string} [options.repoRoot] Root used to resolve `/`-prefixed links.
 * @returns {{name: string, errors: string[], warnings: string[]}}
 */
function lintSkill(skillDir, options = {}) {
  const errors = [];
  const warnings = [];
  const dirName = path.basename(skillDir);
  const repoRoot = options.repoRoot || path.resolve(skillDir, '..', '..');

  if (!KEBAB_CASE.test(dirName)) {
    errors.push(`Directory name '${dirName}' is not kebab-case (lowercase words joined by hyphens)`);
  }

  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    errors.push('Missing SKILL.md');
    return { name: dirName, errors, warnings };
  }

  const text = fs.readFileSync(skillPath, 'utf8');
  const { raw, body } = splitFrontmatter(text);

  if (raw === null) {
    errors.push('Missing YAML frontmatter — SKILL.md must open with a --- fenced block');
    return { name: dirName, errors, warnings };
  }

  const fm = parseFrontmatter(raw);

  if (!fm.name) {
    errors.push("Frontmatter is missing the required field 'name'");
  } else if (fm.name !== dirName) {
    errors.push(`Frontmatter name '${fm.name}' does not match directory name '${dirName}'`);
  }

  if (!fm.description) {
    errors.push("Frontmatter is missing the required field 'description'");
  } else {
    if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push(
        `Description is ${fm.description.length} characters — the limit is ${MAX_DESCRIPTION_LENGTH}`
      );
    }
    if (!TRIGGER_PHRASE.test(fm.description)) {
      errors.push(
        "Description has no trigger clause — it must contain 'Use when …' so agents know when to load the skill"
      );
    }
  }

  const present = headings(body);
  for (const [canonical, ...aliases] of REQUIRED_SECTIONS) {
    const accepted = [canonical, ...aliases].map(h => h.toLowerCase());
    if (!present.some(h => accepted.includes(h.toLowerCase()))) {
      errors.push(`Missing required section: ## ${canonical}`);
    }
  }

  for (const target of localLinks(body)) {
    const [filePart] = target.split('#');
    if (!filePart) continue; // pure anchor after stripping
    const base = filePart.startsWith('/') ? repoRoot : skillDir;
    const resolved = path.resolve(base, filePart.replace(/^\//, ''));
    if (!fs.existsSync(resolved)) {
      errors.push(`Broken link: '${target}' does not resolve to a file`);
    }
  }

  const lineCount = body.split('\n').length;
  if (lineCount > MAX_SKILL_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines (over ${MAX_SKILL_LINES}) — consider moving detail into a supporting file`
    );
  }

  return { name: dirName, errors, warnings };
}

module.exports = {
  lintSkill,
  splitFrontmatter,
  parseFrontmatter,
  headings,
  localLinks,
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_LINES,
  REQUIRED_SECTIONS,
};
