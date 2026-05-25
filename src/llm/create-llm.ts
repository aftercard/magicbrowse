import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatCerebras } from '@langchain/cerebras';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatOllama } from '@langchain/ollama';
import { ChatXAI } from '@langchain/xai';
import { AzureChatOpenAI, ChatOpenAI } from '@langchain/openai';

import { debugWrite, isDebug } from '../adapter/debug.js';
import type {
  MagicBrowseLlmAdapter,
  MagicBrowseLlmAdapterCapabilities,
  MagicBrowseLlmCreateModelOptions,
  MagicBrowseLlmModelRole,
  MagicBrowseLlmProviderFamily,
} from './types.js';
import { DIRECT_LLM_PROVIDER_FAMILIES } from './types.js';

export type MagicBrowseLlmProvider = MagicBrowseLlmProviderFamily;

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_APP_NAME = 'aftercard MagicBrowse';
const CEREBRAS_DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';
const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const AZURE_OPENAI_DEFAULT_API_VERSION = '2024-10-21';

export interface DirectLlmProviderOptions {
  readonly provider: MagicBrowseLlmProviderFamily;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly headers?: Record<string, string>;
  readonly siteUrl?: string;
  readonly appName?: string;
  readonly azureApiVersion?: string;
}

export interface CreateDirectLlmAdapterOptions extends DirectLlmProviderOptions {
  readonly navigatorModel: string;
  readonly plannerModel?: string;
}

export interface CreateDirectRoleLlmOptions extends DirectLlmProviderOptions {
  readonly model: string;
  readonly temperature?: number;
  /** Per-request timeout in ms. Default 30_000 (30s). Prevents hung LLM calls. */
  readonly timeoutMs?: number;
  /** Max retries on transient failures. Default 1. */
  readonly maxRetries?: number;
}

export class MissingLlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingLlmConfigError';
  }
}

interface ResolvedConfig {
  provider: MagicBrowseLlmProviderFamily;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  azureApiVersion?: string;
}

interface DirectProviderFactoryInput extends ResolvedConfig {
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
}

interface DirectProviderDefinition {
  readonly family: MagicBrowseLlmProviderFamily;
  readonly defaultBaseUrl?: string;
  readonly requiresBaseUrl?: boolean;
  readonly requiresApiKey: boolean;
  readonly capabilities: MagicBrowseLlmAdapterCapabilities;
  createModel(input: DirectProviderFactoryInput): BaseChatModel;
}

type ChatModelConstructor = new (fields: Record<string, unknown>) => BaseChatModel;

function instantiateModel(
  constructor: unknown,
  fields: Record<string, unknown>
): BaseChatModel {
  return new (constructor as ChatModelConstructor)(fields);
}

function openAiCompatibleModel(input: DirectProviderFactoryInput): BaseChatModel {
  return new ChatOpenAI({
    apiKey: input.apiKey ?? 'not-needed',
    model: input.model,
    temperature: input.temperature,
    timeout: input.timeoutMs,
    maxRetries: input.maxRetries,
    configuration: {
      ...(input.baseUrl ? { baseURL: normalizeBaseUrl(input.baseUrl) } : {}),
      ...(input.headers ? { defaultHeaders: input.headers } : {}),
    },
  });
}

export const DIRECT_LLM_PROVIDER_REGISTRY: Record<
  MagicBrowseLlmProviderFamily,
  DirectProviderDefinition
> = {
  openai: {
    family: 'openai',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'json_schema',
      supportsStrictJsonSchema: true,
      supportsToolChoice: true,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: openAiCompatibleModel,
  },
  'azure-openai': {
    family: 'azure-openai',
    requiresApiKey: true,
    requiresBaseUrl: true,
    capabilities: {
      structuredOutputMode: 'json_schema',
      supportsStrictJsonSchema: true,
      supportsToolChoice: true,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(AzureChatOpenAI, {
        azureOpenAIApiKey: input.apiKey,
        azureOpenAIEndpoint: input.baseUrl,
        azureOpenAIApiDeploymentName: input.model,
        azureOpenAIApiVersion: input.azureApiVersion ?? AZURE_OPENAI_DEFAULT_API_VERSION,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
      }),
  },
  anthropic: {
    family: 'anthropic',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'tool_calling',
      supportsStrictJsonSchema: false,
      supportsToolChoice: true,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatAnthropic, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
        ...(input.baseUrl ? { anthropicApiUrl: normalizeBaseUrl(input.baseUrl) } : {}),
      }),
  },
  deepseek: {
    family: 'deepseek',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'manual_json',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatDeepSeek, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
        ...(input.baseUrl ? { configuration: { baseURL: normalizeBaseUrl(input.baseUrl) } } : {}),
      }),
  },
  gemini: {
    family: 'gemini',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'json_schema',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatGoogleGenerativeAI, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
      }),
  },
  xai: {
    family: 'xai',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'tool_calling',
      supportsStrictJsonSchema: false,
      supportsToolChoice: true,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatXAI, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
        ...(input.baseUrl ? { configuration: { baseURL: normalizeBaseUrl(input.baseUrl) } } : {}),
      }),
  },
  groq: {
    family: 'groq',
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'tool_calling',
      supportsStrictJsonSchema: false,
      supportsToolChoice: true,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatGroq, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
        ...(input.baseUrl ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
      }),
  },
  cerebras: {
    family: 'cerebras',
    defaultBaseUrl: CEREBRAS_DEFAULT_BASE_URL,
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'json_schema',
      supportsStrictJsonSchema: true,
      supportsToolChoice: true,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatCerebras, {
        apiKey: input.apiKey,
        model: input.model,
        temperature: input.temperature,
        timeout: input.timeoutMs,
        maxRetries: input.maxRetries,
        ...(input.baseUrl ? { baseUrl: normalizeBaseUrl(input.baseUrl) } : {}),
      }),
  },
  ollama: {
    family: 'ollama',
    defaultBaseUrl: OLLAMA_DEFAULT_BASE_URL,
    requiresApiKey: false,
    capabilities: {
      structuredOutputMode: 'manual_json',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: (input) =>
      instantiateModel(ChatOllama, {
        baseUrl: input.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
        model: input.model,
        temperature: input.temperature,
      }),
  },
  openrouter: {
    family: 'openrouter',
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    requiresApiKey: true,
    capabilities: {
      structuredOutputMode: 'json_object',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: true,
      supportsStreaming: true,
    },
    createModel: openAiCompatibleModel,
  },
  llama: {
    family: 'llama',
    requiresApiKey: true,
    requiresBaseUrl: true,
    capabilities: {
      structuredOutputMode: 'manual_json',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: openAiCompatibleModel,
  },
  custom: {
    family: 'custom',
    requiresApiKey: false,
    requiresBaseUrl: true,
    capabilities: {
      structuredOutputMode: 'manual_json',
      supportsStrictJsonSchema: false,
      supportsToolChoice: false,
      supportsVision: false,
      supportsStreaming: true,
    },
    createModel: openAiCompatibleModel,
  },
};

export function listDirectLlmProviderFamilies(): readonly MagicBrowseLlmProviderFamily[] {
  return [...DIRECT_LLM_PROVIDER_FAMILIES];
}

export function createDirectLlmAdapter(
  options: CreateDirectLlmAdapterOptions
): MagicBrowseLlmAdapter {
  const provider = parseProvider(options.provider);
  const definition = DIRECT_LLM_PROVIDER_REGISTRY[provider];

  return {
    family: provider,
    capabilities: definition.capabilities,
    createModel(modelOptions) {
      const model =
        modelOptions.role === 'planner'
          ? options.plannerModel ?? options.navigatorModel
          : options.navigatorModel;
      return createRoleModel(
        {
          ...options,
          provider,
          model,
        },
        definition,
        modelOptions
      );
    },
  };
}

function createRoleModel(
  providerOptions: CreateDirectRoleLlmOptions,
  definition: DirectProviderDefinition,
  options: MagicBrowseLlmCreateModelOptions
): BaseChatModel {
  const config = resolveConfig(providerOptions, definition);
  if (isDebug()) {
    debugWrite(
      `[llm-config] provider=${config.provider} role=${options.role} model=${config.model}` +
        `${config.baseUrl ? ` baseUrl=${config.baseUrl}` : ''}`
    );
  }
  return definition.createModel({
    ...config,
    temperature: options.temperature ?? 0.1,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxRetries: options.maxRetries ?? 1,
  });
}

function resolveConfig(
  options: CreateDirectRoleLlmOptions,
  definition: DirectProviderDefinition
): ResolvedConfig {
  const apiKey = options.apiKey?.trim();
  if (definition.requiresApiKey && !apiKey) {
    throw new MissingLlmConfigError(
      `Direct LLM provider ${definition.family} requires apiKey.`
    );
  }

  const model = options.model?.trim();
  if (!model) {
    throw new MissingLlmConfigError(
      `Direct LLM provider ${definition.family} requires model.`
    );
  }

  const baseUrl = options.baseUrl?.trim() || definition.defaultBaseUrl;
  if (definition.requiresBaseUrl && !baseUrl) {
    throw new MissingLlmConfigError(
      `Direct LLM provider ${definition.family} requires baseUrl.`
    );
  }

  return {
    provider: definition.family,
    ...(baseUrl ? { baseUrl: normalizeBaseUrl(baseUrl) } : {}),
    ...(apiKey ? { apiKey } : {}),
    model,
    ...(definition.family === 'openrouter' ? { headers: resolveOpenRouterHeaders(options) } : {}),
    ...(options.azureApiVersion ? { azureApiVersion: options.azureApiVersion } : {}),
  };
}

function parseProvider(value: MagicBrowseLlmProviderFamily | string | undefined): MagicBrowseLlmProviderFamily {
  if (!value) {
    throw new MissingLlmConfigError(
      `Direct LLM provider is required. Expected one of: ${DIRECT_LLM_PROVIDER_FAMILIES.join(', ')}.`
    );
  }

  const provider = value.trim().toLowerCase();
  if (isMagicBrowseLlmProviderFamily(provider)) {
    return provider;
  }

  throw new MissingLlmConfigError(
    `Unsupported direct LLM provider: ${value}. Expected one of: ${DIRECT_LLM_PROVIDER_FAMILIES.join(', ')}.`
  );
}

function isMagicBrowseLlmProviderFamily(value: string): value is MagicBrowseLlmProviderFamily {
  return (DIRECT_LLM_PROVIDER_FAMILIES as readonly string[]).includes(value);
}

function resolveOpenRouterHeaders(options: DirectLlmProviderOptions): Record<string, string> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const siteUrl = options.siteUrl;
  const appName = options.appName || OPENROUTER_DEFAULT_APP_NAME;
  if (siteUrl) headers['HTTP-Referer'] = siteUrl;
  if (appName) headers['X-Title'] = appName;
  return headers;
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');

  if (trimmed.endsWith('/chat/completions')) {
    return trimmed.slice(0, -'/chat/completions'.length);
  }

  if (trimmed.endsWith('/completions')) {
    return trimmed.slice(0, -'/completions'.length);
  }

  return trimmed;
}

function createRoleLlm(
  options: CreateDirectRoleLlmOptions,
  role: MagicBrowseLlmModelRole
): BaseChatModel {
  const provider = parseProvider(options.provider);
  const definition = DIRECT_LLM_PROVIDER_REGISTRY[provider];
  return createRoleModel({ ...options, provider }, definition, { role, ...options });
}

export function createNavigatorLlm(options: CreateDirectRoleLlmOptions): BaseChatModel {
  return createRoleLlm(options, 'navigator');
}

export function createPlannerLlm(options: CreateDirectRoleLlmOptions): BaseChatModel {
  return createRoleLlm(options, 'planner');
}
