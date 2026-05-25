import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type {
  MagicBrowseActivePageIdentity,
  MagicBrowseCloudProviderMetadata,
  MagicBrowseHumanVerificationResolvedMarker,
  MagicBrowseProfileInfo,
  MagicBrowseProxyConfig,
  MagicBrowseSessionOwnership,
  MagicBrowseViewport,
} from '../types.js';
import {
  mergeProtectedRedactionProfiles,
  normalizeProtectedRedactionProfiles,
  type ProtectedRedactionProfiles,
} from '../redaction.js';
import { parseBrowserInstanceRef } from './attach-endpoint.js';

export const MAGICBROWSE_HOME_ENV_VAR = 'MAGICBROWSE_HOME';
export const DEFAULT_MAGICBROWSE_HOME_DIRNAME = '.magicbrowse';
export const CURRENT_SESSION_FILENAME = 'current-session.json';
export const MAGICBROWSE_SESSION_SCHEMA_VERSION = 1 as const;

export interface ResolveMagicBrowseHomeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

export interface PersistedMagicBrowseSession {
  readonly version: typeof MAGICBROWSE_SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly runId?: string;
  readonly ownership: MagicBrowseSessionOwnership;
  readonly cdpUrl: string;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly browserInstanceRef?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pid?: number;
  readonly profile?: MagicBrowseProfileInfo;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly humanVerificationResolved?: MagicBrowseHumanVerificationResolvedMarker;
  readonly headless?: boolean;
  readonly viewport?: MagicBrowseViewport;
  readonly userAgent?: string;
  readonly proxy?: MagicBrowseProxyConfig;
  readonly stealth?: boolean;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
  readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference;
}

export interface MagicBrowseLocalCdpConnectPreference {
  readonly strategy: 'without_initial_target_wait';
  readonly reason: 'public_connect_timeout';
  readonly recoveredAt: string;
}

export interface MagicBrowseSessionStore {
  readonly currentSessionPath: string;
  loadCurrentSession(): Promise<PersistedMagicBrowseSession | undefined>;
  saveCurrentSession(session: PersistedMagicBrowseSession): Promise<void>;
  clearCurrentSession(sessionId?: string): Promise<void>;
}

export interface FileMagicBrowseSessionStoreOptions extends ResolveMagicBrowseHomeOptions {
  readonly rootDir?: string;
}

export function resolveMagicBrowseHome(options: ResolveMagicBrowseHomeOptions = {}): string {
  const configuredHome = (options.env ?? process.env)[MAGICBROWSE_HOME_ENV_VAR]?.trim();

  if (configuredHome) {
    return resolve(configuredHome);
  }

  return join(options.homeDir ?? homedir(), DEFAULT_MAGICBROWSE_HOME_DIRNAME);
}

export function createFileMagicBrowseSessionStore(
  options: FileMagicBrowseSessionStoreOptions = {}
): MagicBrowseSessionStore {
  const rootDir = resolve(options.rootDir ?? resolveMagicBrowseHome(options));
  const currentSessionPath = join(rootDir, CURRENT_SESSION_FILENAME);

  return {
    currentSessionPath,
    async loadCurrentSession() {
      let raw: string;
      try {
        raw = await readFile(currentSessionPath, 'utf8');
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT') {
          return undefined;
        }
        throw error;
      }

      return normalizePersistedMagicBrowseSession(JSON.parse(raw));
    },
    async saveCurrentSession(session) {
      await mkdir(dirname(currentSessionPath), { recursive: true });
      await writeFile(currentSessionPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    },
    async clearCurrentSession(sessionId) {
      if (!sessionId) {
        await rm(currentSessionPath, { force: true });
        return;
      }

      const current = await this.loadCurrentSession();
      if (!current || current.id === sessionId) {
        await rm(currentSessionPath, { force: true });
      }
    },
  };
}

export function createPersistedMagicBrowseSession(input: {
  readonly id: string;
  readonly runId?: string;
  readonly ownership: MagicBrowseSessionOwnership;
  readonly cdpUrl: string;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly pid?: number;
  readonly profile?: MagicBrowseProfileInfo;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly humanVerificationResolved?: MagicBrowseHumanVerificationResolvedMarker;
  readonly headless?: boolean;
  readonly viewport?: MagicBrowseViewport;
  readonly userAgent?: string;
  readonly proxy?: MagicBrowseProxyConfig;
  readonly stealth?: boolean;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
  readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference;
  readonly now?: string;
}): PersistedMagicBrowseSession {
  const now = input.now ?? new Date().toISOString();
  const activePageIdentity = normalizeActivePageIdentity(input.activePageIdentity);
  const localCdpConnectPreference = normalizeLocalCdpConnectPreference(
    input.localCdpConnectPreference
  );
  const browserInstanceRef = parseBrowserInstanceRef(input.cdpUrl);

  return {
    version: MAGICBROWSE_SESSION_SCHEMA_VERSION,
    id: input.id,
    ...(input.runId ? { runId: input.runId } : {}),
    ownership: input.ownership,
    cdpUrl: input.cdpUrl,
    ...(input.cloudProvider ? { cloudProvider: input.cloudProvider } : {}),
    ...(browserInstanceRef ? { browserInstanceRef } : {}),
    createdAt: now,
    updatedAt: now,
    ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(activePageIdentity ? { activePageIdentity } : {}),
    ...(input.humanVerificationResolved
      ? { humanVerificationResolved: input.humanVerificationResolved }
      : {}),
    ...(typeof input.headless === 'boolean' ? { headless: input.headless } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    ...(input.proxy ? { proxy: input.proxy } : {}),
    ...(typeof input.stealth === 'boolean' ? { stealth: input.stealth } : {}),
    ...(input.protectedRedactionProfiles
      ? { protectedRedactionProfiles: input.protectedRedactionProfiles }
      : {}),
    ...(localCdpConnectPreference ? { localCdpConnectPreference } : {}),
  };
}

export function touchPersistedMagicBrowseSession(
  session: PersistedMagicBrowseSession,
  input: {
    readonly activePageIdentity?: MagicBrowseActivePageIdentity;
    readonly runId?: string;
    readonly humanVerificationResolved?: MagicBrowseHumanVerificationResolvedMarker | null;
    readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
    readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference | null;
    readonly now?: string;
  } = {}
): PersistedMagicBrowseSession {
  const activePageIdentity = normalizeActivePageIdentity(input.activePageIdentity);
  const localCdpConnectPreference = normalizeLocalCdpConnectPreference(
    input.localCdpConnectPreference
  );
  let next: PersistedMagicBrowseSession = {
    ...session,
    updatedAt: input.now ?? new Date().toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(activePageIdentity ? { activePageIdentity } : {}),
    ...(input.protectedRedactionProfiles
      ? {
          protectedRedactionProfiles: mergeProtectedRedactionProfiles(
            session.protectedRedactionProfiles,
            input.protectedRedactionProfiles
          ),
        }
      : {}),
  };

  if (input.localCdpConnectPreference !== undefined) {
    if (localCdpConnectPreference) {
      next = {
        ...next,
        localCdpConnectPreference,
      };
    } else {
      const { localCdpConnectPreference: _removed, ...withoutPreference } = next;
      next = withoutPreference;
    }
  }

  if (input.humanVerificationResolved !== undefined) {
    const marker = normalizeHumanVerificationResolvedMarker(input.humanVerificationResolved);
    if (marker) {
      return {
        ...next,
        humanVerificationResolved: marker,
      };
    }
    const { humanVerificationResolved: _removed, ...withoutMarker } = next;
    return withoutMarker;
  }

  return next;
}

export function normalizePersistedMagicBrowseSession(value: unknown): PersistedMagicBrowseSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value.id);
  const runId = readString(value.runId);
  const ownership = value.ownership;
  const cdpUrl = readString(value.cdpUrl);
  const cloudProvider = normalizeCloudProvider(value.cloudProvider);
  const browserInstanceRef = readString(value.browserInstanceRef) ?? parseBrowserInstanceRef(cdpUrl ?? '');
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const pid = readPositiveNumber(value.pid);
  const profile = normalizeProfileInfo(value.profile);
  const activePageIdentity = normalizeActivePageIdentity(value.activePageIdentity);
  const humanVerificationResolved = normalizeHumanVerificationResolvedMarker(
    value.humanVerificationResolved
  );
  const viewport = normalizeViewport(value.viewport);
  const userAgent = readString(value.userAgent);
  const proxy = normalizeProxyConfig(value.proxy);
  const protectedRedactionProfiles = normalizeProtectedRedactionProfiles(
    value.protectedRedactionProfiles
  );
  const localCdpConnectPreference = normalizeLocalCdpConnectPreference(
    value.localCdpConnectPreference
  );

  if (
    value.version !== MAGICBROWSE_SESSION_SCHEMA_VERSION ||
    !id ||
    (ownership !== 'owned' && ownership !== 'attached') ||
    !cdpUrl ||
    !createdAt ||
    !updatedAt ||
    (value.profile !== undefined && !profile) ||
    (value.activePageIdentity !== undefined && !activePageIdentity) ||
    (value.humanVerificationResolved !== undefined && !humanVerificationResolved) ||
    (value.cloudProvider !== undefined && !cloudProvider) ||
    (value.viewport !== undefined && !viewport) ||
    (value.proxy !== undefined && !proxy)
  ) {
    return undefined;
  }

  return {
    version: MAGICBROWSE_SESSION_SCHEMA_VERSION,
    id,
    ...(runId ? { runId } : {}),
    ownership,
    cdpUrl,
    ...(cloudProvider ? { cloudProvider } : {}),
    ...(browserInstanceRef ? { browserInstanceRef } : {}),
    createdAt,
    updatedAt,
    ...(pid ? { pid } : {}),
    ...(profile ? { profile } : {}),
    ...(activePageIdentity ? { activePageIdentity } : {}),
    ...(humanVerificationResolved ? { humanVerificationResolved } : {}),
    ...(typeof value.headless === 'boolean' ? { headless: value.headless } : {}),
    ...(viewport ? { viewport } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(proxy ? { proxy } : {}),
    ...(typeof value.stealth === 'boolean' ? { stealth: value.stealth } : {}),
    ...(protectedRedactionProfiles ? { protectedRedactionProfiles } : {}),
    ...(localCdpConnectPreference ? { localCdpConnectPreference } : {}),
  };
}

function normalizeLocalCdpConnectPreference(
  value: unknown
): MagicBrowseLocalCdpConnectPreference | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const recoveredAt = readValidDateString(value.recoveredAt);
  if (
    value.strategy !== 'without_initial_target_wait' ||
    value.reason !== 'public_connect_timeout' ||
    !recoveredAt
  ) {
    return undefined;
  }

  return {
    strategy: 'without_initial_target_wait',
    reason: 'public_connect_timeout',
    recoveredAt,
  };
}

export function normalizeHumanVerificationResolvedMarker(
  value: unknown
): MagicBrowseHumanVerificationResolvedMarker | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const pageIdentity = normalizeActivePageIdentity(value.pageIdentity);
  const resolvedAt = readValidDateString(value.resolvedAt);
  const expiresAt = readValidDateString(value.expiresAt);

  if (
    value.kind !== 'humanVerificationResolved' ||
    value.verificationKind !== 'captcha' ||
    value.source !== 'orchestrator' ||
    !pageIdentity ||
    !resolvedAt ||
    !expiresAt
  ) {
    return undefined;
  }

  return {
    kind: 'humanVerificationResolved',
    verificationKind: 'captcha',
    pageIdentity,
    resolvedAt,
    expiresAt,
    source: 'orchestrator',
  };
}

function normalizeCloudProvider(value: unknown): MagicBrowseCloudProviderMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value.name);
  const sessionId = readString(value.sessionId);
  const projectId = readString(value.projectId);
  const region = readString(value.region);

  return name === 'browserbase' && sessionId
    ? {
        name,
        sessionId,
        ...(projectId ? { projectId } : {}),
        ...(region ? { region } : {}),
      }
    : undefined;
}

function normalizeProfileInfo(value: unknown): MagicBrowseProfileInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value.name);
  const userDataDir = readString(value.userDataDir);

  return name && userDataDir ? { name, userDataDir } : undefined;
}

export function normalizeActivePageIdentity(
  value: unknown
): MagicBrowseActivePageIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const targetId = readString(value.targetId);
  const url = readString(value.url);
  const title = readString(value.title);

  if (!targetId && !url && !title) {
    return undefined;
  }

  return {
    ...(targetId ? { targetId } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

function normalizeViewport(value: unknown): MagicBrowseViewport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const width = readPositiveNumber(value.width);
  const height = readPositiveNumber(value.height);

  return width && height ? { width, height } : undefined;
}

function normalizeProxyConfig(value: unknown): MagicBrowseProxyConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const server = readString(value.server);
  if (!server) {
    return undefined;
  }

  const username = readString(value.username);
  const password = typeof value.password === 'string' ? value.password : undefined;

  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readValidDateString(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}
