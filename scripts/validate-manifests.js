#!/usr/bin/env node
'use strict';

/**
 * validate-manifests.js — keep the plugin manifests honest.
 *
 * This repo ships one plugin described five times, once per host format. The
 * failure this guards against is mundane and constant: a version bumped in one
 * manifest and forgotten in the other four, or a `skills`/`commands` path that
 * points at a directory nobody created.
 *
 * Exit codes: 0 = all manifests agree, 1 = a disagreement or a missing path.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Each entry: file, the dotted path to its version, and the dotted paths to
// any on-disk locations it declares.
const MANIFESTS = [
  { file: 'plugin.json', version: 'version', paths: [] },
  { file: '.claude-plugin/plugin.json', version: 'version', paths: ['skills', 'commands'] },
  { file: '.claude-plugin/marketplace.json', version: 'plugins.0.version', paths: [] },
  { file: '.codex-plugin/plugin.json', version: 'version', paths: ['skills'] },
  { file: '.agents/plugins/marketplace.json', version: 'plugins.0.version', paths: [] },
];

function dig(object, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

function main() {
  const errors = [];
  const versions = new Map();

  for (const manifest of MANIFESTS) {
    const fullPath = path.join(REPO_ROOT, manifest.file);

    if (!fs.existsSync(fullPath)) {
      errors.push(`${manifest.file}: missing`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (error) {
      errors.push(`${manifest.file}: invalid JSON — ${error.message}`);
      continue;
    }

    const version = dig(parsed, manifest.version);
    if (typeof version !== 'string') {
      errors.push(`${manifest.file}: no version string at '${manifest.version}'`);
    } else {
      versions.set(manifest.file, version);
    }

    for (const key of manifest.paths) {
      const declared = dig(parsed, key);
      if (declared === undefined) continue;
      for (const entry of Array.isArray(declared) ? declared : [declared]) {
        if (!fs.existsSync(path.resolve(REPO_ROOT, entry))) {
          errors.push(`${manifest.file}: '${key}' points at '${entry}', which does not exist`);
        }
      }
    }
  }

  const distinct = new Set(versions.values());
  if (distinct.size > 1) {
    errors.push(`Version mismatch across manifests: ${[...distinct].sort().join(', ')}`);
    for (const [file, version] of versions) errors.push(`  ${version}  ${file}`);
  }

  for (const [file, version] of versions) {
    console.log(`  ok    ${file} (${version})`);
  }

  if (errors.length > 0) {
    console.log('');
    for (const message of errors) console.error(`  error: ${message}`);
    process.exit(1);
  }

  console.log(`\n${versions.size} manifest(s) checked — all agree on version ${[...distinct][0]}`);
  process.exit(0);
}

main();
