#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, '..');
const npmCacheDir = path.join(os.tmpdir(), 'magicbrowse-npm-cache');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, cwd = packageDir) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir,
      npm_config_loglevel: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extractPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to parse npm pack --json output.');
  }

  return JSON.parse(stdout.slice(start, end + 1));
}

function findWorkspaceProtocolInstallDeps(manifest) {
  const violations = [];

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = manifest[field];
    if (!deps) {
      continue;
    }

    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        violations.push(`${field}.${name}=${spec}`);
      }
    }
  }

  return violations;
}

run('npm', ['run', 'build']);

const rawOutput = run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json']);
const packResult = extractPackJson(rawOutput)?.[0];

assert(packResult, 'npm pack did not return pack metadata.');

const files = packResult.files.map((entry) => entry.path);
const packedManifest = JSON.parse(
  fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
);
const unexpectedFiles = files.filter(
  (filePath) =>
    filePath.startsWith('src/') ||
    filePath.startsWith('docs-internal/') ||
    filePath.startsWith('scripts/') ||
    filePath.includes('.test.') ||
    filePath.includes('.test-utils.') ||
    filePath.includes('__tests__')
);
const workspaceProtocolInstallDeps = findWorkspaceProtocolInstallDeps(packedManifest);

assert(files.includes('package.json'), 'Packed artifact is missing package.json.');
assert(files.includes('README.md'), 'Packed artifact is missing README.md.');
assert(files.includes('LICENSE'), 'Packed artifact is missing LICENSE.');
assert(
  files.includes('THIRD_PARTY_NOTICES.md'),
  'Packed artifact is missing THIRD_PARTY_NOTICES.md.'
);
assert(files.includes('dist/index.js'), 'Packed artifact is missing dist/index.js.');
assert(files.includes('dist/index.d.ts'), 'Packed artifact is missing dist/index.d.ts.');
assert(
  files.includes('dist/vendor/buildDomTree.js'),
  'Packed artifact is missing dist/vendor/buildDomTree.js.'
);
assert(
  files.includes('dist/vendor/NANOBROWSER_SHA'),
  'Packed artifact is missing dist/vendor/NANOBROWSER_SHA.'
);
assert(
  files.includes('dist/adapter/i18n/locales/en/messages.json'),
  'Packed artifact is missing English locale messages.'
);
assert(
  unexpectedFiles.length === 0,
  `Packed artifact contains source/test/internal files: ${unexpectedFiles.join(', ')}`
);
assert(
  workspaceProtocolInstallDeps.length === 0,
  `Packed artifact contains workspace install dependencies: ${workspaceProtocolInstallDeps.join(', ')}`
);

process.stdout.write(
  `Verified ${packResult.filename}: ${files.length} files, no source/test/internal files or workspace install dependencies.\n`
);
