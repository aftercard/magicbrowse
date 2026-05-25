import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import type { DebugSink } from '../adapter/debug.js';
import {
  mergeProtectedRedactionProfiles,
  normalizeProtectedRedactionProfiles,
  redactSensitiveText,
  redactSensitiveValue,
  type ProtectedExactValueProfile,
  type ProtectedRedactionProfiles,
} from '../redaction.js';
import type {
  MagicBrowseActivePageIdentity,
  MagicBrowseCloudProviderMetadata,
  MagicBrowseProfileInfo,
  MagicBrowseSessionOwnership,
} from '../types.js';
import { resolveMagicBrowseHome, type ResolveMagicBrowseHomeOptions } from './session-store.js';

export const MAGICBROWSE_RUN_SCHEMA_VERSION = 1 as const;
export const RUNS_DIRNAME = 'runs';
export const RUN_INDEX_FILENAME = 'run-index.json';
const RUN_STORE_LOCK_STALE_MS = 60_000;
const RUN_STORE_LOCK_METADATA_FILENAME = 'owner.json';

export type MagicBrowseRunStatus = 'running' | 'closed' | 'failed';
export type MagicBrowseRunEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MagicBrowseRunEventInput {
  readonly type: string;
  readonly level?: MagicBrowseRunEventLevel;
  readonly message?: string;
  readonly data?: unknown;
  readonly actId?: string;
}

export interface MagicBrowseRunEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly type: string;
  readonly level: MagicBrowseRunEventLevel;
  readonly message?: string;
  readonly data?: unknown;
  readonly actId?: string;
}

export interface MagicBrowseRunRecord {
  readonly version: typeof MAGICBROWSE_RUN_SCHEMA_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly status: MagicBrowseRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ownership?: MagicBrowseSessionOwnership;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly cdpUrl?: string;
  readonly pid?: number;
  readonly profile?: MagicBrowseProfileInfo;
  readonly instruction?: string;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
  readonly lastActStatus?: string;
  readonly lastFinalUrl?: string;
  readonly closedAt?: string;
  readonly events: readonly MagicBrowseRunEvent[];
}

export interface MagicBrowseRunIndex {
  readonly version: typeof MAGICBROWSE_RUN_SCHEMA_VERSION;
  readonly runIdsBySessionId: Record<string, string[]>;
  readonly activeRunIdBySessionId: Record<string, string>;
}

export interface MagicBrowseSessionRunInput {
  readonly sessionId: string;
  readonly ownership?: MagicBrowseSessionOwnership;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly cdpUrl?: string;
  readonly pid?: number;
  readonly profile?: MagicBrowseProfileInfo;
  readonly instruction?: string;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
  readonly runId?: string;
}

export interface MagicBrowseRunUpdateInput {
  readonly status?: MagicBrowseRunStatus;
  readonly instruction?: string;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
  readonly lastActStatus?: string;
  readonly lastFinalUrl?: string;
  readonly closedAt?: string;
}

export interface MagicBrowseRunRecorder {
  readonly runId: string;
  readonly sessionId: string;
  append(event: MagicBrowseRunEventInput): Promise<void>;
  update(input: MagicBrowseRunUpdateInput): Promise<void>;
  createDebugSink(actId?: string): DebugSink;
  flush(): Promise<void>;
}

export interface MagicBrowseRunStore {
  readonly runsDir: string;
  readonly runIndexPath: string;
  createSessionRun(input: MagicBrowseSessionRunInput): Promise<MagicBrowseRunRecorder>;
  getOrCreateSessionRun(input: MagicBrowseSessionRunInput): Promise<MagicBrowseRunRecorder>;
  loadRun(runId: string): Promise<MagicBrowseRunRecord | undefined>;
}

export interface FileMagicBrowseRunStoreOptions extends ResolveMagicBrowseHomeOptions {
  readonly rootDir?: string;
  readonly createRunId?: () => string;
  readonly now?: () => Date;
}

export function createFileMagicBrowseRunStore(
  options: FileMagicBrowseRunStoreOptions = {}
): MagicBrowseRunStore {
  return new FileMagicBrowseRunStore(options);
}

class FileMagicBrowseRunStore implements MagicBrowseRunStore {
  readonly runsDir: string;
  readonly runIndexPath: string;

  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: FileMagicBrowseRunStoreOptions) {
    const rootDir = resolve(options.rootDir ?? resolveMagicBrowseHome(options));
    this.runsDir = join(rootDir, RUNS_DIRNAME);
    this.runIndexPath = join(rootDir, RUN_INDEX_FILENAME);
    this.createRunId = options.createRunId ?? (() => `run-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async createSessionRun(input: MagicBrowseSessionRunInput): Promise<MagicBrowseRunRecorder> {
    const runId = input.runId ?? this.createRunId();
    const now = this.isoNow();
    const record: MagicBrowseRunRecord = {
      version: MAGICBROWSE_RUN_SCHEMA_VERSION,
      id: runId,
      sessionId: input.sessionId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      ...(input.ownership ? { ownership: input.ownership } : {}),
      ...(input.cloudProvider ? { cloudProvider: input.cloudProvider } : {}),
      ...(input.cdpUrl ? { cdpUrl: input.cdpUrl } : {}),
      ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
      ...(input.activePageIdentity ? { activePageIdentity: input.activePageIdentity } : {}),
      ...(input.protectedRedactionProfiles
        ? { protectedRedactionProfiles: input.protectedRedactionProfiles }
        : {}),
      events: [],
    };

    const safeRecord = redactRunRecord(record);

    await mkdir(this.runsDir, { recursive: true });
    await this.enqueue(runId, () =>
      this.withFileLock(this.runPath(runId), () => this.writeRun(safeRecord))
    );
    await this.updateIndex((index) => {
      const runIds = index.runIdsBySessionId[input.sessionId] ?? [];
      if (!runIds.includes(runId)) {
        index.runIdsBySessionId[input.sessionId] = [...runIds, runId];
      }
      index.activeRunIdBySessionId[input.sessionId] = runId;
    });

    const recorder = this.createRecorder(runId, input.sessionId);
    await recorder.append({
      type: 'session.run.created',
      level: 'info',
      data: redactSensitiveValue(input),
    });
    return recorder;
  }

  async getOrCreateSessionRun(input: MagicBrowseSessionRunInput): Promise<MagicBrowseRunRecorder> {
    const index = await this.loadIndex();
    const indexedRunId =
      input.runId ??
      index.activeRunIdBySessionId[input.sessionId] ??
      index.runIdsBySessionId[input.sessionId]?.at(-1);

    if (indexedRunId) {
      const existing = await this.loadRun(indexedRunId);
      if (existing?.sessionId === input.sessionId) {
        return this.createRecorder(indexedRunId, input.sessionId);
      }
    }

    const recorder = await this.createSessionRun(input);
    await recorder.append({
      type: 'session.run.recovered',
      level: 'warn',
      message: 'Created a run record for a persisted session that did not have one.',
      data: redactSensitiveValue(input),
    });
    return recorder;
  }

  async loadRun(runId: string): Promise<MagicBrowseRunRecord | undefined> {
    try {
      const raw = await readFile(this.runPath(runId), 'utf8');
      return normalizeRunRecord(JSON.parse(raw));
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  private createRecorder(runId: string, sessionId: string): MagicBrowseRunRecorder {
    return {
      runId,
      sessionId,
      append: (event) => this.appendEvent(runId, sessionId, event),
      update: (input) => this.updateRun(runId, input),
      createDebugSink: (actId) => ({
        write: (line) => {
          void this.appendEvent(runId, sessionId, {
            type: 'debug.line',
            level: 'debug',
            message: line,
            actId,
          });
        },
      }),
      flush: () => this.flush(runId),
    };
  }

  private appendEvent(
    runId: string,
    sessionId: string,
    input: MagicBrowseRunEventInput
  ): Promise<void> {
    return this.enqueue(runId, async () => {
      await this.withFileLock(this.runPath(runId), async () => {
        const record = await this.requireRun(runId);
        const now = this.isoNow();
        const event: MagicBrowseRunEvent = {
          sequence: record.events.length + 1,
          timestamp: now,
          sessionId,
          type: input.type,
          level: input.level ?? 'info',
          ...(input.message
            ? {
                message: redactRunText(input.message, record.protectedRedactionProfiles),
              }
            : {}),
          ...(input.data !== undefined
            ? {
                data: redactRunValue(input.data, record.protectedRedactionProfiles),
              }
            : {}),
          ...(input.actId ? { actId: input.actId } : {}),
        };
        await this.writeRun({
          ...record,
          updatedAt: now,
          events: [...record.events, event],
        });
      });
    });
  }

  private updateRun(runId: string, input: MagicBrowseRunUpdateInput): Promise<void> {
    return this.enqueue(runId, async () => {
      await this.withFileLock(this.runPath(runId), async () => {
        const record = await this.requireRun(runId);
        const now = this.isoNow();
        const protectedRedactionProfiles = input.protectedRedactionProfiles
          ? mergeProtectedRedactionProfiles(
              record.protectedRedactionProfiles,
              input.protectedRedactionProfiles
            )
          : record.protectedRedactionProfiles;
        const shouldScrubRecord = hasProtectedRedactionProfileChanges(
          record.protectedRedactionProfiles,
          input.protectedRedactionProfiles
        );
        const updatedRecord: MagicBrowseRunRecord = {
          ...record,
          updatedAt: now,
          ...(input.status ? { status: input.status } : {}),
          ...(input.instruction
            ? { instruction: redactRunText(input.instruction, protectedRedactionProfiles) }
            : {}),
          ...(input.activePageIdentity
            ? {
                activePageIdentity: redactRunValue(
                  input.activePageIdentity,
                  protectedRedactionProfiles
                ),
              }
            : {}),
          ...(input.protectedRedactionProfiles
            ? {
                protectedRedactionProfiles,
              }
            : {}),
          ...(input.lastActStatus
            ? { lastActStatus: redactRunText(input.lastActStatus, protectedRedactionProfiles) }
            : {}),
          ...(input.lastFinalUrl
            ? { lastFinalUrl: redactRunText(input.lastFinalUrl, protectedRedactionProfiles) }
            : {}),
          ...(input.closedAt ? { closedAt: input.closedAt } : {}),
        };
        await this.writeRun(shouldScrubRecord ? redactRunRecord(updatedRecord) : updatedRecord);
      });
    });
  }

  private async flush(runId: string): Promise<void> {
    await (this.queues.get(runId) ?? Promise.resolve());
  }

  private enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(
      runId,
      next.catch(() => undefined)
    );
    return next;
  }

  private async requireRun(runId: string): Promise<MagicBrowseRunRecord> {
    const record = await this.loadRun(runId);
    if (!record) {
      throw new Error(`MagicBrowse run ${runId} does not exist.`);
    }
    return record;
  }

  private async writeRun(record: MagicBrowseRunRecord): Promise<void> {
    await writeJsonFileAtomically(this.runPath(record.id), record);
  }

  private async loadIndex(): Promise<MutableMagicBrowseRunIndex> {
    try {
      const raw = await readFile(this.runIndexPath, 'utf8');
      return normalizeRunIndex(JSON.parse(raw));
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return emptyRunIndex();
      }
      throw error;
    }
  }

  private async updateIndex(mutator: (index: MutableMagicBrowseRunIndex) => void): Promise<void> {
    await this.enqueue(this.runIndexPath, () =>
      this.withFileLock(this.runIndexPath, async () => {
        const index = await this.loadIndex();
        mutator(index);
        await writeJsonFileAtomically(this.runIndexPath, index);
      })
    );
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private async withFileLock<T>(targetPath: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${targetPath}.lock`;
    await acquireFileLock(targetPath, lockPath);
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type MutableMagicBrowseRunIndex = {
  version: typeof MAGICBROWSE_RUN_SCHEMA_VERSION;
  runIdsBySessionId: Record<string, string[]>;
  activeRunIdBySessionId: Record<string, string>;
};

function emptyRunIndex(): MutableMagicBrowseRunIndex {
  return {
    version: MAGICBROWSE_RUN_SCHEMA_VERSION,
    runIdsBySessionId: {},
    activeRunIdBySessionId: {},
  };
}

function redactRunRecord(record: MagicBrowseRunRecord): MagicBrowseRunRecord {
  return redactRunValue(record, record.protectedRedactionProfiles);
}

function redactRunText(
  value: string,
  protectedRedactionProfiles: ProtectedRedactionProfiles | undefined
): string {
  return redactSensitiveText(value, { protectedRedactionProfiles });
}

function redactRunValue<T>(
  value: T,
  protectedRedactionProfiles: ProtectedRedactionProfiles | undefined
): T {
  return redactSensitiveValue(value, { protectedRedactionProfiles }) as T;
}

function hasProtectedRedactionProfileChanges(
  currentProfiles: ProtectedRedactionProfiles | undefined,
  incomingProfiles: ProtectedRedactionProfiles | undefined
): boolean {
  if (!incomingProfiles) {
    return false;
  }

  for (const [profileRef, incomingProfile] of Object.entries(incomingProfiles)) {
    const currentProfile = currentProfiles?.[profileRef];
    if (!currentProfile || !protectedExactValueProfilesEqual(currentProfile, incomingProfile)) {
      return true;
    }
  }
  return false;
}

function protectedExactValueProfilesEqual(
  left: ProtectedExactValueProfile,
  right: ProtectedExactValueProfile
): boolean {
  if (left.version !== right.version || left.algorithm !== right.algorithm) {
    return false;
  }

  const leftRules = Object.entries(left.rules);
  const rightRuleRefs = new Set(Object.keys(right.rules));
  if (leftRules.length !== rightRuleRefs.size) {
    return false;
  }

  for (const [ruleRef, leftRule] of leftRules) {
    const rightRule = right.rules[ruleRef];
    if (
      !rightRule ||
      leftRule.kind !== rightRule.kind ||
      leftRule.digest !== rightRule.digest ||
      leftRule.length !== rightRule.length
    ) {
      return false;
    }
  }
  return true;
}

function normalizeRunIndex(value: unknown): MutableMagicBrowseRunIndex {
  const record = isRecord(value) ? value : {};
  const runIdsBySessionId: Record<string, string[]> = {};
  const activeRunIdBySessionId: Record<string, string> = {};

  if (isRecord(record.runIdsBySessionId)) {
    for (const [sessionId, runIds] of Object.entries(record.runIdsBySessionId)) {
      if (Array.isArray(runIds)) {
        runIdsBySessionId[sessionId] = runIds.filter(
          (runId): runId is string => typeof runId === 'string' && runId.length > 0
        );
      }
    }
  }

  if (isRecord(record.activeRunIdBySessionId)) {
    for (const [sessionId, runId] of Object.entries(record.activeRunIdBySessionId)) {
      if (typeof runId === 'string' && runId.length > 0) {
        activeRunIdBySessionId[sessionId] = runId;
      }
    }
  }

  return {
    version: MAGICBROWSE_RUN_SCHEMA_VERSION,
    runIdsBySessionId,
    activeRunIdBySessionId,
  };
}

function normalizeRunRecord(value: unknown): MagicBrowseRunRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value.id);
  const sessionId = readString(value.sessionId);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  const events = Array.isArray(value.events) ? value.events.filter(isRunEvent) : [];
  const protectedRedactionProfiles = normalizeProtectedRedactionProfiles(
    value.protectedRedactionProfiles
  );

  if (!id || !sessionId) {
    return undefined;
  }

  return {
    version: MAGICBROWSE_RUN_SCHEMA_VERSION,
    id,
    sessionId,
    status: readRunStatus(value.status) ?? 'running',
    createdAt: createdAt ?? new Date(0).toISOString(),
    updatedAt: updatedAt ?? createdAt ?? new Date(0).toISOString(),
    ...(readOwnership(value.ownership) ? { ownership: readOwnership(value.ownership)! } : {}),
    ...(normalizeCloudProvider(value.cloudProvider)
      ? { cloudProvider: normalizeCloudProvider(value.cloudProvider)! }
      : {}),
    ...(readString(value.cdpUrl) ? { cdpUrl: readString(value.cdpUrl)! } : {}),
    ...(readPositiveNumber(value.pid) ? { pid: readPositiveNumber(value.pid)! } : {}),
    ...(normalizeProfileInfo(value.profile)
      ? { profile: normalizeProfileInfo(value.profile)! }
      : {}),
    ...(readString(value.instruction) ? { instruction: readString(value.instruction)! } : {}),
    ...(normalizeActivePageIdentity(value.activePageIdentity)
      ? { activePageIdentity: normalizeActivePageIdentity(value.activePageIdentity)! }
      : {}),
    ...(protectedRedactionProfiles ? { protectedRedactionProfiles } : {}),
    ...(readString(value.lastActStatus) ? { lastActStatus: readString(value.lastActStatus)! } : {}),
    ...(readString(value.lastFinalUrl) ? { lastFinalUrl: readString(value.lastFinalUrl)! } : {}),
    ...(readString(value.closedAt) ? { closedAt: readString(value.closedAt)! } : {}),
    events,
  };
}

function isRunEvent(value: unknown): value is MagicBrowseRunEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sequence === 'number' &&
    typeof value.timestamp === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.type === 'string' &&
    readRunEventLevel(value.level) !== undefined
  );
}

function normalizeProfileInfo(value: unknown): MagicBrowseProfileInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value.name);
  const userDataDir = readString(value.userDataDir);
  return name && userDataDir ? { name, userDataDir } : undefined;
}

function normalizeActivePageIdentity(value: unknown): MagicBrowseActivePageIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const targetId = readString(value.targetId);
  const url = readString(value.url);
  const title = readString(value.title);
  return targetId || url || title
    ? {
        ...(targetId ? { targetId } : {}),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
      }
    : undefined;
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

function readOwnership(value: unknown): MagicBrowseSessionOwnership | undefined {
  return value === 'owned' || value === 'attached' ? value : undefined;
}

function readRunStatus(value: unknown): MagicBrowseRunStatus | undefined {
  return value === 'running' || value === 'closed' || value === 'failed' ? value : undefined;
}

function readRunEventLevel(value: unknown): MagicBrowseRunEventLevel | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJsonFileAtomically(targetPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function acquireFileLock(targetPath: string, lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await createLockDirectory(targetPath, lockPath);
    return;
  } catch (error) {
    if (getErrorCode(error) !== 'EEXIST') {
      throw error;
    }
  }

  if (await isStaleLock(lockPath)) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    try {
      await createLockDirectory(targetPath, lockPath);
      return;
    } catch (error) {
      if (getErrorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error(
    `MagicBrowse run store is busy for ${targetPath}; retry after the current command finishes.`
  );
}

async function createLockDirectory(targetPath: string, lockPath: string): Promise<void> {
  await mkdir(lockPath);
  const metadata = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    target: targetPath,
  };
  try {
    await writeFile(
      join(lockPath, RUN_STORE_LOCK_METADATA_FILENAME),
      `${JSON.stringify(metadata, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);
  const metadataCreatedAt =
    typeof metadata?.createdAt === 'string' ? Date.parse(metadata.createdAt) : Number.NaN;
  if (
    Number.isFinite(metadataCreatedAt) &&
    Date.now() - metadataCreatedAt > RUN_STORE_LOCK_STALE_MS
  ) {
    return true;
  }

  if (typeof metadata?.pid === 'number' && !isPidAlive(metadata.pid)) {
    return true;
  }

  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > RUN_STORE_LOCK_STALE_MS;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readLockMetadata(lockPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(join(lockPath, RUN_STORE_LOCK_METADATA_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === 'EPERM';
  }
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}
