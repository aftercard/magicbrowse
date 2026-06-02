import type { Browser, ConsoleMessage, Page as PuppeteerPage } from 'puppeteer-core';

import { disableDebug, debugJson, enableDebugSink, isDebug } from '../adapter/debug.js';
import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import { BrowserContext } from '../browser/browser-context.js';
import { Executor, type ExecutorAgentState } from '../vendor/agent/executor.js';
import { Actors, ExecutionState, type AgentEvent } from '../vendor/agent/event/types.js';
import type {
  MagicBrowseActivePageIdentity,
  MagicBrowseActBlockedReason,
  MagicBrowseActHandoff,
  MagicBrowseActOptions,
  MagicBrowseActResult,
  MagicBrowseActStatus,
  MagicBrowseStepEvent,
  MagicBrowseTrustedRuntimeEvidence,
} from '../types.js';
import { readPageIdentity } from '../transport/page-resolver.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import { attachNativeBrowserDialogGuard } from './native-dialogs.js';
import {
  redactSensitiveText,
  redactSensitiveValue,
  type ExactValueRedactionProfiles,
} from '../redaction.js';

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
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
    },
    generalSettings,
    initialAgentState: input.initialAgentState,
    browserStateTextProjector: createBrowserStateTextProjector(input.redactionProfiles),
    experimentalMemoryHints: actOpts.experimentalMemoryHints,
    trustedRuntimeEvidence: input.trustedRuntimeEvidence,
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
      maxSteps: event.data.maxSteps,
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
        finalMessage = redactFinalMessageForOutput(
          event.data.details,
          input.redactionProfiles
        );
        finalHandoff = redactValueForOutput(
          event.data.handoff,
          input.redactionProfiles
        );
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
    await nativeDialog.settle();
    nativeDialog.detach();
    executor.clearExecutionEvents();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    detachBrowserConsole();
    disableDebug();
    await input.runRecorder?.flush();
  }

  const blockingDialog = nativeDialog.blockingDialog();
  if (executeError && !blockingDialog) {
    throw executeError;
  }
  if (blockingDialog) {
    finalStatus = 'blocked';
    finalBlockedReason = 'browser_dialog_open';
    finalHandoff = undefined;
    finalMessage = `Browser ${blockingDialog.type} dialog opened during act.`;
  }
  const handledDialog = nativeDialog.lastDialog();
  const finalPage = await ctx.getCurrentPuppeteerPage();
  const finalUrl = finalPage.url();
  const activePageIdentity = await readPageIdentity(finalPage);
  await ctx.cleanup();

  return {
    result: {
      status: finalStatus,
      steps,
      finalUrl,
      finalMessage,
      ...(finalHandoff ? { handoff: finalHandoff } : {}),
      ...(finalBlockedReason ? { blockedReason: finalBlockedReason } : {}),
      ...(handledDialog ? { dialog: handledDialog } : {}),
    },
    activePageIdentity,
    agentState: executor.getAgentState(),
  };
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

function createBrowserStateTextProjector(
  redactionProfiles: ExactValueRedactionProfiles | undefined
): ((text: string) => string) | undefined {
  if (!redactionProfiles) {
    return undefined;
  }

  return (text: string) => redactSensitiveText(text, { redactionProfiles });
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
  if (!redactionProfiles) {
    return message;
  }

  return redactSensitiveText(message, { redactionProfiles });
}

function redactValueForOutput<T>(
  value: T,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): T {
  if (!redactionProfiles) {
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
