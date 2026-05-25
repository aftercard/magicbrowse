import { debugWrite, isDebug } from './debug.js';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const mirrorEnabled = (): boolean =>
  process.env.MAGICBROWSE_LOG === '1' ||
  (process.env.DEBUG ?? '')
    .split(',')
    .map((item) => item.trim())
    .includes('magicbrowse');

export function createLogger(prefix: string): Logger {
  return {
    debug: (...args) => writeLog('debug', prefix, args),
    info: (...args) => writeLog('info', prefix, args),
    warning: (...args) => writeLog('warn', prefix, args),
    error: (...args) => writeLog('error', prefix, args),
  };
}

function writeLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  prefix: string,
  args: readonly unknown[]
): void {
  const shouldMirror = mirrorEnabled();
  const shouldDebug = isDebug();
  if (!shouldMirror && !shouldDebug) {
    return;
  }

  const line = `[${prefix}] ${args.map(formatArg).join(' ')}`;
  if (shouldDebug) {
    debugWrite(`[logger.${level}] ${line}`);
  }
  if (!shouldMirror) {
    return;
  }

  switch (level) {
    case 'debug':
      console.debug(line);
      break;
    case 'info':
      console.info(line);
      break;
    case 'warn':
      console.warn(line);
      break;
    case 'error':
      console.error(line);
      break;
  }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
