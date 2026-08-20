import type { Browser, ConsoleMessage, Page as PuppeteerPage } from 'puppeteer-core';

import { disableDebug, debugJson, enableDebugSink, isDebug } from '../adapter/debug.js';
import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import { BrowserContext } from '../browser/browser-context.js';
import { Executor, type ExecutorAgentState } from '../vendor/agent/executor.js';
import { Actors, ExecutionState, type AgentEvent } from '../vendor/agent/event/types.js';
import type {
  MagicBrowseActivePageIdentity,
  MagicBrowseActBlockedReason,
  MagicBrowseActFailureCode,
  MagicBrowseActHandoff,
  MagicBrowseActOptions,
  MagicBrowseActResult,
  MagicBrowseActStatus,
  MagicBrowseStepEvent,
  MagicBrowseTrustedRuntimeEvidence,
} from '../types.js';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ChatModelPaymentError,
  MaxFailuresReachedError,
  RequestCancelledError,
  isAbortedError,
} from '../vendor/agent/agents/errors.js';
import { readPageIdentity } from '../transport/page-resolver.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import { attachNativeBrowserDialogGuard } from './native-dialogs.js';
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  isBrowserActionDeadlineError,
  normalizeBrowserActionTimeoutMs,
} from './browser-action-deadline.js';
import {
  redactSensitiveText,
  redactSensitiveValue,
  type ExactValueRedactionProfiles,
} from '../redaction.js';

const ACT_CLEANUP_TIMEOUT_MS = 2_000;

export interface ExecuteMagicBrowseActInput {
  readonly browser: Browser;
  readonly page: PuppeteerPage;
  readonly displayHighlights: boolean;
  readonly options: MagicBrowseActOptions;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly actId?: string;
  readonly initialAgentState?: ExecutorAgentState;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly trustedRuntimeEvidence?: readonly MagicBrowseTrustedRuntimeEvidence[];
  /** Internal override; the public surface is owned by the session boundary. */
  readonly browserActionTimeoutMs?: number;
}

export interface ExecuteMagicBrowseActResult {
  readonly result: MagicBrowseActResult;
  readonly activePageIdentity: MagicBrowseActivePageIdentity;
  readonly agentState: ExecutorAgentState;
}

export async function executeMagicBrowseAct(
  input: ExecuteMagicBrowseActInput
): Promise<ExecuteMagicBrowseActResult> {
  const actOpts = input.options;

  if (input.runRecorder) {
    enableDebugSink(input.runRecorder.createDebugSink(input.actId));
    await input.runRecorder.append({
      type: 'act.debug.enabled',
      level: 'debug',
      actId: input.actId,
      message: 'Diagnostic trace is being written to this run record.',
    });
  }

  const generalSettings = {
    ...DEFAULT_GENERAL_SETTINGS,
    displayHighlights: input.displayHighlights,
    maxSteps: actOpts.maxSteps ?? DEFAULT_GENERAL_SETTINGS.maxSteps,
    useVision: actOpts.useVision === true,
    planningInterval: resolvePlanningInterval(actOpts.experimentalPlanningInterval),
    // Step-history persistence for the flow recorder; default-off env gate.
    replayHistoricalTasks:
      process.env.MAGICBROWSE_EXPERIMENTAL_STEP_HISTORY === '1' ||
      DEFAULT_GENERAL_SETTINGS.replayHistoricalTasks,
  };
  const ctx = new BrowserContext(
    input.browser,
    {
      displayHighlights: generalSettings.displayHighlights,
      minimumWaitPageLoadTime: generalSettings.minWaitPageLoadTime,
    },
    input.page
  );
  const llms = resolveActLlms(actOpts);
  const taskId = `task-${Date.now()}`;

  if (actOpts.url) {
    await ctx.navigateTo(actOpts.url);
  } else {
    await ctx.getCurrentPage();
  }

  const executor = new Executor(actOpts.goal, taskId, ctx, llms.navigatorLlm, {
    plannerLLM: llms.plannerLlm,
    navigatorProvider: llms.navigatorProvider,
    plannerProvider: llms.plannerProvider,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      browserActionTimeoutMs: normalizeBrowserActionTimeoutMs(
        actOpts.timeoutMs ?? input.browserActionTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS
      ),
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
    },
    generalSettings,
    initialAgentState: input.initialAgentState,
    browserStateTextProjector: createBrowserStateTextProjector(input.redactionProfiles),
    experimentalMemoryHints: actOpts.experimentalMemoryHints,
    trustedRuntimeEvidence: input.trustedRuntimeEvidence,
    signal: actOpts.signal,
  });

  const detachBrowserConsole = attachBrowserConsoleRecorder(
    input.page,
    input.runRecorder,
    input.actId,
    input.redactionProfiles
  );
  const nativeDialog = attachNativeBrowserDialogGuard(input.page, {
    runRecorder: input.runRecorder,
    actId: input.actId,
    redactionProfiles: input.redactionProfiles,
  });
  const steps: MagicBrowseStepEvent[] = [];
  let finalStatus: MagicBrowseActStatus = 'failed';
  let finalMessage: string | undefined;
  let finalHandoff: MagicBrowseActHandoff | undefined;
  let finalBlockedReason: MagicBrowseActBlockedReason | undefined;
  let lastEventAt = Date.now();

  const heartbeatMs = actOpts.heartbeatMs ?? 15_000;
  const heartbeatTimer =
    heartbeatMs > 0
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - lastEventAt) / 1000);
          if (elapsed * 1000 >= heartbeatMs) {
            const last = steps[steps.length - 1];
            const tail = last ? `${last.actor}.${last.state}` : 'no events yet';
            void input.runRecorder?.append({
              type: 'runtime.heartbeat',
              level: 'debug',
              actId: input.actId,
              data: {
                elapsedSeconds: elapsed,
                lastEvent: tail,
              },
            });
          }
        }, heartbeatMs).unref()
      : null;

  executor.subscribeExecutionEvents(async (event: AgentEvent) => {
    lastEventAt = Date.now();
    const rawProjected: MagicBrowseStepEvent = {
      actor: event.actor,
      state: event.state,
      details: event.data.details,
      ...(event.data.kind ? { kind: event.data.kind } : {}),
      ...(event.data.handoff ? { handoff: event.data.handoff } : {}),
      ...(event.data.blockedReason ? { blockedReason: event.data.blockedReason } : {}),
      ...(event.data.actionName ? { actionName: event.data.actionName } : {}),
      step: event.data.step,
      ...(event.data.maxSteps === undefined ? {} : { maxSteps: event.data.maxSteps }),
      timestamp: event.timestamp,
    };
    const safeProjected = redactMagicBrowseStepEventForOutput(
      rawProjected,
      input.redactionProfiles
    );
    steps.push(safeProjected);
    if (isDebug()) {
      debugJson(
        `[event] ${safeProjected.actor}.${safeProjected.state} step=${safeProjected.step}`,
        safeProjected
      );
    }
    await input.runRecorder?.append({
      type: 'executor.event',
      level: 'info',
      actId: input.actId,
      data: safeProjected,
    });
    actOpts.onEvent?.(safeProjected);
    if (event.actor === Actors.SYSTEM) {
      const projectedStatus = projectSystemEventStatus(event);
      if (projectedStatus) {
        finalStatus = projectedStatus;
        finalMessage = redactFinalMessageForOutput(event.data.details, input.redactionProfiles);
        finalHandoff = redactValueForOutput(event.data.handoff, input.redactionProfiles);
        finalBlockedReason = event.data.blockedReason;
      }
    }
  });

  let executeError: unknown;
  try {
    await executor.execute();
  } catch (error) {
    executeError = error;
  } finally {
    await settleActCleanup(nativeDialog.settle());
    nativeDialog.detach();
    executor.clearExecutionEvents();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    detachBrowserConsole();
    disableDebug();
    if (input.runRecorder) {
      await settleActCleanup(input.runRecorder.flush());
    }
  }

  const blockingDialog = nativeDialog.blockingDialog();
  const deadlineError = isBrowserActionDeadlineError(executeError) ? executeError : undefined;
  let failureClassification: TerminalErrorClassification | undefined;
  if (executeError && !deadlineError && !blockingDialog) {
    // The agent must never surface a raw exception to callers: every terminal
    // failure becomes a structured result the CLI/chat layer can hand over.
    failureClassification = classifyTerminalError(executeError);
    finalStatus = failureClassification.status;
    finalBlockedReason = undefined;
    finalHandoff = undefined;
    finalMessage = redactFinalMessageForOutput(
      failureClassification.message,
      input.redactionProfiles
    );
    await input.runRecorder?.append({
      type: 'act.error',
      level: 'error',
      actId: input.actId,
      data: {
        status: finalStatus,
        ...(failureClassification.failureCode
          ? { failureCode: failureClassification.failureCode }
          : {}),
        message: finalMessage,
      },
    });
  }
  if (deadlineError) {
    finalStatus = deadlineError.code === 'action_timeout' ? 'timed_out' : 'cancelled';
    finalBlockedReason = undefined;
    finalHandoff = undefined;
    finalMessage = deadlineError.message;
  } else if (blockingDialog) {
    finalStatus = 'blocked';
    finalBlockedReason = 'browser_dialog_open';
    finalHandoff = undefined;
    finalMessage = `Browser ${blockingDialog.type} dialog opened during act.`;
  }
  // Event-terminated failures (executor swallowed the error into TASK_FAIL)
  // still deserve a machine-readable cause and retry hint.
  if (!failureClassification && finalStatus === 'failed') {
    const terminalError = executor.getLastTerminalError?.();
    if (terminalError !== undefined) {
      failureClassification = classifyTerminalError(terminalError);
    }
  }
  const handledDialog = nativeDialog.lastDialog();
  let finalUrl = '';
  let activePageIdentity: MagicBrowseActivePageIdentity = {};
  if (!deadlineError) {
    // A dead browser must not turn a structured failure back into a throw.
    try {
      const finalPage = await ctx.getCurrentPuppeteerPage();
      finalUrl = finalPage.url();
      activePageIdentity = await readPageIdentity(finalPage);
    } catch {
      finalUrl = '';
      activePageIdentity = {};
    }
  }
  await settleActCleanup(ctx.cleanup());

  return {
    result: {
      status: finalStatus,
      steps,
      finalUrl,
      finalMessage,
      ...(finalHandoff ? { handoff: finalHandoff } : {}),
      ...(finalBlockedReason ? { blockedReason: finalBlockedReason } : {}),
      ...(failureClassification?.failureCode && finalStatus === 'failed'
        ? { failureCode: failureClassification.failureCode }
        : {}),
      ...(handledDialog ? { dialog: handledDialog } : {}),
      ...(deadlineError
        ? {
            retryable: true as const,
            mutationState: deadlineError.mutationState,
            recovery: deadlineError.recovery,
          }
        : failureClassification?.retryable && finalStatus === 'failed'
          ? { retryable: true as const }
          : {}),
    },
    activePageIdentity,
    agentState: executor.getAgentState(),
  };
}

interface TerminalErrorClassification {
  readonly status: Extract<MagicBrowseActStatus, 'failed' | 'cancelled'>;
  readonly message: string;
  readonly failureCode?: MagicBrowseActFailureCode;
  readonly retryable?: true;
}

/**
 * Map a terminal executor error onto the structured act contract. Provider
 * account errors (payment/auth/forbidden) are hard stops — retrying cannot
 * succeed until the account is fixed — while budget exhaustion and unknown
 * infrastructure errors are worth one retry.
 */
function classifyTerminalError(error: unknown): TerminalErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestCancelledError || isAbortedError(error)) {
    return { status: 'cancelled', message };
  }
  if (error instanceof ChatModelPaymentError) {
    return {
      status: 'failed',
      failureCode: 'llm_provider_payment_required',
      message: `The planning model provider rejected the request as unpaid: ${message}`,
    };
  }
  if (error instanceof ChatModelAuthError) {
    return { status: 'failed', failureCode: 'llm_provider_auth', message };
  }
  if (error instanceof ChatModelForbiddenError) {
    return { status: 'failed', failureCode: 'llm_provider_forbidden', message };
  }
  if (error instanceof ChatModelBadRequestError) {
    return { status: 'failed', failureCode: 'llm_request_invalid', message };
  }
  if (error instanceof MaxFailuresReachedError) {
    return { status: 'failed', failureCode: 'max_failures', message, retryable: true };
  }
  return { status: 'failed', failureCode: 'internal_error', message, retryable: true };
}

export const __testExecuteAct = {
  classifyTerminalError,
};

async function settleActCleanup(task: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(task).then(
    () => undefined,
    () => undefined
  );
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ACT_CLEANUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void settled.catch(() => undefined);
  }
}

function projectSystemEventStatus(event: AgentEvent): MagicBrowseActStatus | undefined {
  if (event.state === ExecutionState.TASK_OK) {
    switch (event.data.kind) {
      case 'system.final_answer':
      case undefined:
        return 'completed';
      case 'system.blocked':
        return 'blocked';
      case 'system.needs_handoff':
        return 'needs_handoff';
      case 'system.needs_approval':
        return 'needs_approval';
      default:
        return 'failed';
    }
  }

  if (event.state === ExecutionState.TASK_FAIL) {
    if (
      event.data.details.includes('maxStepsReached') ||
      event.data.details.includes('Max steps')
    ) {
      return 'max_steps';
    }
    return 'failed';
  }

  if (event.state === ExecutionState.TASK_CANCEL) {
    return 'cancelled';
  }

  return undefined;
}

function resolveActLlms(options: MagicBrowseActOptions): {
  readonly navigatorLlm: NonNullable<MagicBrowseActOptions['llm']>;
  readonly plannerLlm: NonNullable<MagicBrowseActOptions['llm']>;
  readonly navigatorProvider?: string;
  readonly plannerProvider?: string;
} {
  if (options.llm) {
    return {
      navigatorLlm: options.llm,
      plannerLlm: options.llm,
    };
  }

  if (options.llmAdapter) {
    return {
      navigatorLlm: options.llmAdapter.createModel({ role: 'navigator' }),
      plannerLlm: options.llmAdapter.createModel({ role: 'planner' }),
      navigatorProvider: options.llmAdapter.family,
      plannerProvider: options.llmAdapter.family,
    };
  }

  throw new Error(
    'MagicBrowse act requires an explicit llm or llmAdapter. Product CLIs should pass their backend adapter; library users can pass a BaseChatModel or createDirectLlmAdapter(...).'
  );
}

// Baseline scrubbing (truncation, image data URLs, bearer tokens, JWTs, api
// keys) is profile-independent and must cover the whole run, including the
// browsing that happens before any protected value exists. A profile widens
// what is redacted; it never switches redaction on.
function createBrowserStateTextProjector(
  redactionProfiles: ExactValueRedactionProfiles | undefined
): (text: string) => string {
  return (text: string) => redactSensitiveText(text, { redactionProfiles });
}

function resolvePlanningInterval(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_GENERAL_SETTINGS.planningInterval;
  }
  if (!Number.isInteger(requested) || requested < 1 || requested > 50) {
    throw new Error(`Invalid experimentalPlanningInterval: ${requested} (expected integer 1..50)`);
  }
  return requested;
}

function attachBrowserConsoleRecorder(
  page: PuppeteerPage,
  runRecorder: MagicBrowseRunRecorder | undefined,
  actId: string | undefined,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): () => void {
  if (!runRecorder) {
    return () => undefined;
  }

  const onConsole = (message: ConsoleMessage): void => {
    const data = redactValueForOutput(
      {
        type: message.type(),
        text: message.text(),
        location: message.location(),
      },
      redactionProfiles
    );
    void runRecorder.append({
      type: 'browser.console',
      level: mapConsoleLevel(message.type()),
      actId,
      data,
    });
  };

  page.on('console', onConsole);
  return () => {
    page.off('console', onConsole);
  };
}

function redactMagicBrowseStepEventForOutput(
  event: MagicBrowseStepEvent,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseStepEvent {
  return redactValueForOutput(event, redactionProfiles);
}

function redactFinalMessageForOutput(
  message: string,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): string {
  return redactSensitiveText(message, { redactionProfiles });
}

function redactValueForOutput<T>(
  value: T,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): T {
  // `redactSensitiveValue` renders undefined as the literal '[undefined]' for
  // log readability. Nothing here is a log, and an absent optional must stay
  // absent, so short-circuit before that. Undefined carries nothing to redact.
  if (value === undefined) {
    return value;
  }

  return redactSensitiveValue(value, { redactionProfiles }) as T;
}

function mapConsoleLevel(type: string): 'debug' | 'info' | 'warn' | 'error' {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'debug':
    case 'trace':
      return 'debug';
    default:
      return 'info';
  }
}
