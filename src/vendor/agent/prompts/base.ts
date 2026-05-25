import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '../types.js';
import { createLogger } from '../../../adapter/logger.js';
import { buildBrowserStateDescription } from './browser-state-description.js';

const logger = createLogger('BasePrompt');
/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    const browserState = await context.browserContext.getState(context.options.useVision);
    const stateDescription = buildBrowserStateDescription({
      state: browserState,
      includeAttributes: context.options.includeAttributes,
      stepInfo: context.stepInfo,
      actionResults: context.actionResults,
      completionValidationEvidence: context.completionValidationEvidence,
      trustedRuntimeEvidence: context.trustedRuntimeEvidence,
      textProjector: context.browserStateTextProjector,
    });
    if (stateDescription.scrollInfo) {
      logger.info(stateDescription.scrollInfo);
    }

    if (browserState.screenshot && context.options.useVision) {
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription.text },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` },
          },
        ],
      });
    }

    return new HumanMessage(stateDescription.text);
  }
}

export { BasePrompt };
