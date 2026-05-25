/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '../types.js';
import { plannerSystemPromptTemplate } from './templates/planner.js';
import { appendPromptMemoryHints } from './memory-hints.js';

export class PlannerPrompt extends BasePrompt {
  constructor(private readonly memoryHints?: string) {
    super();
  }

  getSystemMessage(): SystemMessage {
    return new SystemMessage(
      appendPromptMemoryHints(plannerSystemPromptTemplate, 'planner', this.memoryHints)
    );
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
