import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type MagicBrowseLlmProviderFamily =
  | 'openai'
  | 'azure-openai'
  | 'anthropic'
  | 'deepseek'
  | 'gemini'
  | 'xai'
  | 'groq'
  | 'cerebras'
  | 'ollama'
  | 'openrouter'
  | 'llama'
  | 'custom';

export type MagicBrowseLlmModelRole = 'navigator' | 'planner';

export type MagicBrowseLlmStructuredOutputMode =
  | 'tool_calling'
  | 'json_schema'
  | 'json_object'
  | 'manual_json';

export interface MagicBrowseLlmAdapterCapabilities {
  readonly structuredOutputMode: MagicBrowseLlmStructuredOutputMode;
  readonly supportsStrictJsonSchema: boolean;
  readonly supportsToolChoice: boolean;
  readonly supportsVision: boolean;
  readonly supportsStreaming: boolean;
}

export interface MagicBrowseLlmCreateModelOptions {
  readonly role: MagicBrowseLlmModelRole;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface MagicBrowseLlmAdapter {
  readonly family: MagicBrowseLlmProviderFamily;
  readonly capabilities: MagicBrowseLlmAdapterCapabilities;
  createModel(options: MagicBrowseLlmCreateModelOptions): BaseChatModel;
}

export const DIRECT_LLM_PROVIDER_FAMILIES = [
  'openai',
  'azure-openai',
  'anthropic',
  'deepseek',
  'gemini',
  'xai',
  'groq',
  'cerebras',
  'ollama',
  'openrouter',
  'llama',
  'custom',
] as const satisfies readonly MagicBrowseLlmProviderFamily[];
