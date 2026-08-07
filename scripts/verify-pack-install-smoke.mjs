#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, '..');
const npmCacheDir = path.join(os.tmpdir(), 'magicbrowse-npm-cache');

function extractPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to parse npm pack --json output.');
  }

  return JSON.parse(stdout.slice(start, end + 1));
}

function run(command, args, cwd, envOverrides = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envOverrides,
      npm_config_cache: npmCacheDir,
      npm_config_loglevel: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let tgzPath = null;
let tempDir = null;

try {
  run('npm', ['run', 'build'], packageDir);

  const packOutput = run('npm', ['pack', '--ignore-scripts', '--json', '--silent'], packageDir);
  const packResult = extractPackJson(packOutput)?.[0];

  if (!packResult?.filename) {
    throw new Error('npm pack did not return a tarball filename.');
  }

  tgzPath = path.join(packageDir, packResult.filename);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magicbrowse-pack-install-'));
  const consumerDir = path.join(tempDir, 'consumer');
  fs.mkdirSync(consumerDir, { recursive: true });

  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'magicbrowse-pack-install-smoke',
        private: true,
        type: 'module',
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(consumerDir, 'smoke.mjs'),
    `import {
  createDirectLlmAdapter,
  listDirectLlmProviderFamilies,
  redactSensitiveText,
  resolveMagicBrowseHome,
  status,
} from '@aftercard/magicbrowse';

const home = resolveMagicBrowseHome({ env: {}, homeDir: process.env.HOME });
if (!home.endsWith('/.magicbrowse')) {
  throw new Error('Unexpected MagicBrowse home dir: ' + home);
}

const providers = listDirectLlmProviderFamilies();
if (!providers.includes('openai') || !providers.includes('openrouter')) {
  throw new Error('Direct LLM provider registry is incomplete.');
}

const redacted = redactSensitiveText('token=raw-token password: raw-password');
if (redacted.includes('raw-token') || redacted.includes('raw-password')) {
  throw new Error('Sensitive text redaction failed.');
}

const adapter = createDirectLlmAdapter({
  provider: 'ollama',
  navigatorModel: 'llama3.2',
  plannerModel: 'llama3.2',
});
if (!adapter || typeof adapter.createModel !== 'function') {
  throw new Error('Direct LLM adapter shape changed.');
}

const current = await status();
if (current.alive !== false || current.outcomeType !== 'browser_not_running') {
  throw new Error('Fresh consumer should not have a current session: ' + JSON.stringify(current));
}
`,
    'utf8'
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgzPath], consumerDir);
  const homeDir = path.join(tempDir, 'home');
  const magicBrowseHomeDir = path.join(tempDir, 'magicbrowse-home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(magicBrowseHomeDir, { recursive: true });
  run('node', ['smoke.mjs'], consumerDir, {
    HOME: homeDir,
    MAGICBROWSE_HOME: magicBrowseHomeDir,
  });

  process.stdout.write(`Verified install/import smoke for ${packResult.filename}.\n`);
} finally {
  if (tgzPath && fs.existsSync(tgzPath)) {
    fs.rmSync(tgzPath, { force: true });
  }

  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}
