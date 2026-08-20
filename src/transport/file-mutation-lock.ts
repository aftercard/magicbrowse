import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const FILE_LOCK_STALE_MS = 60_000;
const FILE_LOCK_WAIT_MS = 2_000;
const FILE_LOCK_RETRY_MS = 10;
const FILE_LOCK_METADATA_FILENAME = 'owner.json';

export async function withFileMutationLock<T>(
  targetPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = `${targetPath}.lock`;
  await acquireFileLock(targetPath, lockPath);
  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeJsonFileAtomically(targetPath: string, value: unknown): Promise<void> {
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
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
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
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `MagicBrowse state store is busy for ${targetPath}; retry after the current command finishes.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
  }
}

async function createLockDirectory(targetPath: string, lockPath: string): Promise<void> {
  await mkdir(lockPath);
  try {
    await writeFile(
      join(lockPath, FILE_LOCK_METADATA_FILENAME),
      `${JSON.stringify(
        {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          target: targetPath,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const metadata = await readLockMetadata(lockPath);
  const createdAt =
    typeof metadata?.createdAt === 'string' ? Date.parse(metadata.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt) && Date.now() - createdAt > FILE_LOCK_STALE_MS) {
    return true;
  }
  if (typeof metadata?.pid === 'number' && !isPidAlive(metadata.pid)) {
    return true;
  }
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > FILE_LOCK_STALE_MS;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readLockMetadata(lockPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(join(lockPath, FILE_LOCK_METADATA_FILENAME), 'utf8');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
