import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  MagicBrowseProfileInfo,
  MagicBrowseProxyConfig,
  MagicBrowseProxySetting,
  MagicBrowseViewport,
} from '../types.js';
import { resolveMagicBrowseHome } from './session-store.js';

export interface OwnedBrowserLaunchInput {
  readonly sessionId: string;
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly args?: readonly string[];
  readonly viewport?: MagicBrowseViewport;
  readonly userAgent?: string;
  readonly proxy?: MagicBrowseProxySetting;
  readonly profile?: string;
  readonly userDataDir?: string;
}

export interface OwnedBrowserLaunchResult {
  readonly sessionId: string;
  readonly cdpUrl: string;
  readonly pid: number;
  readonly profile: MagicBrowseProfileInfo;
}

export interface OwnedBrowserCloseInput {
  readonly cdpUrl?: string;
  readonly pid?: number;
}

export interface OwnedBrowserLauncher {
  launch(input: OwnedBrowserLaunchInput): Promise<OwnedBrowserLaunchResult>;
  close(input: OwnedBrowserCloseInput): Promise<void>;
}

export interface DetachedChromeBrowserLauncherOptions {
  readonly magicBrowseHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly spawnProcess?: SpawnChromeProcess;
  readonly killProcess?: KillProcess;
  readonly readChromeVersion?: ReadChromeVersion;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly pathExists?: (path: string) => boolean;
  readonly readTextFile?: (path: string) => string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly discoveryTimeoutMs?: number;
  readonly discoveryIntervalMs?: number;
  readonly closeGraceMs?: number;
}

type RunningChromeProcess = ChildProcess & { readonly pid: number };
type SpawnChromeProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;
type KillProcess = (pid: number, signal?: NodeJS.Signals | 0) => boolean;
type ReadChromeVersion = (executablePath: string) => string;
type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  json(): Promise<unknown>;
}>;

const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 250;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const TERM_WAIT_ATTEMPTS = 10;
const TERM_WAIT_MS = 100;
const KILL_WAIT_ATTEMPTS = 5;
const KILL_WAIT_MS = 20;
const BROWSER_PROFILES_DIRNAME = 'browser-profiles';
const RESERVED_CHROME_ARG_PREFIXES = [
  '--remote-debugging-port=',
  '--remote-debugging-address=',
  '--user-data-dir=',
  '--user-agent=',
  '--proxy-server=',
  '--headless',
];
const DARWIN_CHROME_ARGS = ['--use-mock-keychain'];
const LINUX_CI_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

export function createDetachedChromeBrowserLauncher(
  options: DetachedChromeBrowserLauncherOptions = {}
): OwnedBrowserLauncher {
  const pathExists = options.pathExists ?? existsSync;
  const readTextFile =
    options.readTextFile ?? ((filePath: string) => readFileSync(filePath, 'utf-8'));
  const spawnProcess = options.spawnProcess ?? spawn;
  const killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const readChromeVersion = options.readChromeVersion ?? readChromeVersionFromExecutable;
  const fetchImpl = options.fetch ?? ((url: string) => fetch(url));
  const sleepImpl = options.sleep ?? sleep;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const discoveryIntervalMs = options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  return {
    async launch(input) {
      const executablePath = resolveChromeExecutablePath(input.executablePath, env, pathExists);
      const userAgent = resolveOwnedChromeUserAgent({
        executablePath,
        explicitUserAgent: input.userAgent,
        readChromeVersion,
        platform,
        arch,
      });
      const profileName = input.profile?.trim() || input.sessionId;
      const userDataDir =
        input.userDataDir ??
        join(
          options.magicBrowseHome ?? resolveMagicBrowseHome({ env, homeDir: options.homeDir }),
          BROWSER_PROFILES_DIRNAME,
          encodeURIComponent(profileName),
          'user-data'
        );
      const chromeProcess = spawnChromeProcess({
        executablePath,
        userDataDir,
        headless: input.headless,
        args: input.args,
        viewport: input.viewport,
        userAgent,
        proxy: normalizeProxySetting(input.proxy),
        env,
        platform,
        spawnProcess,
      });

      try {
        const cdpUrl = await discoverCdpEndpoint({
          userDataDir,
          chromeProcess,
          pathExists,
          readTextFile,
          fetch: fetchImpl,
          sleep: sleepImpl,
          timeoutMs: discoveryTimeoutMs,
          intervalMs: discoveryIntervalMs,
        });

        if (!cdpUrl) {
          throw buildCdpDiscoveryError(chromeProcess, userDataDir, discoveryTimeoutMs);
        }

        return {
          sessionId: input.sessionId,
          cdpUrl,
          pid: chromeProcess.pid,
          profile: {
            name: profileName,
            userDataDir,
          },
        };
      } catch (error) {
        await terminateOwnedPid(chromeProcess.pid, killProcess, sleepImpl);
        throw error;
      }
    },
    async close(input) {
      if (
        input.cdpUrl &&
        !input.pid &&
        (await waitForEndpointGone(input.cdpUrl, fetchImpl, sleepImpl, closeGraceMs))
      ) {
        return;
      }

      const termination = await terminateOwnedPid(input.pid, killProcess, sleepImpl);

      if (
        input.cdpUrl &&
        !(await waitForEndpointGone(input.cdpUrl, fetchImpl, sleepImpl, closeGraceMs))
      ) {
        const port = readPortFromEndpoint(input.cdpUrl);
        throw new Error(
          `Owned browser endpoint${port ? ` on port ${port}` : ''} remained reachable after close attempts (termination=${termination}).`
        );
      }
    },
  };
}

export function resolveChromeExecutablePath(
  explicitPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync
): string {
  if (explicitPath) {
    if (!pathExists(explicitPath)) {
      throw new Error(`Chrome executable does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }

  if (env.MAGICBROWSE_CHROME_PATH && pathExists(env.MAGICBROWSE_CHROME_PATH)) {
    return env.MAGICBROWSE_CHROME_PATH;
  }

  if (env.CHROME_PATH && pathExists(env.CHROME_PATH)) {
    return env.CHROME_PATH;
  }

  const resolved = CHROME_PATHS.find((candidate) => pathExists(candidate));
  if (resolved) {
    return resolved;
  }

  throw new Error(
    `Chrome executable not found. Set MAGICBROWSE_CHROME_PATH or CHROME_PATH. Checked: ${CHROME_PATHS.join(', ')}`
  );
}

function spawnChromeProcess(input: {
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly headless?: boolean;
  readonly args?: readonly string[];
  readonly viewport?: MagicBrowseViewport;
  readonly userAgent?: string;
  readonly proxy?: MagicBrowseProxyConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly spawnProcess: SpawnChromeProcess;
}): RunningChromeProcess {
  mkdirSync(input.userDataDir, { recursive: true });

  const width = Math.max(800, Math.floor(input.viewport?.width ?? 1280));
  const height = Math.max(600, Math.floor(input.viewport?.height ?? 900));
  const chromeArgs = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${input.userDataDir}`,
    `--window-size=${width},${height}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    ...chromeArgsForEnvironment(input.platform, input.env),
    ...filterUserChromeArgs(input.args ?? []),
  ];

  if (typeof input.userAgent === 'string') {
    chromeArgs.push(`--user-agent=${input.userAgent}`);
  }

  if (input.proxy?.server) {
    chromeArgs.push(`--proxy-server=${input.proxy.server}`);
  }

  if (input.headless !== false) {
    chromeArgs.push('--headless=new');
  }

  const chromeProcess = input.spawnProcess(input.executablePath, chromeArgs, {
    stdio: 'ignore',
    detached: true,
    env: input.env,
    cwd: homedir(),
  });

  chromeProcess.unref();

  if (!chromeProcess.pid) {
    throw new Error('Failed to launch Chrome process.');
  }

  return chromeProcess as RunningChromeProcess;
}

export function normalizeProxySetting(
  value: MagicBrowseProxySetting | undefined
): MagicBrowseProxyConfig | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value !== 'string') {
    return {
      server: stripProxyCredentials(value.server),
      ...(value.username ? { username: value.username } : {}),
      ...(value.password ? { password: value.password } : {}),
    };
  }

  const parsed = parseProxyUrl(value);
  return {
    server: parsed.server,
    ...(parsed.username ? { username: parsed.username } : {}),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

export function chromeArgsForEnvironment(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  if (platform === 'darwin') {
    return [...DARWIN_CHROME_ARGS];
  }

  const isLinuxCi = platform === 'linux' && (env.CI === 'true' || env.GITHUB_ACTIONS === 'true');
  return isLinuxCi ? [...LINUX_CI_CHROME_ARGS] : [];
}

function resolveOwnedChromeUserAgent(input: {
  readonly executablePath: string;
  readonly explicitUserAgent?: string;
  readonly readChromeVersion: ReadChromeVersion;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}): string {
  if (typeof input.explicitUserAgent === 'string') {
    return input.explicitUserAgent;
  }

  const platformToken = resolveDesktopChromeUserAgentPlatformToken(input.platform, input.arch);
  if (!platformToken) {
    throw new Error(
      `Unable to generate default Chrome user agent for owned browser launch. Unsupported platform/architecture for desktop Chrome UA: ${input.platform}/${input.arch}. Pass userAgent explicitly to override.`
    );
  }

  let versionOutput: string;
  try {
    versionOutput = input.readChromeVersion(input.executablePath).trim();
  } catch (error) {
    throw new Error(
      `Unable to generate default Chrome user agent for owned browser launch. Failed to read Chrome version from ${input.executablePath} --version: ${readErrorMessage(error)}. Pass userAgent explicitly to override.`
    );
  }

  const majorVersion = parseChromeMajorVersion(versionOutput);
  if (!majorVersion) {
    throw new Error(
      `Unable to generate default Chrome user agent for owned browser launch. Could not parse Chrome major version from ${input.executablePath} --version output: ${JSON.stringify(versionOutput)}. Pass userAgent explicitly to override.`
    );
  }

  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
}

function parseChromeMajorVersion(versionOutput: string): number | undefined {
  const match = versionOutput.match(/\b(\d+)(?:\.\d+){1,3}\b/);
  const major = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(major) && major > 0 ? major : undefined;
}

function resolveDesktopChromeUserAgentPlatformToken(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string | undefined {
  if (platform === 'darwin') {
    return 'Macintosh; Intel Mac OS X 10_15_7';
  }

  if (platform === 'linux') {
    if (arch === 'x64') {
      return 'X11; Linux x86_64';
    }
    if (arch === 'arm64') {
      return 'X11; Linux aarch64';
    }
    return undefined;
  }

  if (platform === 'win32') {
    return 'Windows NT 10.0; Win64; x64';
  }

  return undefined;
}

function readChromeVersionFromExecutable(executablePath: string): string {
  return execFileSync(executablePath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function filterUserChromeArgs(args: readonly string[]): string[] {
  const filtered: string[] = [];
  const seen = new Set<string>();

  for (const arg of args) {
    if (!arg || RESERVED_CHROME_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }

    if (!seen.has(arg)) {
      seen.add(arg);
      filtered.push(arg);
    }
  }

  return filtered;
}

function parseProxyUrl(value: string): MagicBrowseProxyConfig {
  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    url.username = '';
    url.password = '';
    return {
      server: url.toString().replace(/\/$/, ''),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    return { server: value };
  }
}

function stripProxyCredentials(server: string): string {
  try {
    const url = new URL(server);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return server;
  }
}

async function discoverCdpEndpoint(input: {
  readonly userDataDir: string;
  readonly chromeProcess: ChildProcess;
  readonly pathExists: (path: string) => boolean;
  readonly readTextFile: (path: string) => string;
  readonly fetch: FetchLike;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Promise<string | null> {
  const activePortPath = join(input.userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    const activePort = readDevToolsActivePort({
      activePortPath,
      pathExists: input.pathExists,
      readTextFile: input.readTextFile,
    });
    const endpoint = await discoverCdpEndpointFromActivePort(activePort, input.fetch);

    if (endpoint) {
      return endpoint;
    }

    if (typeof input.chromeProcess.exitCode === 'number' || input.chromeProcess.signalCode) {
      break;
    }

    await input.sleep(input.intervalMs);
  }

  return null;
}

function readDevToolsActivePort(input: {
  readonly activePortPath: string;
  readonly pathExists: (path: string) => boolean;
  readonly readTextFile: (path: string) => string;
}): { readonly port: number; readonly browserWSEndpoint?: string } | null {
  if (!input.pathExists(input.activePortPath)) {
    return null;
  }

  try {
    const raw = input.readTextFile(input.activePortPath).trim();
    const [portLine = '', wsPathLine = ''] = raw.split(/\r?\n/, 2);
    const port = Number(portLine.trim());

    if (!Number.isFinite(port) || port <= 0) {
      return null;
    }

    const wsPath = wsPathLine.trim();
    return {
      port,
      browserWSEndpoint: wsPath
        ? wsPath.startsWith('ws://') || wsPath.startsWith('wss://')
          ? wsPath
          : `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`
        : undefined,
    };
  } catch {
    return null;
  }
}

async function discoverCdpEndpointFromActivePort(
  activePort: ReturnType<typeof readDevToolsActivePort>,
  fetchImpl: FetchLike
): Promise<string | null> {
  if (!activePort) {
    return null;
  }

  const candidatePorts = new Set<number>([activePort.port]);
  const endpointPort = activePort.browserWSEndpoint
    ? readPortFromEndpoint(activePort.browserWSEndpoint)
    : undefined;

  if (endpointPort) {
    candidatePorts.add(endpointPort);
  }

  for (const port of candidatePorts) {
    const endpoint = await discoverCdpEndpointOnPort(port, fetchImpl);
    if (endpoint) {
      return endpoint;
    }
  }

  return null;
}

async function discoverCdpEndpointOnPort(
  port: number,
  fetchImpl: FetchLike
): Promise<string | null> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const endpoint = isRecord(payload) ? payload.webSocketDebuggerUrl : undefined;
    return typeof endpoint === 'string' && endpoint.trim().length > 0 ? endpoint : null;
  } catch {
    return null;
  }
}

function buildCdpDiscoveryError(
  chromeProcess: ChildProcess,
  userDataDir: string,
  timeoutMs: number
): Error {
  const details = [`pid ${chromeProcess.pid ?? 'unknown'}`];

  if (typeof chromeProcess.exitCode === 'number') {
    details.push(`exitCode ${chromeProcess.exitCode}`);
  }

  if (chromeProcess.signalCode) {
    details.push(`signal ${chromeProcess.signalCode}`);
  }

  return new Error(
    `Chrome launched but CDP was not reachable via DevToolsActivePort within ${timeoutMs}ms (${details.join(', ')}). Checked ${join(userDataDir, 'DevToolsActivePort')}.`
  );
}

async function waitForEndpointGone(
  endpoint: string,
  fetchImpl: FetchLike,
  sleepImpl: (ms: number) => Promise<void>,
  timeoutMs: number
): Promise<boolean> {
  const port = readPortFromEndpoint(endpoint);

  if (!port) {
    return false;
  }

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isDevToolsEndpointReachable(port, fetchImpl))) {
      return true;
    }

    await sleepImpl(50);
  }

  return !(await isDevToolsEndpointReachable(port, fetchImpl));
}

async function isDevToolsEndpointReachable(port: number, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function readPortFromEndpoint(endpoint: string): number | undefined {
  try {
    const parsed = new URL(endpoint);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

type OwnedPidTerminationResult = 'not_found' | 'terminated' | 'sigkilled' | 'still_alive';

async function terminateOwnedPid(
  pid: number | undefined,
  killProcess: KillProcess,
  sleepImpl: (ms: number) => Promise<void>
): Promise<OwnedPidTerminationResult> {
  if (!pid) {
    return 'not_found';
  }

  const processGroupTermination = await terminateSignalTarget(-pid, pid, killProcess, sleepImpl);

  if (processGroupTermination !== 'not_found') {
    return processGroupTermination;
  }

  return terminateSignalTarget(pid, pid, killProcess, sleepImpl);
}

async function terminateSignalTarget(
  target: number,
  pid: number,
  killProcess: KillProcess,
  sleepImpl: (ms: number) => Promise<void>
): Promise<OwnedPidTerminationResult> {
  try {
    killProcess(target, 'SIGTERM');
  } catch (error) {
    const code = getErrorCode(error);

    if (target < 0 && code === 'ESRCH' && isProcessAlive(pid, killProcess)) {
      return 'not_found';
    }

    return isProcessAlive(pid, killProcess) ? 'still_alive' : 'not_found';
  }

  if (await waitForPidExit(pid, TERM_WAIT_ATTEMPTS, TERM_WAIT_MS, killProcess, sleepImpl)) {
    return 'terminated';
  }

  try {
    killProcess(target, 'SIGKILL');
  } catch {
    return isProcessAlive(pid, killProcess) ? 'still_alive' : 'sigkilled';
  }

  if (await waitForPidExit(pid, KILL_WAIT_ATTEMPTS, KILL_WAIT_MS, killProcess, sleepImpl)) {
    return 'sigkilled';
  }

  return 'still_alive';
}

async function waitForPidExit(
  pid: number,
  attempts: number,
  intervalMs: number,
  killProcess: KillProcess,
  sleepImpl: (ms: number) => Promise<void>
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isProcessAlive(pid, killProcess)) {
      return true;
    }

    await sleepImpl(intervalMs);
  }

  return !isProcessAlive(pid, killProcess);
}

function isProcessAlive(pid: number, killProcess: KillProcess): boolean {
  try {
    killProcess(pid, 0);
    return true;
  } catch (error) {
    const code = getErrorCode(error);

    if (code === 'EPERM') {
      return true;
    }

    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
