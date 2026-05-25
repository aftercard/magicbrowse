import { redactSensitiveText } from '../redaction.js';

export const BROWSERBASE_API_URL = 'https://api.browserbase.com/v1';
export const BROWSERBASE_API_KEY_ENV_VAR = 'BROWSERBASE_API_KEY';
export const BROWSERBASE_PROJECT_ID_ENV_VAR = 'BROWSERBASE_PROJECT_ID';
export const BROWSERBASE_REGION_ENV_VAR = 'BROWSERBASE_REGION';
export const BROWSERBASE_TIMEOUT_ENV_VAR = 'BROWSERBASE_TIMEOUT';

export type BrowserbaseSessionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'ERROR'
  | 'TIMED_OUT'
  | 'COMPLETED';

export interface BrowserbaseSession {
  readonly id: string;
  readonly projectId?: string;
  readonly status: BrowserbaseSessionStatus;
  readonly keepAlive?: boolean;
  readonly region?: string;
  readonly connectUrl?: string;
}

export interface BrowserbaseClient {
  createSession(): Promise<BrowserbaseSession & { readonly connectUrl: string }>;
  getSession(sessionId: string): Promise<BrowserbaseSession>;
  releaseSession(input: {
    readonly sessionId: string;
    readonly projectId?: string;
  }): Promise<BrowserbaseSession>;
}

export interface BrowserbaseClientOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}

interface BrowserbaseConfig {
  readonly apiKey: string;
  readonly projectId?: string;
  readonly region?: string;
  readonly timeout?: number;
}

export function createBrowserbaseClient(options: BrowserbaseClientOptions = {}): BrowserbaseClient {
  const config = readBrowserbaseConfig(options.env ?? process.env);
  const fetchImpl = options.fetch ?? fetch;

  return {
    async createSession() {
      const browserSettings: Record<string, unknown> = {
        keepAlive: true,
      };
      if (config.region) {
        browserSettings.region = config.region;
      }
      if (config.timeout !== undefined) {
        browserSettings.timeout = config.timeout;
      }

      const createBody = {
        ...(config.projectId ? { projectId: config.projectId } : {}),
        keepAlive: true,
        ...(config.region ? { region: config.region } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
        browserSettings,
      };

      const session = normalizeBrowserbaseSession(
        await requestBrowserbaseJson(fetchImpl, config, '/sessions', {
          method: 'POST',
          body: createBody,
        }),
        { requireConnectUrl: true }
      );
      return requireConnectUrl(session);
    },
    async getSession(sessionId) {
      const normalizedSessionId = normalizeSessionId(sessionId);
      const session = normalizeBrowserbaseSession(
        await requestBrowserbaseJson(fetchImpl, config, `/sessions/${encodeURIComponent(normalizedSessionId)}`, {
          method: 'GET',
        }),
        { requireConnectUrl: false }
      );
      return session;
    },
    async releaseSession(input) {
      const sessionId = normalizeSessionId(input.sessionId);
      return normalizeBrowserbaseSession(
        await requestBrowserbaseJson(fetchImpl, config, `/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          body: {
            status: 'REQUEST_RELEASE',
            ...(input.projectId ?? config.projectId
              ? { projectId: input.projectId ?? config.projectId }
              : {}),
          },
        }),
        { requireConnectUrl: false }
      );
    },
  };
}

function readBrowserbaseConfig(env: NodeJS.ProcessEnv): BrowserbaseConfig {
  const apiKey = trimOrUndefined(env[BROWSERBASE_API_KEY_ENV_VAR]);
  if (!apiKey) {
    throw new Error(`${BROWSERBASE_API_KEY_ENV_VAR} is required for magicbrowse cloud sessions.`);
  }

  const timeout = readTimeout(env[BROWSERBASE_TIMEOUT_ENV_VAR]);

  return {
    apiKey,
    ...(trimOrUndefined(env[BROWSERBASE_PROJECT_ID_ENV_VAR])
      ? { projectId: trimOrUndefined(env[BROWSERBASE_PROJECT_ID_ENV_VAR]) }
      : {}),
    ...(trimOrUndefined(env[BROWSERBASE_REGION_ENV_VAR])
      ? { region: trimOrUndefined(env[BROWSERBASE_REGION_ENV_VAR]) }
      : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

async function requestBrowserbaseJson(
  fetchImpl: typeof fetch,
  config: BrowserbaseConfig,
  path: string,
  input: {
    readonly method: 'GET' | 'POST';
    readonly body?: Record<string, unknown>;
  }
): Promise<unknown> {
  const response = await fetchImpl(`${BROWSERBASE_API_URL}${path}`, {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      'X-BB-API-Key': config.apiKey,
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });

  if (!response.ok) {
    throw new Error(await browserbaseHttpError(response));
  }

  return response.json();
}

async function browserbaseHttpError(response: Response): Promise<string> {
  let details = '';
  try {
    details = redactSensitiveText((await response.text()).trim());
  } catch {
    details = '';
  }
  return `Browserbase API request failed with HTTP ${response.status}${details ? `: ${details}` : ''}`;
}

function normalizeBrowserbaseSession(
  value: unknown,
  options: { readonly requireConnectUrl: boolean }
): BrowserbaseSession {
  if (!isRecord(value)) {
    throw new Error('Browserbase API returned a malformed session payload.');
  }

  const id = readString(value.id);
  const status = normalizeStatus(value.status);
  const connectUrl = readString(value.connectUrl);
  if (!id || !status || (options.requireConnectUrl && !connectUrl)) {
    throw new Error('Browserbase API returned a malformed session payload.');
  }

  return {
    id,
    status,
    ...(readString(value.projectId) ? { projectId: readString(value.projectId) } : {}),
    ...(typeof value.keepAlive === 'boolean' ? { keepAlive: value.keepAlive } : {}),
    ...(readString(value.region) ? { region: readString(value.region) } : {}),
    ...(connectUrl ? { connectUrl } : {}),
  };
}

function requireConnectUrl(
  session: BrowserbaseSession
): BrowserbaseSession & { readonly connectUrl: string } {
  if (!session.connectUrl) {
    throw new Error('Browserbase API returned a malformed session payload.');
  }
  return {
    ...session,
    connectUrl: session.connectUrl,
  };
}

function normalizeStatus(value: unknown): BrowserbaseSessionStatus | undefined {
  return value === 'PENDING' ||
    value === 'RUNNING' ||
    value === 'ERROR' ||
    value === 'TIMED_OUT' ||
    value === 'COMPLETED'
    ? value
    : undefined;
}

function normalizeSessionId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Browserbase session id must not be empty.');
  }
  return normalized;
}

function readTimeout(value: string | undefined): number | undefined {
  const trimmed = trimOrUndefined(value);
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 21600) {
    throw new Error(`${BROWSERBASE_TIMEOUT_ENV_VAR} must be an integer number of seconds from 60 to 21600.`);
  }
  return parsed;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
