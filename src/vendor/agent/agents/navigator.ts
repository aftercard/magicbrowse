import { z } from 'zod';
import { debugJson, isDebug, debugWrite } from '../../../adapter/debug.js';
import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base.js';
import { createLogger } from '../../../adapter/logger.js';
import { ActionResult, type AgentOutput } from '../types.js';
import type { Action } from '../actions/builder.js';
import { buildDynamicActionSchema } from '../actions/builder.js';
import { agentBrainSchema } from '../types.js';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Actors, ExecutionState } from '../event/types.js';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ChatModelPaymentError,
  EXTENSION_CONFLICT_ERROR_MESSAGE,
  ExtensionConflictError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isExtensionConflictError,
  isForbiddenError,
  isProviderPaymentError,
  ResponseParseError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RepeatedStaleTargetError,
  RequestCancelledError,
} from './errors.js';
import { calcBranchPathHashSet, type DOMElementNode } from '../../browser/dom/views.js';
import { type BrowserState, BrowserStateHistory, URLNotAllowedError } from '../../browser/views.js';
import { convertZodToJsonSchema, repairJsonString } from '../../utils.js';
import { HistoryTreeProcessor } from '../../browser/dom/history/service.js';
import { AgentStepRecord } from '../history.js';
import { type DOMHistoryElement } from '../../browser/dom/history/view.js';
import {
  isBrowserActionDeadlineError,
  runWithBrowserActionDeadline,
  waitForAbortableDelay,
} from '../../../runtime/browser-action-deadline.js';
import {
  createTargetObservationLease,
  validateTargetObservationLease,
} from '../../../resolution/target-observation-lease.js';
import {
  createActionTargetDescriptor,
  createMemoryFieldTargetDescriptor,
} from '../../../resolution/targets.js';

const logger = createLogger('NavigatorAgent');

const BLOCKING_PAGE_PATTERNS = [
  /unusual traffic/i,
  /automated (queries|requests|traffic)/i,
  /sorry/i,
  // Deferred: captcha detection needs structured confidence before it can feed planner/debug signals.
  // /captcha/i,
  // /not a robot/i,
  /blocked/i,
];

interface ParsedModelOutput {
  current_state?: {
    next_goal?: string;
  };
  action?: (Record<string, unknown> | null)[] | null;
}

type BrowserActionAttemptResult =
  | {
      readonly status: 'completed';
      readonly result: ActionResult;
      readonly indexArg: number | null;
    }
  | {
      readonly status: 'sequence_stopped';
      readonly result: ActionResult;
    };

interface StaleTargetRefusal {
  readonly key: string;
  readonly count: number;
}

type IndexedTargetCheck =
  | { readonly status: 'matched' }
  | {
      readonly status: 'stale';
      readonly message: string;
      readonly refusalKey: string | null;
    };

class StaleTargetRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleTargetRefusalError';
  }
}

interface ActionabilitySignature {
  readonly tagName: string | null;
  readonly xpath: string | null;
  readonly branchPath: readonly string[];
  readonly disabled: boolean;
  readonly readonly: boolean;
  readonly ariaDisabled: string | null;
  readonly inert: boolean;
  readonly hidden: boolean;
  readonly isInteractive: boolean;
  readonly highlightIndex: number | null;
}

const ACTIONABILITY_CHANGED_MESSAGE = 'Page actionability changed after action; re-observe before continuing.';
const NATIVE_SELECT_MUTATION_MESSAGE =
  'Native dropdown selection may have changed page state; re-observe before dependent actions.';

export class NavigatorActionRegistry {
  private actions: Record<string, Action> = {};

  constructor(actions: Action[]) {
    for (const action of actions) {
      this.registerAction(action);
    }
  }

  registerAction(action: Action): void {
    this.actions[action.name()] = action;
  }

  unregisterAction(name: string): void {
    delete this.actions[name];
  }

  getAction(name: string): Action | undefined {
    return this.actions[name];
  }

  setupModelOutputSchema(): z.ZodType {
    const actionSchema = buildDynamicActionSchema(Object.values(this.actions));
    return z.object({
      current_state: agentBrainSchema,
      action: z.array(actionSchema),
    });
  }
}

function sameActionabilitySignature(left: ActionabilitySignature, right: ActionabilitySignature): boolean {
  return (
    left.tagName === right.tagName &&
    left.xpath === right.xpath &&
    sameStringArray(left.branchPath, right.branchPath) &&
    left.disabled === right.disabled &&
    left.readonly === right.readonly &&
    left.ariaDisabled === right.ariaDisabled &&
    left.inert === right.inert &&
    left.hidden === right.hidden &&
    left.isInteractive === right.isInteractive &&
    left.highlightIndex === right.highlightIndex
  );
}

function actionabilityBranchPath(element: DOMElementNode): string[] {
  const path: string[] = [];
  let current = element.parent;
  while (current) {
    path.unshift(`${normalizeNullableString(current.tagName) ?? ''}:${normalizeNullableString(current.xpath) ?? ''}`);
    current = current.parent;
  }
  return path;
}

function hasBooleanAttribute(attributes: Readonly<Record<string, string>>, name: string): boolean {
  const value = attributes[name];
  return value !== undefined && value !== 'false';
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

export interface NavigatorResult {
  done: boolean;
}

export class NavigatorAgent extends BaseAgent<z.ZodType, NavigatorResult> {
  private actionRegistry: NavigatorActionRegistry;
  private jsonSchema: Record<string, unknown>;
  private _stateHistory: BrowserStateHistory | null = null;
  private staleTargetRefusal: StaleTargetRefusal | null = null;

  constructor(
    actionRegistry: NavigatorActionRegistry,
    options: BaseAgentOptions,
    extraOptions?: Partial<ExtraAgentOptions>,
  ) {
    super(actionRegistry.setupModelOutputSchema(), options, { ...extraOptions, id: 'navigator' });

    this.actionRegistry = actionRegistry;

    // The zod object is too complex to be used directly, so we need to convert it to json schema first for the model to use
    this.jsonSchema = convertZodToJsonSchema(this.modelOutputSchema, 'NavigatorAgentOutput', true);
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      const structuredLlm = this.chatLLM.withStructuredOutput(this.jsonSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });
        if (isDebug()) {
          debugJson(`[llm-output.raw] agent=${this.id} model=${this.modelName}`, response.raw);
          debugJson(`[llm-output.parsed] agent=${this.id} model=${this.modelName}`, response.parsed);
        }

        if (response.parsed) {
          return this.validateModelOutput(response.parsed);
        }
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from markdown code blocks if parsing failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          errorMessage.includes('is not valid JSON') &&
          response?.raw?.content &&
          typeof response.raw.content === 'string'
        ) {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            if (isDebug()) {
              debugJson(`[llm-output.parsed-after-repair] agent=${this.id} model=${this.modelName}`, parsed);
            }
            return parsed;
          }
        }
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }

      // Use type assertion to access the properties
      const rawResponse = response.raw as BaseMessage & {
        tool_calls?: Array<{
          args: {
            currentState: typeof agentBrainSchema._type;
            action: z.infer<ReturnType<typeof buildDynamicActionSchema>>;
          };
        }>;
      };

      // sometimes LLM returns an empty content, but with one or more tool calls, so we need to check the tool calls
      if (rawResponse.tool_calls && rawResponse.tool_calls.length > 0) {
        logger.info('Navigator structuredLlm tool call with empty content', rawResponse.tool_calls);
        if (isDebug()) {
          debugJson(`[llm-output.tool-calls] agent=${this.id} model=${this.modelName}`, rawResponse.tool_calls);
        }
        // only use the first tool call
        const toolCall = rawResponse.tool_calls[0];
        return {
          current_state: toolCall.args.currentState,
          action: [...toolCall.args.action],
        };
      }
      throw new ResponseParseError('Could not parse navigator response');
    }

    // Fallback to parent class manual JSON extraction for models without structured output support
    return super.invoke(inputMessages);
  }

  async execute(): Promise<AgentOutput<NavigatorResult>> {
    const agentOutput: AgentOutput<NavigatorResult> = {
      id: this.id,
    };

    let cancelled = false;
    let modelOutputString: string | null = null;
    let browserStateHistory: BrowserStateHistory | null = null;
    let actionResults: ActionResult[] = [];

    try {
      this.context.controller.signal.throwIfAborted();
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...');
      this.context.lastNavigatorActionNames = [];
      this.context.lastNavigatorPreviousPageIdentity = null;

      const messageManager = this.context.messageManager;
      // Observation phase — DOM scene capture via buildDomTree.
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OBSERVE_START, 'Capturing page state');
      await this.addStateMessageToMemory();
      this.context.controller.signal.throwIfAborted();
      const currentState = await this.context.browserContext.getCachedState();
      this.context.controller.signal.throwIfAborted();
      this.context.lastNavigatorPreviousPageIdentity = {
        url: currentState.url,
        title: currentState.title,
      };
      browserStateHistory = new BrowserStateHistory(currentState);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OBSERVE_OK,
        `${currentState.selectorMap.size} elements, ${currentState.tabs.length} tabs`);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      // Thinking phase — LLM call for next action(s).
      const inputMessages = messageManager.getMessages();
      const inputTokens = messageManager.getTotalTokens();
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_THINK_START,
        `Calling LLM with ${inputMessages.length} messages, ~${inputTokens} tokens`);
      if (isDebug()) {
        const last = inputMessages[inputMessages.length - 1];
        const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
        debugWrite(`[state-dump] step=${this.context.nSteps}, last message:\n---\n${content}\n---`);
      }
      const modelOutput = await this.invoke(inputMessages);
      this.context.controller.signal.throwIfAborted();
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_THINK_OK,
        `${modelOutput.action?.length ?? 0} action(s)`);

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }

      const actions = this.fixActions(modelOutput);
      modelOutput.action = actions;
      this.context.lastNavigatorActionNames = actions
        .map(action => Object.keys(action)[0])
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
      modelOutputString = JSON.stringify(modelOutput);
      if (isDebug()) {
        debugJson(`[navigator-output.fixed] step=${this.context.nSteps}`, modelOutput);
        debugJson(`[navigator-actions] step=${this.context.nSteps}`, actions);
      }

      // remove the last state message from memory before adding the model output
      this.removeLastStateMessageFromMemory();
      this.addModelOutputToMemory(modelOutput);

      // take the actions
      actionResults = await this.doMultiAction(actions, currentState);
      this.context.controller.signal.throwIfAborted();
      // logger.info('Action results', JSON.stringify(actionResults, null, 2));

      this.context.actionResults = actionResults;

      // check if the task is paused or stopped
      if (this.context.paused || this.context.stopped) {
        cancelled = true;
        return agentOutput;
      }
      // emit event
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, 'Navigation done');
      let done = false;
      if (actionResults.length > 0 && actionResults[actionResults.length - 1].isDone) {
        done = true;
      }
      agentOutput.result = { done };
      return agentOutput;
    } catch (error) {
      this.removeLastStateMessageFromMemory();
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Check if this is an authentication error
      if (error instanceof RepeatedStaleTargetError) {
        throw error;
      } else if (isProviderPaymentError(error)) {
        throw new ChatModelPaymentError(errorMessage, error);
      } else if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isBrowserActionDeadlineError(error)) {
        throw error;
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isExtensionConflictError(error)) {
        throw new ExtensionConflictError(EXTENSION_CONFLICT_ERROR_MESSAGE, error);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      } else if (error instanceof URLNotAllowedError) {
        throw error;
      }

      const errorString = `Navigation failed: ${errorMessage}`;
      logger.error(errorString);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, errorString);
      agentOutput.error = errorMessage;
      return agentOutput;
    } finally {
      // if the task is cancelled, remove the last state message from memory and emit event
      if (cancelled) {
        this.removeLastStateMessageFromMemory();
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_CANCEL, 'Navigation cancelled');
      }
      if (browserStateHistory) {
        // Create a copy of actionResults to store in history
        const actionResultsCopy = actionResults.map(result => {
          return new ActionResult({
            isDone: result.isDone,
            success: result.success,
            extractedContent: result.extractedContent,
            error: result.error,
            includeInMemory: result.includeInMemory,
            interactedElement: result.interactedElement,
          });
        });

        const history = new AgentStepRecord(modelOutputString, actionResultsCopy, browserStateHistory);
        this.context.history.history.push(history);

        // logger.info('All history', JSON.stringify(this.context.history, null, 2));
      }
    }
  }

  /**
   * Add the state message to the memory
   */
  public async addStateMessageToMemory() {
    if (this.context.stateMessageAdded) {
      return;
    }

    const messageManager = this.context.messageManager;
    // Handle results that should be included in memory
    if (this.context.actionResults.length > 0) {
      let index = 0;
      for (const r of this.context.actionResults) {
        if (r.includeInMemory) {
          if (r.extractedContent) {
            const msg = new HumanMessage(this.projectActionMemoryText(`Action result: ${r.extractedContent}`));
            // logger.info('Adding action result to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          if (r.error) {
            // Get error text and convert to string
            const errorText = r.error.toString().trim();

            // Get only the last line of the error
            const lastLine = errorText.split('\n').pop() || '';

            const msg = new HumanMessage(this.projectActionMemoryText(`Action error: ${lastLine}`));
            logger.info('Adding action error to memory', msg.content);
            messageManager.addMessageWithTokens(msg);
          }
          // reset this action result to empty, we dont want to add it again in the state message
          // NOTE: in python version, all action results are reset to empty, but in ts version, only those included in memory are reset to empty
          this.context.actionResults[index] = new ActionResult();
        }
        index++;
      }
    }

    const state = await this.prompt.getUserMessage(this.context);
    messageManager.addStateMessage(state);
    this.context.completionValidationEvidence = null;
    this.context.stateMessageAdded = true;
  }

  private projectActionMemoryText(text: string): string {
    return this.context.browserStateTextProjector?.(text) ?? text;
  }

  /**
   * Remove the last state message from the memory
   */
  protected async removeLastStateMessageFromMemory() {
    if (!this.context.stateMessageAdded) return;
    const messageManager = this.context.messageManager;
    messageManager.removeLastStateMessage();
    this.context.stateMessageAdded = false;
  }

  private async addModelOutputToMemory(modelOutput: this['ModelOutput']) {
    const messageManager = this.context.messageManager;
    messageManager.addModelOutput(modelOutput);
  }

  /**
   * Fix the actions to be an array of objects, sometimes the action is a string or an object
   * @param response
   * @returns
   */
  private fixActions(response: this['ModelOutput']): Record<string, unknown>[] {
    let actions: Record<string, unknown>[] = [];
    if (Array.isArray(response.action)) {
      // if the item is null, skip it
      actions = response.action.filter((item: unknown) => item !== null);
      if (actions.length === 0) {
        logger.warning('No valid actions found', response.action);
      }
    } else if (typeof response.action === 'string') {
      try {
        logger.warning('Unexpected action format', response.action);
        // First try to parse the action string directly
        actions = JSON.parse(response.action);
      } catch (parseError) {
        try {
          // If direct parsing fails, try to fix the JSON first
          const fixedAction = repairJsonString(response.action);
          logger.info('Fixed action string', fixedAction);
          actions = JSON.parse(fixedAction);
        } catch (error) {
          logger.error('Invalid action format even after repair attempt', response.action);
          throw new Error('Invalid action output format');
        }
      }
    } else {
      // if the action is neither an array nor a string, it should be an object
      actions = [response.action];
    }
    return actions;
  }

  private async doMultiAction(
    actions: Record<string, unknown>[],
    observedBrowserState: BrowserState,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    let errCount = 0;
    logger.info('Actions', actions);

    const browserContext = this.context.browserContext;
    if (actions.length === 0) {
      this.resetStaleTargetRefusal();
    }
    this.context.controller.signal.throwIfAborted();
    const cachedPathHashes = await calcBranchPathHashSet(observedBrowserState);
    this.context.controller.signal.throwIfAborted();
    if (isDebug()) {
      debugWrite(
        `[action-sequence.start] step=${this.context.nSteps} actionCount=${actions.length} ` +
          `url=${observedBrowserState.url} title=${observedBrowserState.title} selectors=${observedBrowserState.selectorMap.size}`,
      );
      debugJson(`[action-sequence.actions] step=${this.context.nSteps}`, actions);
    }

    await browserContext.removeHighlight();
    this.context.controller.signal.throwIfAborted();

    for (const [i, action] of actions.entries()) {
      const actionName = Object.keys(action)[0];
      const actionArgs = action[actionName];
      try {
        this.context.controller.signal.throwIfAborted();
        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }

        const actionInstance = this.actionRegistry.getAction(actionName);
        if (actionInstance === undefined) {
          throw new Error(`Action ${actionName} not exists`);
        }

        const indexArg = actionInstance.getIndexArg(actionArgs);
        if (isDebug()) {
          const plannedElement = indexArg !== null ? observedBrowserState.selectorMap.get(indexArg) ?? null : null;
          debugJson(`[action.start] step=${this.context.nSteps} action=${i + 1}/${actions.length}`, {
            name: actionName,
            args: actionArgs,
            index: indexArg,
            plannedElement: this.debugSummarizeElement(plannedElement),
          });
        }
        const attempt = await this.executeActionAttempt({
          actionInstance,
          actionName,
          actionArgs,
          actionIndex: i,
          actionCount: actions.length,
          indexArg,
          observedBrowserState,
          cachedPathHashes,
        });
        this.context.controller.signal.throwIfAborted();
        if (attempt.status === 'sequence_stopped') {
          results.push(attempt.result);
          break;
        }
        const { result } = attempt;
        if (isDebug()) {
          debugJson(`[action.result] step=${this.context.nSteps} action=${i + 1}/${actions.length}`, {
            name: actionName,
            index: indexArg,
            success: result.success,
            isDone: result.isDone,
            includeInMemory: result.includeInMemory,
            extractedContent: result.extractedContent,
            error: result.error,
          });
          await this.debugWritePostActionState(actionName, i + 1, actions.length);
          this.context.controller.signal.throwIfAborted();
        }

        // if the action has an index argument, record the interacted element to the result
        if (indexArg !== null) {
          const domElement = observedBrowserState.selectorMap.get(indexArg);
          if (domElement) {
            const interactedElement = HistoryTreeProcessor.convertDomElementToHistoryElement(domElement);
            result.interactedElement = interactedElement;
            logger.info('Interacted element', interactedElement);
            logger.info('Result', result);
          }
        }
        results.push(result);

        if (
          actionName === 'select_dropdown_option' &&
          result.error === null &&
          this.hasRemainingIndexedActions(actions, i)
        ) {
          logger.info(NATIVE_SELECT_MUTATION_MESSAGE);
          if (isDebug()) {
            debugWrite(
              `[action.sequence-stop] step=${this.context.nSteps} reason=native_select_mutation_boundary`,
            );
            await this.debugWritePostActionState('native-select-mutation-boundary', i + 1, actions.length);
            this.context.controller.signal.throwIfAborted();
          }
          results.push(
            new ActionResult({
              extractedContent: NATIVE_SELECT_MUTATION_MESSAGE,
              includeInMemory: true,
            }),
          );
          break;
        }

        // check if the task is paused or stopped
        if (this.context.paused || this.context.stopped) {
          return results;
        }
        // TODO: wait for 1 second for now, need to optimize this to avoid unnecessary waiting
        await waitForAbortableDelay(1000, this.context.controller.signal);
      } catch (error) {
        if (error instanceof RepeatedStaleTargetError) {
          throw error;
        }
        if (!(error instanceof StaleTargetRefusalError)) {
          this.resetStaleTargetRefusal();
        }
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          'doAction error',
          actionName,
          JSON.stringify(actionArgs, null, 2),
          JSON.stringify(errorMessage, null, 2),
        );
        // unexpected error, emit event
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMessage, {
          actionName,
        });
        if (isBrowserActionDeadlineError(error)) {
          throw error;
        }
        if (isDebug()) {
          debugJson(`[action.error] step=${this.context.nSteps} action=${i + 1}/${actions.length}`, {
            name: actionName,
            args: actionArgs,
            error: errorMessage,
          });
          await this.debugWritePostActionState(`${actionName}:error`, i + 1, actions.length);
        }
        errCount++;
        if (errCount > 3) {
          throw new Error('Too many errors in actions');
        }
        results.push(
          new ActionResult({
            error: errorMessage,
            isDone: false,
            includeInMemory: true,
          }),
        );
      }
    }
    return results;
  }

  private async executeActionAttempt(input: {
    readonly actionInstance: Action;
    readonly actionName: string;
    readonly actionArgs: unknown;
    readonly actionIndex: number;
    readonly actionCount: number;
    readonly indexArg: number | null;
    readonly observedBrowserState: BrowserState;
    readonly cachedPathHashes: ReadonlySet<string>;
  }): Promise<BrowserActionAttemptResult> {
    const execute = async (signal?: AbortSignal): Promise<BrowserActionAttemptResult> => {
      signal?.throwIfAborted();
      let currentStateForAction: BrowserState | null = null;
      if (input.indexArg !== null) {
        currentStateForAction = await this.context.browserContext.getState(
          this.context.options.useVision
        );
        signal?.throwIfAborted();
      }
      if (input.actionIndex > 0 && input.indexArg !== null) {
        const newState =
          currentStateForAction ??
          (await this.context.browserContext.getState(this.context.options.useVision));
        signal?.throwIfAborted();
        const newPathHashes = await calcBranchPathHashSet(newState);
        if (isDebug()) {
          debugJson(
            `[action.preflight] step=${this.context.nSteps} action=${input.actionIndex + 1}/${input.actionCount}`,
            {
              name: input.actionName,
              index: input.indexArg,
              currentSelectorCount: newState.selectorMap.size,
              currentElement: this.debugSummarizeElement(
                newState.selectorMap.get(input.indexArg) ?? null
              ),
            }
          );
        }
        const observedElement =
          input.observedBrowserState.selectorMap.get(input.indexArg) ?? null;
        const currentElement = newState.selectorMap.get(input.indexArg) ?? null;
        if (this.indexedActionabilityChanged(observedElement, currentElement)) {
          this.resetStaleTargetRefusal();
          logger.info(ACTIONABILITY_CHANGED_MESSAGE);
          if (isDebug()) {
            debugWrite(
              `[action.sequence-stop] step=${this.context.nSteps} reason=${ACTIONABILITY_CHANGED_MESSAGE}`
            );
            debugJson(`[action.actionability-signature] step=${this.context.nSteps}`, {
              observed: observedElement ? this.actionabilitySignature(observedElement) : null,
              current: currentElement ? this.actionabilitySignature(currentElement) : null,
            });
            this.debugWriteStateSnapshot('sequence-stop-after-actionability-change', newState);
          }
          return {
            status: 'sequence_stopped',
            result: new ActionResult({
              extractedContent: ACTIONABILITY_CHANGED_MESSAGE,
              includeInMemory: true,
            }),
          };
        }

        for (const hash of newPathHashes) {
          if (!input.cachedPathHashes.has(hash)) {
            this.resetStaleTargetRefusal();
            const message = `Something new appeared after action ${input.actionIndex} / ${input.actionCount}`;
            logger.info(message);
            if (isDebug()) {
              debugWrite(
                `[action.sequence-stop] step=${this.context.nSteps} reason=${message}`
              );
              this.debugWriteStateSnapshot('sequence-stop-after-new-elements', newState);
            }
            return {
              status: 'sequence_stopped',
              result: new ActionResult({
                extractedContent: message,
                includeInMemory: true,
              }),
            };
          }
        }
      }
      if (input.indexArg !== null && currentStateForAction) {
        const targetCheck = await this.checkIndexedActionTargetStillMatchesObservedState(
          input.indexArg,
          input.actionName,
          input.observedBrowserState,
          currentStateForAction
        );
        if (targetCheck.status === 'stale') {
          if (this.recordStaleTargetRefusal(targetCheck.refusalKey)) {
            throw new RepeatedStaleTargetError();
          }
          throw new StaleTargetRefusalError(targetCheck.message);
        }
        this.resetStaleTargetRefusal();
        signal?.throwIfAborted();
      } else {
        this.resetStaleTargetRefusal();
      }

      const result = await input.actionInstance.call(input.actionArgs);
      signal?.throwIfAborted();
      if (result === undefined) {
        throw new Error(`Action ${input.actionName} returned undefined`);
      }
      return { status: 'completed', result, indexArg: input.indexArg };
    };

    if (input.actionInstance.deadlinePolicy === 'none') {
      return execute(this.context.controller.signal);
    }

    return runWithBrowserActionDeadline(execute, {
      actionName: input.actionName,
      timeoutMs: this.context.options.browserActionTimeoutMs,
      signal: this.context.controller.signal,
      cancel: (error) => this.context.cancelPendingBrowserOperations(error),
    });
  }

  private hasRemainingIndexedActions(actions: readonly Record<string, unknown>[], currentIndex: number): boolean {
    for (const action of actions.slice(currentIndex + 1)) {
      const actionName = Object.keys(action)[0];
      if (!actionName) {
        continue;
      }
      const actionInstance = this.actionRegistry.getAction(actionName);
      if (!actionInstance) {
        continue;
      }
      if (actionInstance.getIndexArg(action[actionName]) !== null) {
        return true;
      }
    }
    return false;
  }

  private async checkIndexedActionTargetStillMatchesObservedState(
    index: number,
    actionName: string,
    observedState: BrowserState,
    currentState: BrowserState,
  ): Promise<IndexedTargetCheck> {
    const observedElement = observedState.selectorMap.get(index);
    if (!observedElement) {
      return {
        status: 'stale',
        message: `Element ${index} did not exist in observed browser state`,
        refusalKey: null,
      };
    }

    const currentElement = currentState.selectorMap.get(index);
    if (!currentElement) {
      return {
        status: 'stale',
        message: `Element ${index} no longer exists`,
        refusalKey: this.physicalTargetRefusalKey(observedState, actionName, observedElement),
      };
    }

    const observedHistoryElement = HistoryTreeProcessor.convertDomElementToHistoryElement(observedElement);
    const isSameTarget = await HistoryTreeProcessor.compareHistoryElementAndDomElement(
      observedHistoryElement,
      currentElement,
    );
    if (!isSameTarget) {
      return {
        status: 'stale',
        message: `Element ${index} no longer matches the observed target`,
        refusalKey: this.physicalTargetRefusalKey(observedState, actionName, observedElement),
      };
    }
    const action = navigatorLeaseAction(actionName);
    if (action) {
      const observedDescriptor =
        action === 'click'
          ? createActionTargetDescriptor({ state: observedState, element: observedElement, selectorMapIndex: index })
          : createMemoryFieldTargetDescriptor({ state: observedState, element: observedElement, selectorMapIndex: index });
      const currentDescriptor =
        action === 'click'
          ? createActionTargetDescriptor({ state: currentState, element: currentElement, selectorMapIndex: index })
          : createMemoryFieldTargetDescriptor({ state: currentState, element: currentElement, selectorMapIndex: index });
      const lease = observedDescriptor
        ? createTargetObservationLease({
            state: observedState,
            element: observedElement,
            descriptor: observedDescriptor,
            action,
            observationRef: `navigator:${this.context.nSteps}`,
          })
        : undefined;
      const frame = lease
        ? currentState.formMutationFrames?.find(
            (candidate) => candidate.checkpoint?.documentRef === lease.documentRef,
          )
        : undefined;
      const validation =
        lease && currentDescriptor
          ? validateTargetObservationLease({
              lease,
              currentElement,
              currentDescriptor,
              action,
              mutationWindow:
                frame?.checkpoint && !frame.missing
                  ? {
                      checkpoint: frame.checkpoint,
                      summaries: frame.summaries,
                      coverageAvailable: frame.coverageAvailable,
                    }
                  : undefined,
            })
          : { status: 'blocked' as const, cause: 'mutation_history_unavailable' as const };
      if (validation.status === 'blocked') {
        return {
          status: 'stale',
          message: `Element ${index} mutation authority expired; re-observe before acting`,
          refusalKey: this.physicalTargetRefusalKey(observedState, actionName, observedElement),
        };
      }
    }
    return { status: 'matched' };
  }

  private physicalTargetRefusalKey(
    state: BrowserState,
    actionName: string,
    element: DOMElementNode,
  ): string | null {
    const nodeIds: string[] = [];
    let current: DOMElementNode | null = element;
    while (current) {
      const nodeId = current.internalNodeId?.trim();
      if (!nodeId) {
        return null;
      }
      nodeIds.unshift(nodeId);
      current = current.parent;
    }
    return JSON.stringify([state.tabId, state.url, actionName, nodeIds]);
  }

  private recordStaleTargetRefusal(refusalKey: string | null): boolean {
    if (refusalKey === null) {
      this.resetStaleTargetRefusal();
      return false;
    }

    if (this.staleTargetRefusal?.key !== refusalKey) {
      this.staleTargetRefusal = { key: refusalKey, count: 1 };
      return false;
    }

    const count = this.staleTargetRefusal.count + 1;
    this.staleTargetRefusal = { key: refusalKey, count };
    return count >= 2;
  }

  private resetStaleTargetRefusal(): void {
    this.staleTargetRefusal = null;
  }

  private indexedActionabilityChanged(
    observedElement: DOMElementNode | null,
    currentElement: DOMElementNode | null,
  ): boolean {
    if (!observedElement || !currentElement) {
      return observedElement !== currentElement;
    }
    return !sameActionabilitySignature(
      this.actionabilitySignature(observedElement),
      this.actionabilitySignature(currentElement),
    );
  }

  private actionabilitySignature(element: DOMElementNode): ActionabilitySignature {
    const attributes = element.attributes;
    return {
      tagName: normalizeNullableString(element.tagName),
      xpath: normalizeNullableString(element.xpath),
      branchPath: actionabilityBranchPath(element),
      disabled: hasBooleanAttribute(attributes, 'disabled'),
      readonly: hasBooleanAttribute(attributes, 'readonly') || attributes['aria-readonly'] === 'true',
      ariaDisabled: attributes['aria-disabled'] ?? null,
      inert: hasBooleanAttribute(attributes, 'inert'),
      hidden: hasBooleanAttribute(attributes, 'hidden') || attributes['aria-hidden'] === 'true',
      isInteractive: element.isInteractive,
      highlightIndex: element.highlightIndex,
    };
  }

  private debugSummarizeElement(element: DOMElementNode | null): Record<string, unknown> | null {
    if (!element) return null;
    let text = '';
    try {
      text = element.getAllTextTillNextClickableElement(2);
    } catch {
      text = '';
    }
    return {
      index: element.highlightIndex,
      tagName: element.tagName,
      xpath: element.xpath,
      attributes: element.attributes,
      text: text.length > 500 ? `${text.slice(0, 500)}...` : text,
    };
  }

  private debugDetectBlockingSignals(text: string): string[] {
    return BLOCKING_PAGE_PATTERNS
      .filter(pattern => pattern.test(text))
      .map(pattern => pattern.source);
  }

  private debugWriteStateSnapshot(label: string, state: BrowserState): void {
    if (!isDebug()) return;
    const elementsText = state.elementTree.clickableElementsToString(this.context.options.includeAttributes);
    const haystack = `${state.url}\n${state.title}\n${elementsText}`;
    const blockingSignals = this.debugDetectBlockingSignals(haystack);
    debugJson(`[state-snapshot.meta] ${label} step=${this.context.nSteps}`, {
      url: state.url,
      title: state.title,
      selectorCount: state.selectorMap.size,
      scrollY: state.scrollY,
      scrollHeight: state.scrollHeight,
      visualViewportHeight: state.visualViewportHeight,
      tabs: state.tabs,
      blockingSignals,
    });
    if (blockingSignals.length > 0) {
      debugWrite(`[state-snapshot.blocking-signal] ${label} patterns=${blockingSignals.join(', ')}`);
    }
    debugWrite(`[state-snapshot.elements] ${label} step=${this.context.nSteps}\n---\n${elementsText}\n---`);
  }

  private async debugWritePostActionState(actionName: string, ordinal: number, total: number): Promise<void> {
    if (!isDebug()) return;
    try {
      const state = await this.context.browserContext.getState(this.context.options.useVision);
      this.debugWriteStateSnapshot(`after action ${ordinal}/${total} ${actionName}`, state);
    } catch (error) {
      debugWrite(
        `[state-snapshot.error] after action ${ordinal}/${total} ${actionName}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Parse and validate model output from history item
   */
  private parseHistoryModelOutput(historyItem: AgentStepRecord): {
    parsedOutput: ParsedModelOutput;
    goal: string;
    actionsToReplay: (Record<string, unknown> | null)[] | null;
  } {
    if (!historyItem.modelOutput) {
      throw new Error('No model output found in history item');
    }

    let parsedOutput: ParsedModelOutput;
    try {
      parsedOutput = JSON.parse(historyItem.modelOutput) as ParsedModelOutput;
    } catch (error) {
      throw new Error(`Could not parse modelOutput: ${error}`);
    }

    // logger.info('Parsed output', JSON.stringify(parsedOutput, null, 2));

    const goal = parsedOutput?.current_state?.next_goal || '';
    const actionsToReplay = parsedOutput?.action;

    // Validate that there are actions to replay
    if (
      !parsedOutput || // No model output string at all
      !actionsToReplay || // 'action' field is missing or null after parsing
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 0) || // 'action' is an empty array
      (Array.isArray(actionsToReplay) && actionsToReplay.length === 1 && actionsToReplay[0] === null) // 'action' is [null]
    ) {
      throw new Error('No action to replay');
    }

    return { parsedOutput, goal, actionsToReplay };
  }

  /**
   * Execute actions from history with element index updates
   */
  private async executeHistoryActions(
    parsedOutput: ParsedModelOutput,
    historyItem: AgentStepRecord,
    delay: number,
  ): Promise<ActionResult[]> {
    const state = await this.context.browserContext.getState(this.context.options.useVision);
    if (!state) {
      throw new Error('Invalid browser state');
    }

    const updatedActions: (Record<string, unknown> | null)[] = [];
    for (let i = 0; i < parsedOutput.action!.length; i++) {
      const result = historyItem.result[i];
      if (!result) {
        break;
      }
      const interactedElement = result.interactedElement;
      const currentAction = parsedOutput.action![i];

      // Skip null actions
      if (currentAction === null) {
        updatedActions.push(null);
        continue;
      }

      // If there's no interacted element, just use the action as is
      if (!interactedElement) {
        updatedActions.push(currentAction);
        continue;
      }

      const updatedAction = await this.updateActionIndices(interactedElement, currentAction, state);
      updatedActions.push(updatedAction);

      if (updatedAction === null) {
        throw new Error(`Could not find matching element ${i} in current page`);
      }
    }

    logger.debug('updatedActions', updatedActions);

    // Filter out null values and cast to the expected type
    const validActions = updatedActions.filter((action): action is Record<string, unknown> => action !== null);
    const result = await this.doMultiAction(validActions, state);

    // Wait for the specified delay
    await new Promise(resolve => setTimeout(resolve, delay));
    return result;
  }

  async executeHistoryStep(
    historyItem: AgentStepRecord,
    stepIndex: number,
    totalSteps: number,
    maxRetries = 3,
    delay = 1000,
    skipFailures = true,
  ): Promise<ActionResult[]> {
    const replayLogger = createLogger('NavigatorAgent:executeHistoryStep');
    const results: ActionResult[] = [];

    // Parse and validate model output
    let parsedData: {
      parsedOutput: ParsedModelOutput;
      goal: string;
      actionsToReplay: (Record<string, unknown> | null)[] | null;
    };
    try {
      parsedData = this.parseHistoryModelOutput(historyItem);
    } catch (error) {
      const errorMsg = `Step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`;
      replayLogger.warning(errorMsg);
      return [
        new ActionResult({
          error: errorMsg,
          includeInMemory: false,
        }),
      ];
    }

    const { parsedOutput, goal, actionsToReplay } = parsedData;
    replayLogger.info(`Replaying step ${stepIndex + 1}/${totalSteps}: goal: ${goal}`);
    replayLogger.debug(`🔄 Replaying actions:`, actionsToReplay);

    // Try to execute the step with retries
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history actions
        const stepResults = await this.executeHistoryActions(parsedOutput, historyItem, delay);
        results.push(...stepResults);
        success = true;
      } catch (error) {
        retryCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (retryCount >= maxRetries) {
          const failMsg = `Step ${stepIndex + 1} failed after ${maxRetries} attempts: ${errorMessage}`;
          replayLogger.error(failMsg);

          results.push(
            new ActionResult({
              error: failMsg,
              includeInMemory: true,
            }),
          );

          if (!skipFailures) {
            throw new Error(failMsg);
          }
        } else {
          replayLogger.warning(`Step ${stepIndex + 1} failed (attempt ${retryCount}/${maxRetries}), retrying...`);
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return results;
  }

  async updateActionIndices(
    historicalElement: DOMHistoryElement,
    action: Record<string, unknown>,
    currentState: BrowserState,
  ): Promise<Record<string, unknown> | null> {
    // If no historical element or no element tree in current state, return the action unchanged
    if (!historicalElement || !currentState.elementTree) {
      return action;
    }

    // Find the current element in the tree based on the historical element
    const currentElement = await HistoryTreeProcessor.findHistoryElementInTree(
      historicalElement,
      currentState.elementTree,
    );

    // If no current element found or it doesn't have a highlight index, return null
    if (!currentElement || currentElement.highlightIndex === null) {
      return null;
    }

    // Get action name and args
    const actionName = Object.keys(action)[0];
    const actionArgs = action[actionName] as Record<string, unknown>;

    // Get the action instance to access the index
    const actionInstance = this.actionRegistry.getAction(actionName);
    if (!actionInstance) {
      return action;
    }

    // Get the index argument from the action
    const oldIndex = actionInstance.getIndexArg(actionArgs);

    // If the index has changed, update it
    if (oldIndex !== null && oldIndex !== currentElement.highlightIndex) {
      // Create a new action object with the updated index
      const updatedAction: Record<string, unknown> = { [actionName]: { ...actionArgs } };

      // Update the index in the action arguments
      actionInstance.setIndexArg(updatedAction[actionName] as Record<string, unknown>, currentElement.highlightIndex);

      logger.info(`Element moved in DOM, updated index from ${oldIndex} to ${currentElement.highlightIndex}`);
      return updatedAction;
    }

    return action;
  }
}

function navigatorLeaseAction(
  actionName: string,
): 'click' | 'fill' | 'select' | undefined {
  if (actionName === 'click_element') return 'click';
  if (actionName === 'input_text') return 'fill';
  if (actionName === 'select_dropdown_option') return 'select';
  return undefined;
}
