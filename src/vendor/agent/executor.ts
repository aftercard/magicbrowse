import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  type ActionResult,
  AgentContext,
  type AgentOptions,
  type AgentOutput,
  type BrowserStateTextProjector,
  type CompletionValidationActionResult,
  type CompletionValidationEvidence,
  type CompletionValidationPageIdentity,
} from './types.js';
import { t } from '../../adapter/i18n.js';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator.js';
import {
  PlannerAgent,
  type PlannerBlockedReason,
  type PlannerHandoff,
  type PlannerOutput,
} from './agents/planner.js';
import { NavigatorPrompt } from './prompts/navigator.js';
import { PlannerPrompt } from './prompts/planner.js';
import type { PromptMemoryHints } from './prompts/memory-hints.js';
import { createLogger } from '../../adapter/logger.js';
import MessageManager from './messages/service.js';
import type { BrowserContext } from '../../browser/browser-context.js';
import { ActionBuilder } from './actions/builder.js';
import { EventManager } from './event/manager.js';
import { Actors, type EventCallback, type ExecutionEventKind, EventType, ExecutionState } from './event/types.js';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors.js';
import { URLNotAllowedError } from '../browser/views.js';
import { chatHistoryStore } from '../../adapter/storage-stubs.js';
import type { AgentStepHistory } from './history.js';
import type { GeneralSettingsConfig } from '../../adapter/storage-stubs.js';
import { analytics } from '../../adapter/analytics-stub.js';
import type { MessageManagerSnapshot } from './messages/service.js';
import type { MagicBrowseTrustedRuntimeEvidence } from '../../types.js';

const logger = createLogger('Executor');

export interface ExecutorAgentState {
  readonly tasks: readonly string[];
  readonly messageManager: MessageManagerSnapshot;
}

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  navigatorProvider?: string;
  plannerProvider?: string;
  extractorProvider?: string;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  initialAgentState?: ExecutorAgentState;
  browserStateTextProjector?: BrowserStateTextProjector;
  experimentalMemoryHints?: PromptMemoryHints;
  trustedRuntimeEvidence?: readonly MagicBrowseTrustedRuntimeEvidence[];
}

type PlannerTerminalStatus = Exclude<PlannerOutput['status'], 'continue'>;

type PlannerOutcomeAction =
  | { readonly type: 'continue' }
  | {
      readonly type: 'terminal';
      readonly status: PlannerTerminalStatus;
      readonly finalMessage: string;
      readonly handoff?: PlannerHandoff;
      readonly blockedReason?: PlannerBlockedReason;
      readonly systemEventKind: Extract<
        ExecutionEventKind,
        'system.final_answer' | 'system.blocked' | 'system.needs_handoff' | 'system.needs_approval'
      >;
    };

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
      extraArgs?.browserStateTextProjector,
      extraArgs?.trustedRuntimeEvidence,
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.navigatorPrompt = new NavigatorPrompt(
      context.options.maxActionsPerStep,
      extraArgs?.experimentalMemoryHints?.navigator
    );
    this.plannerPrompt = new PlannerPrompt(extraArgs?.experimentalMemoryHints?.planner);

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
      provider: extraArgs?.navigatorProvider,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
      provider: extraArgs?.plannerProvider,
    });

    this.context = context;
    if (extraArgs?.initialAgentState) {
      this.context.messageManager.restoreSnapshot(extraArgs.initialAgentState.messageManager);
      this.tasks = [...extraArgs.initialAgentState.tasks];
      this.addFollowUpTask(task);
    } else {
      this.tasks.push(task);
      this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
    }
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  getAgentState(): ExecutorAgentState {
    return {
      tasks: [...this.tasks],
      messageManager: this.context.messageManager.snapshot(),
    };
  }

  private handlePlannerOutcome(planOutput: AgentOutput<PlannerOutput> | null): PlannerOutcomeAction {
    const result = planOutput?.result;
    if (!result || result.status === 'continue') {
      return { type: 'continue' };
    }

    logger.info(`Planner returned terminal outcome: ${result.status}`);
    this.context.finalAnswer = result.final_answer;
    return {
      type: 'terminal',
      status: result.status,
      finalMessage: result.final_answer,
      ...(result.status === 'needs_handoff' ? { handoff: result.handoff } : {}),
      ...(result.status === 'blocked' ? { blockedReason: result.blockedReason } : {}),
      systemEventKind: systemEventKindForPlannerStatus(result.status),
    };
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;
      let terminalOutcome: Extract<PlannerOutcomeAction, { readonly type: 'terminal' }> | null = null;

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          const isCompletionValidationPass = navigatorDone;
          if (isCompletionValidationPass) {
            context.completionValidationEvidence = this.buildCompletionValidationEvidence();
          }
          navigatorDone = false;
          try {
            latestPlanOutput = await this.runPlanner();
          } finally {
            if (isCompletionValidationPass) {
              this.removeTransientStateMessage();
              context.completionValidationEvidence = null;
            }
          }

          const plannerOutcome = this.handlePlannerOutcome(latestPlanOutput);
          if (plannerOutcome.type === 'terminal') {
            terminalOutcome = plannerOutcome;
            this.removeTransientStateMessage();
            break;
          }
        }

        navigatorDone = await this.navigate();
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      if (terminalOutcome) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, terminalOutcome.finalMessage, {
          kind: terminalOutcome.systemEventKind,
          ...(terminalOutcome.handoff ? { handoff: terminalOutcome.handoff } : {}),
          ...(terminalOutcome.blockedReason ? { blockedReason: terminalOutcome.blockedReason } : {}),
        });

        if (terminalOutcome.status === 'completed') {
          void analytics.trackTaskComplete(this.context.taskId);
        }
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(t('exec_errors_maxStepsReached'));
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        // Note: We don't track pause as it's not a final state
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
      }
    } finally {
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      }
    }
  }

  /**
   * Run the planner and insert its plan into the message history.
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      await this.navigator.addStateMessageToMemory();
      const positionForPlan = this.context.messageManager.length() - 1;

      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private removeTransientStateMessage(): void {
    if (!this.context.stateMessageAdded) {
      return;
    }
    this.context.messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private buildCompletionValidationEvidence(): CompletionValidationEvidence {
    const previousPageIdentity = clonePageIdentity(this.context.lastNavigatorPreviousPageIdentity);
    return {
      trigger: 'navigator_requested_done',
      navigatorRequestedDone: true,
      step: this.context.nSteps,
      lastActionNames: [...this.context.lastNavigatorActionNames],
      actionResults: this.buildCompletionValidationActionResults(this.context.actionResults),
      ...(previousPageIdentity ? { previousPageIdentity } : {}),
      currentStateNote: 'Use the current browser state in this same message as the post-action state.',
    };
  }

  private buildCompletionValidationActionResults(
    actionResults: readonly ActionResult[],
  ): CompletionValidationActionResult[] {
    const evidenceResults: CompletionValidationActionResult[] = [];

    for (const result of actionResults) {
      if (result.extractedContent) {
        evidenceResults.push({
          kind: 'result',
          text: result.extractedContent,
        });
      }

      if (result.error) {
        const errorText = result.error.toString().trim();
        evidenceResults.push({
          kind: 'error',
          text: errorText.split('\n').pop() || errorText,
        });
      }
    }

    return evidenceResults;
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}

function systemEventKindForPlannerStatus(
  status: PlannerTerminalStatus
): Extract<
  ExecutionEventKind,
  'system.final_answer' | 'system.blocked' | 'system.needs_handoff' | 'system.needs_approval'
> {
  switch (status) {
    case 'completed':
      return 'system.final_answer';
    case 'blocked':
      return 'system.blocked';
    case 'needs_handoff':
      return 'system.needs_handoff';
    case 'needs_approval':
      return 'system.needs_approval';
  }
}

function clonePageIdentity(
  identity: CompletionValidationPageIdentity | null | undefined,
): CompletionValidationPageIdentity | null {
  if (!identity?.url && !identity?.title) {
    return null;
  }
  return {
    ...(identity.url ? { url: identity.url } : {}),
    ...(identity.title ? { title: identity.title } : {}),
  };
}
