import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  mergeExactValueRedactionProfiles,
  normalizeExactValueRedactionProfiles,
  type ExactValueRedactionProfiles,
} from '../redaction.js';
import { parseBrowserInstanceRef } from './attach-endpoint.js';
import { withFileMutationLock, writeJsonFileAtomically } from './file-mutation-lock.js';
import type { TargetObservationLease } from '../resolution/target-observation-lease.js';

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
  /**
   * Monotonic compare-and-swap token for session authority updates. Legacy
   * records without the field are revision zero.
   */
  readonly revision?: number;
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
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference;
  /** Private action authority. Never project through MagicBrowseManagedSession. */
  readonly observationLeases?: readonly TargetObservationLease[];
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
  saveCurrentSessionIfRevision(
    session: PersistedMagicBrowseSession,
    expectedRevision: number
  ): Promise<boolean>;
  invalidateCurrentSessionPageAuthorityThroughRevision(
    sessionId: string,
    maxRevision: number,
    runId?: string
  ): Promise<boolean>;
  clearCurrentSession(sessionId?: string): Promise<void>;
}

export interface FileMagicBrowseSessionStoreOptions extends ResolveMagicBrowseHomeOptions {
  readonly rootDir?: string;
}

export function persistedSessionRevision(session: PersistedMagicBrowseSession): number {
  return session.revision ?? 0;
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
  let mutationQueue = Promise.resolve();

  const loadCurrentSession = async (): Promise<PersistedMagicBrowseSession | undefined> => {
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
  };

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = mutationQueue.then(operation, operation);
    mutationQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  };

  const writeCurrentSession = async (session: PersistedMagicBrowseSession): Promise<void> => {
    await writeJsonFileAtomically(currentSessionPath, session);
  };

  return {
    currentSessionPath,
    async loadCurrentSession() {
      await mutationQueue;
      return loadCurrentSession();
    },
    async saveCurrentSession(session) {
      await enqueueMutation(() =>
        withFileMutationLock(currentSessionPath, () => writeCurrentSession(session))
      );
    },
    async saveCurrentSessionIfRevision(session, expectedRevision) {
      return enqueueMutation(() =>
        withFileMutationLock(currentSessionPath, async () => {
          const current = await loadCurrentSession();
          if (
            current?.id !== session.id ||
            persistedSessionRevision(current) !== expectedRevision
          ) {
            return false;
          }
          await writeCurrentSession(session);
          return true;
        })
      );
    },
    async invalidateCurrentSessionPageAuthorityThroughRevision(sessionId, maxRevision, runId) {
      return enqueueMutation(() =>
        withFileMutationLock(currentSessionPath, async () => {
          const current = await loadCurrentSession();
          if (current?.id !== sessionId || persistedSessionRevision(current) > maxRevision) {
            return false;
          }
          await writeCurrentSession(sessionWithoutPageAuthority(current, runId));
          return true;
        })
      );
    },
    async clearCurrentSession(sessionId) {
      await enqueueMutation(() =>
        withFileMutationLock(currentSessionPath, async () => {
          if (!sessionId) {
            await rm(currentSessionPath, { force: true });
            return;
          }

          const current = await loadCurrentSession();
          if (!current || current.id === sessionId) {
            await rm(currentSessionPath, { force: true });
          }
        })
      );
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
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference;
  readonly observationLeases?: readonly TargetObservationLease[];
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
    ...(input.redactionProfiles ? { redactionProfiles: input.redactionProfiles } : {}),
    ...(localCdpConnectPreference ? { localCdpConnectPreference } : {}),
    ...(input.observationLeases
      ? { observationLeases: input.observationLeases.slice(0, 1024) }
      : {}),
  };
}

export function touchPersistedMagicBrowseSession(
  session: PersistedMagicBrowseSession,
  input: {
    readonly activePageIdentity?: MagicBrowseActivePageIdentity;
    readonly runId?: string;
    readonly humanVerificationResolved?: MagicBrowseHumanVerificationResolvedMarker | null;
    readonly redactionProfiles?: ExactValueRedactionProfiles;
    readonly localCdpConnectPreference?: MagicBrowseLocalCdpConnectPreference | null;
    readonly observationLeases?: readonly TargetObservationLease[] | null;
    readonly now?: string;
  } = {}
): PersistedMagicBrowseSession {
  const activePageIdentity = normalizeActivePageIdentity(input.activePageIdentity);
  const localCdpConnectPreference = normalizeLocalCdpConnectPreference(
    input.localCdpConnectPreference
  );
  let next: PersistedMagicBrowseSession = {
    ...session,
    revision: persistedSessionRevision(session) + 1,
    updatedAt: input.now ?? new Date().toISOString(),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(activePageIdentity ? { activePageIdentity } : {}),
    ...(input.redactionProfiles
      ? {
          redactionProfiles: mergeExactValueRedactionProfiles(
            session.redactionProfiles,
            input.redactionProfiles
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
      next = {
        ...next,
        humanVerificationResolved: marker,
      };
    } else {
      const { humanVerificationResolved: _removed, ...withoutMarker } = next;
      next = withoutMarker;
    }
  }

  if (input.observationLeases !== undefined) {
    if (input.observationLeases) {
      next = { ...next, observationLeases: input.observationLeases.slice(0, 1024) };
    } else {
      const { observationLeases: _removed, ...withoutLeases } = next;
      next = withoutLeases;
    }
  }

  return next;
}

function sessionWithoutPageAuthority(
  session: PersistedMagicBrowseSession,
  runId?: string
): PersistedMagicBrowseSession {
  const touched = touchPersistedMagicBrowseSession(session, {
    ...(runId ? { runId } : {}),
    humanVerificationResolved: null,
  });
  const { activePageIdentity: _activePageIdentity, ...withoutPageAuthority } = touched;
  const { observationLeases: _observationLeases, ...withoutLeases } = withoutPageAuthority;
  return withoutLeases;
}

export function normalizePersistedMagicBrowseSession(
  value: unknown
): PersistedMagicBrowseSession | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value.id);
  const revision = readNonNegativeInteger(value.revision);
  const runId = readString(value.runId);
  const ownership = value.ownership;
  const cdpUrl = readString(value.cdpUrl);
  const cloudProvider = normalizeCloudProvider(value.cloudProvider);
  const browserInstanceRef =
    readString(value.browserInstanceRef) ?? parseBrowserInstanceRef(cdpUrl ?? '');
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
  const redactionProfiles = normalizeExactValueRedactionProfiles(
    value.redactionProfiles ?? value.protectedRedactionProfiles
  );
  const localCdpConnectPreference = normalizeLocalCdpConnectPreference(
    value.localCdpConnectPreference
  );
  const observationLeases = normalizeObservationLeases(value.observationLeases);

  if (
    value.version !== MAGICBROWSE_SESSION_SCHEMA_VERSION ||
    (value.revision !== undefined && revision === undefined) ||
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
    ...(revision !== undefined && revision > 0 ? { revision } : {}),
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
    ...(redactionProfiles ? { redactionProfiles } : {}),
    ...(localCdpConnectPreference ? { localCdpConnectPreference } : {}),
    ...(observationLeases ? { observationLeases } : {}),
  };
}

function normalizeObservationLeases(value: unknown): readonly TargetObservationLease[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1024) return undefined;
  const leases: TargetObservationLease[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.scope)) return undefined;
    const action = entry.action;
    const strings = [
      entry.leaseRef,
      entry.observationRef,
      entry.pageRef,
      entry.documentRef,
      entry.descriptorSignature,
      entry.targetRef,
    ];
    if (!strings.every((item) => typeof item === 'string' && item.length > 0)) return undefined;
    if (!['click', 'fill', 'type', 'select'].includes(String(action))) return undefined;
    const scope = entry.scope;
    const arrays = [
      scope.targetAncestorNodeIds,
      scope.formOwnerNodeIds,
      scope.modalOwnerNodeIds,
      scope.contributingLabelNodeIds,
      scope.optionOwnerNodeIds,
      scope.frameOwnerNodeIds,
    ];
    if (
      typeof scope.documentRef !== 'string' ||
      typeof scope.targetNodeId !== 'string' ||
      !arrays.every(
        (items) =>
          Array.isArray(items) &&
          items.length <= 32 &&
          items.every((item) => typeof item === 'string')
      ) ||
      typeof entry.observedEpoch !== 'number' ||
      !Number.isSafeInteger(entry.observedEpoch) ||
      entry.observedEpoch < 0
    )
      return undefined;
    leases.push(entry as unknown as TargetObservationLease);
  }
  return leases;
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
  const documentRef = readString(value.documentRef);
  const url = readString(value.url);
  const title = readString(value.title);

  if (!targetId && !documentRef && !url && !title) {
    return undefined;
  }

  return {
    ...(targetId ? { targetId } : {}),
    ...(documentRef ? { documentRef } : {}),
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

function readNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return 0;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}
