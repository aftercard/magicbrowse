// Single source of truth for diagnostic tracing. The transport layer installs a
// run sink for each act() call; legacy file logging remains as a compatibility
// fallback for direct internal callers.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactTransientImageDataUrls } from '../redaction.js';

export interface DebugSink {
  write(line: string): void;
}

let _enabled = false;
let _logPath: string | null = null;
let _sink: DebugSink | null = null;

export function enableDebug(filePath: string): void {
  _enabled = true;
  _sink = null;
  _logPath = path.resolve(filePath);
  // Truncate at the start of each act() call so each run gets a clean log.
  try {
    fs.writeFileSync(_logPath, `# magicbrowse debug log started ${new Date().toISOString()}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(`[debug] failed to open ${_logPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    _enabled = false;
    _logPath = null;
  }
}

export function enableDebugSink(sink: DebugSink): void {
  _enabled = true;
  _sink = sink;
  _logPath = null;
}

export function disableDebug(): void {
  _enabled = false;
  _logPath = null;
  _sink = null;
}

export function isDebug(): boolean {
  return _enabled;
}

export function debugLogPath(): string | null {
  return _logPath;
}

export function debugWrite(line: string): void {
  if (!_enabled) return;
  const persistedLine = redactTransientImageDataUrls(line);
  if (_sink) {
    _sink.write(persistedLine);
    return;
  }
  if (!_logPath) return;
  try {
    fs.appendFileSync(_logPath, persistedLine.endsWith('\n') ? persistedLine : persistedLine + '\n', 'utf8');
  } catch {
    // best-effort; don't crash the agent over a log write failure
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === 'bigint') {
          return current.toString();
        }
        if (typeof current === 'object' && current !== null) {
          if (seen.has(current)) {
            return '[Circular]';
          }
          seen.add(current);
        }
        return current;
      },
      2,
    );
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

export function debugJson(label: string, value: unknown): void {
  if (!_enabled) return;
  debugWrite(`${label}\n${safeStringify(value)}`);
}
