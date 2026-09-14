#!/usr/bin/env node
'use strict';

/**
 * validate-skills.js — walk skills/, lint every skill, print a report.
 *
 * Exit codes: 0 = clean (warnings allowed), 1 = at least one error.
 * An empty skills/ directory is not an error; it is the state this repo
 * starts in, and the notice below says so out loud rather than passing
 * silently and looking like a real check ran.
 */

const fs = require('node:fs');
const path = require('node:path');

const { lintSkill } = require('./lib/skill-lint');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`ERROR: skills directory not found at ${SKILLS_DIR}`);
    process.exit(1);
  }

  const skillDirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  if (skillDirs.length === 0) {
    console.log('No skills found in skills/ — nothing to validate yet.');
    console.log('Start one by copying templates/skill-template/ into skills/<your-skill-name>/.');
    process.exit(0);
  }

  let errorCount = 0;
  let warningCount = 0;

  for (const dirName of skillDirs) {
    const result = lintSkill(path.join(SKILLS_DIR, dirName), { repoRoot: REPO_ROOT });
    errorCount += result.errors.length;
    warningCount += result.warnings.length;

    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log(`  ok    ${dirName}`);
      continue;
    }
    console.log(`  ${result.errors.length ? 'FAIL' : 'warn'}  ${dirName}`);
    for (const message of result.errors) console.log(`          error: ${message}`);
    for (const message of result.warnings) console.log(`          warning: ${message}`);
  }

  console.log(
    `\n${skillDirs.length} skill(s) checked — ${errorCount} error(s), ${warningCount} warning(s)`
  );
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
