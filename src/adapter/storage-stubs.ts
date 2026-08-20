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

// chatHistoryStore was a chrome.storage-backed log of agent steps in
// nanobrowser. Persistence here is experimental and default-off: writes
// happen only when MAGICBROWSE_EXPERIMENTAL_STEP_HISTORY=1 (and the executor
// only calls store when generalSettings.replayHistoricalTasks is on), into
// $MAGICBROWSE_HOME/step-history/<taskId>.json. This is the auto-recorder's
// data source: the raw agent step history (model outputs + acted elements).
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function stepHistoryPersistenceEnabled(): boolean {
  return process.env.MAGICBROWSE_EXPERIMENTAL_STEP_HISTORY === '1';
}

export function stepHistoryDir(): string {
  const home = process.env.MAGICBROWSE_HOME?.trim() || join(homedir(), '.magicbrowse');
  return join(home, 'step-history');
}

export const chatHistoryStore = {
  async loadAgentStepHistory(_sessionId: string): Promise<{ history: string } | null> {
    return null;
  },
  async storeAgentStepHistory(taskId: string, task: string, history: string): Promise<void> {
    if (!stepHistoryPersistenceEnabled()) {
      return;
    }
    const dir = stepHistoryDir();
    await mkdir(dir, { recursive: true });
    const sanitizedTaskId = taskId.replace(/[^\w.-]/g, '_');
    await writeFile(
      join(dir, `${sanitizedTaskId}.json`),
      `${JSON.stringify({ taskId, task, storedAt: new Date().toISOString(), history: JSON.parse(history) })}\n`
    );
  },
  async clearAgentStepHistory(_sessionId: string): Promise<void> {
    // History files are evidence for the recorder; nothing to clear.
  },
};
