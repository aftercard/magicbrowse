export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;

/**
 * `act` is a different kind of operation from a click or a fill, and giving it
 * the single-action budget starves it. Each step costs an observe, often a
 * screenshot, and a model round trip — on a heavy checkout that is 15-20s — so
 * a 60s ceiling buys roughly three steps no matter what `maxSteps` allows.
 *
 * Measured: an act on a donation page was killed at 60009ms, mid model call,
 * 16s after a screenshot completed, having made progress throughout. It was
 * not stuck; it was interrupted.
 *
 * This ceiling still exists to end a genuinely stuck run. It is not a licence
 * to run forever, and `maxSteps` remains the budget for how much work an act
 * may do.
 */
export const DEFAULT_AGENTIC_ACT_TIMEOUT_MS = 180_000;

export type BrowserActionDeadlineCode = 'action_timeout' | 'action_cancelled';

export class BrowserActionDeadlineError extends Error {
  readonly retryable = true;
  readonly mutationState = 'unknown' as const;
  readonly recovery = 'fresh_observe_required' as const;

  constructor(
    readonly code: BrowserActionDeadlineCode,
    readonly actionName: string,
    readonly timeoutMs?: number
  ) {
    super(
      code === 'action_timeout'
        ? `action_timeout: Browser action ${actionName} timed out after ${timeoutMs}ms; mutation state is unknown and a fresh observe is required before retry.`
        : `action_cancelled: Browser action ${actionName} was cancelled; mutation state is unknown and a fresh observe is required before retry.`
    );
    this.name = 'BrowserActionDeadlineError';
  }
}

export interface DisconnectableBrowser {
  disconnect(): void | Promise<void>;
}

const browserDisconnections = new WeakMap<object, Promise<void>>();

export function disconnectBrowserOnce(browser: DisconnectableBrowser): Promise<void> {
  const key = browser as object;
  const existing = browserDisconnections.get(key);
  if (existing) {
    return existing;
  }

  const disconnection = Promise.resolve()
    .then(() => browser.disconnect())
    .then(
      () => undefined,
      () => undefined
    );
  browserDisconnections.set(key, disconnection);
  return disconnection;
}

export interface BrowserActionDeadlineOptions {
  readonly actionName: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly cancel?: (error: BrowserActionDeadlineError) => void | Promise<void>;
}

export async function runWithBrowserActionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: BrowserActionDeadlineOptions
): Promise<T> {
  const timeoutMs = normalizeBrowserActionTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: BrowserActionDeadlineError) => void) | undefined;
  let termination: BrowserActionDeadlineError | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const terminate = (error: BrowserActionDeadlineError) => {
    if (termination) {
      return;
    }
    termination = error;
    controller.abort(error);
    try {
      void Promise.resolve(options.cancel?.(error)).catch(() => undefined);
    } catch {
      // Cancellation failure must not hide the classified deadline failure.
    }
    rejectDeadline?.(error);
  };

  const onAbort = () => {
    terminate(new BrowserActionDeadlineError('action_cancelled', options.actionName));
  };

  if (options.signal?.aborted) {
    onAbort();
    return deadline;
  }
  options.signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => {
    terminate(new BrowserActionDeadlineError('action_timeout', options.actionName, timeoutMs));
  }, timeoutMs);
  timer.unref?.();

  const operationTask = Promise.resolve().then(() => operation(controller.signal));
  // Promise.race observes late rejection already; the explicit handler also
  // documents and preserves that invariant if the implementation changes.
  void operationTask.catch(() => undefined);

  try {
    return await Promise.race([operationTask, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function isBrowserActionDeadlineError(error: unknown): error is BrowserActionDeadlineError {
  return error instanceof BrowserActionDeadlineError;
}

export function normalizeBrowserActionTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Browser action timeout must be a positive finite number.');
  }
  return Math.floor(timeoutMs);
}

/**
 * Wait without assigning a browser-action deadline, while still honoring the
 * operation's cancellation signal immediately.
 */
export async function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('Abortable delay must be a non-negative finite number.');
  }
  signal.throwIfAborted();
  if (delayMs === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
