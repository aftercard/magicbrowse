import { BaseAgent, type BaseAgentOptions, type ExtraAgentOptions } from './base.js';
import { createLogger } from '../../../adapter/logger.js';
import { z } from 'zod';
import type { AgentOutput } from '../types.js';
import { HumanMessage } from '@langchain/core/messages';
import { Actors, type ExecutionEventKind, ExecutionState } from '../event/types.js';
import { debugJson, isDebug } from '../../../adapter/debug.js';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  isAbortedError,
  isAuthenticationError,
  isBadRequestError,
  isForbiddenError,
  LLM_FORBIDDEN_ERROR_MESSAGE,
  RequestCancelledError,
  ResponseParseError,
} from './errors.js';
import { filterExternalContent } from '../messages/utils.js';

const logger = createLogger('PlannerAgent');

const nonEmptyString = z.string().refine(value => value.trim().length > 0, {
  message: 'Expected a non-empty string',
});

const plannerCommonFields = {
  observation: z.string(),
  challenges: z.string(),
  reasoning: z.string(),
} as const;

export const plannerProtectedFormHandoffSchema = z.object({
  kind: z.literal('protected_form'),
  resumeObjective: nonEmptyString,
}).strict();

export const plannerHandoffSchema = z.discriminatedUnion('kind', [
  plannerProtectedFormHandoffSchema,
  z.object({ kind: z.literal('captcha') }).strict(),
  z.object({ kind: z.literal('auth') }).strict(),
  z.object({ kind: z.literal('identity_verification') }).strict(),
]);

export const plannerBlockedReasonSchema = z.enum([
  'missing_input',
  'item_unavailable',
  'ambiguous',
  'no_path',
]);

export const plannerOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('continue'),
    ...plannerCommonFields,
    next_steps: nonEmptyString,
    final_answer: z.literal(''),
  }).strict(),
  z.object({
    status: z.literal('completed'),
    ...plannerCommonFields,
    next_steps: z.literal(''),
    final_answer: nonEmptyString,
  }).strict(),
  z.object({
    status: z.literal('blocked'),
    ...plannerCommonFields,
    next_steps: z.literal(''),
    final_answer: nonEmptyString,
    blockedReason: plannerBlockedReasonSchema,
  }).strict(),
  z.object({
    status: z.literal('needs_handoff'),
    ...plannerCommonFields,
    next_steps: z.literal(''),
    final_answer: nonEmptyString,
    handoff: plannerHandoffSchema,
  }).strict(),
  z.object({
    status: z.literal('needs_approval'),
    ...plannerCommonFields,
    next_steps: z.literal(''),
    final_answer: nonEmptyString,
  }).strict(),
]);

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;
export type PlannerStatus = PlannerOutput['status'];
export type PlannerProtectedFormHandoff = z.infer<typeof plannerProtectedFormHandoffSchema>;
export type PlannerHandoff = z.infer<typeof plannerHandoffSchema>;
export type PlannerBlockedReason = z.infer<typeof plannerBlockedReasonSchema>;

const plannerEventKindByStatus: Record<PlannerStatus, ExecutionEventKind> = {
  continue: 'planner.continue',
  completed: 'planner.completed',
  blocked: 'planner.blocked',
  needs_handoff: 'planner.needs_handoff',
  needs_approval: 'planner.needs_approval',
};

export class PlannerAgent extends BaseAgent<typeof plannerOutputSchema, PlannerOutput> {
  constructor(options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    super(plannerOutputSchema, options, { ...extraOptions, id: 'planner' });
  }

  async execute(): Promise<AgentOutput<PlannerOutput>> {
    try {
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...');
      const messages = this.context.messageManager.getMessages();
      const plannerMessages = [this.prompt.getSystemMessage(), ...messages.slice(1)];

      if (!this.context.options.useVisionForPlanner && this.context.options.useVision) {
        const lastStateMessage = plannerMessages[plannerMessages.length - 1];
        let newMsg = '';

        if (Array.isArray(lastStateMessage.content)) {
          for (const msg of lastStateMessage.content) {
            if (msg.type === 'text') {
              newMsg += msg.text;
            }
          }
        } else {
          newMsg = lastStateMessage.content;
        }

        plannerMessages[plannerMessages.length - 1] = new HumanMessage(newMsg);
      }

      const modelOutput = await this.invoke(plannerMessages);
      if (!modelOutput) {
        throw new Error('Failed to validate planner output');
      }

      const cleanedCommon = {
        observation: filterExternalContent(modelOutput.observation),
        challenges: filterExternalContent(modelOutput.challenges),
        reasoning: filterExternalContent(modelOutput.reasoning),
      };
      const cleanedPlanCandidate =
        modelOutput.status === 'continue'
          ? {
              status: 'continue',
              ...cleanedCommon,
              next_steps: filterExternalContent(modelOutput.next_steps),
              final_answer: '',
            }
          : modelOutput.status === 'blocked'
            ? {
                status: 'blocked',
                ...cleanedCommon,
                next_steps: '',
                final_answer: filterExternalContent(modelOutput.final_answer),
                blockedReason: modelOutput.blockedReason,
              }
            : modelOutput.status === 'needs_handoff'
              ? {
                  status: 'needs_handoff',
                  ...cleanedCommon,
                  next_steps: '',
                  final_answer: filterExternalContent(modelOutput.final_answer),
                  handoff:
                    modelOutput.handoff.kind === 'protected_form'
                      ? {
                          kind: 'protected_form' as const,
                          resumeObjective: filterExternalContent(modelOutput.handoff.resumeObjective),
                        }
                      : {
                          kind: modelOutput.handoff.kind,
                        },
                }
          : {
              status: modelOutput.status,
              ...cleanedCommon,
              next_steps: '',
              final_answer: filterExternalContent(modelOutput.final_answer),
            };
      const cleanedPlanResult = plannerOutputSchema.safeParse(cleanedPlanCandidate);
      if (!cleanedPlanResult.success) {
        throw new ResponseParseError('Could not validate cleaned planner output', cleanedPlanResult.error);
      }
      const cleanedPlan: PlannerOutput = cleanedPlanResult.data;
      if (isDebug()) {
        debugJson(`[planner-output.cleaned] step=${this.context.nSteps}`, cleanedPlan);
      }

      const eventMessage = cleanedPlan.status === 'continue' ? cleanedPlan.next_steps : cleanedPlan.final_answer;
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, eventMessage, {
        kind: plannerEventKindByStatus[cleanedPlan.status],
        ...(cleanedPlan.status === 'needs_handoff' ? { handoff: cleanedPlan.handoff } : {}),
        ...(cleanedPlan.status === 'blocked' ? { blockedReason: cleanedPlan.blockedReason } : {}),
      });
      logger.info('Planner output', JSON.stringify(cleanedPlan, null, 2));

      return {
        id: this.id,
        result: cleanedPlan,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (isAuthenticationError(error)) {
        throw new ChatModelAuthError(errorMessage, error);
      } else if (isBadRequestError(error)) {
        throw new ChatModelBadRequestError(errorMessage, error);
      } else if (isAbortedError(error)) {
        throw new RequestCancelledError(errorMessage);
      } else if (isForbiddenError(error)) {
        throw new ChatModelForbiddenError(LLM_FORBIDDEN_ERROR_MESSAGE, error);
      }

      logger.error(`Planning failed: ${errorMessage}`);
      this.context.emitEvent(Actors.PLANNER, ExecutionState.STEP_FAIL, `Planning failed: ${errorMessage}`);
      return {
        id: this.id,
        error: errorMessage,
      };
    }
  }
}
