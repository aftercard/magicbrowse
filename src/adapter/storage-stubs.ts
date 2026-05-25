// Stubs for nanobrowser's `@extension/storage` chrome-extension storage layer.
// We only need the type-level constants and shapes that vendored agent code
// references — there is no actual storage in our CLI/library context.

export enum ProviderTypeEnum {
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  DeepSeek = 'deepseek',
  Gemini = 'gemini',
  Grok = 'grok',
  Ollama = 'ollama',
  AzureOpenAI = 'azure_openai',
  OpenRouter = 'openrouter',
  Groq = 'groq',
  Cerebras = 'cerebras',
  Llama = 'llama',
  CustomOpenAI = 'custom_openai',
}

export interface GeneralSettingsConfig {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  planningInterval: number;
  minWaitPageLoadTime: number;
  displayHighlights: boolean;
  replayHistoricalTasks: boolean;
  // Anything else nanobrowser stored; not read by this adapter.
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  maxSteps: 100,
  maxActionsPerStep: 5,
  maxFailures: 3,
  useVision: false,
  useVisionForPlanner: false,
  planningInterval: 3,
  minWaitPageLoadTime: 0.25,
  displayHighlights: true,
  replayHistoricalTasks: false,
};

// chatHistoryStore is a chrome.storage-backed log of agent steps. CLI doesn't
// persist history across runs — replace with a no-op that swallows writes.
export const chatHistoryStore = {
  async loadAgentStepHistory(_sessionId: string): Promise<{ history: string } | null> {
    return null;
  },
  async storeAgentStepHistory(_taskId: string, _task: string, _history: string): Promise<void> {
    // no-op
  },
  async clearAgentStepHistory(_sessionId: string): Promise<void> {
    // no-op
  },
};
