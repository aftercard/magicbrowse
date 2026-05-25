import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { redactTransientImageDataUrls } from '../redaction.js';
import type { ExecutorAgentState } from '../vendor/agent/executor.js';
import {
  MESSAGE_MANAGER_SNAPSHOT_VERSION,
  type MessageManagerSerializedMessage,
  type MessageManagerSerializedRole,
  type MessageManagerSnapshot,
} from '../vendor/agent/messages/service.js';
import { resolveMagicBrowseHome, type ResolveMagicBrowseHomeOptions } from './session-store.js';

export const AGENT_SESSION_SCHEMA_VERSION = 1 as const;
export const AGENT_SESSIONS_DIRNAME = 'agent-sessions';
const OMITTED_IMAGE_CONTENT = '[image omitted from persisted agent state]';

export interface PersistedAgentSessionState extends ExecutorAgentState {
  readonly version: typeof AGENT_SESSION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly updatedAt: string;
}

export interface AgentSessionStateLoadResult {
  readonly state?: ExecutorAgentState;
  readonly warning?: string;
}

export interface AgentSessionStateStore {
  readonly agentSessionsDir: string;
  loadAgentState(sessionId: string): Promise<AgentSessionStateLoadResult>;
  saveAgentState(sessionId: string, state: ExecutorAgentState): Promise<void>;
  clearAgentState(sessionId: string): Promise<void>;
}

export interface FileAgentSessionStateStoreOptions extends ResolveMagicBrowseHomeOptions {
  readonly rootDir?: string;
  readonly now?: () => Date;
}

export function createFileAgentSessionStateStore(
  options: FileAgentSessionStateStoreOptions = {}
): AgentSessionStateStore {
  return new FileAgentSessionStateStore(options);
}

class FileAgentSessionStateStore implements AgentSessionStateStore {
  readonly agentSessionsDir: string;

  private readonly now: () => Date;

  constructor(options: FileAgentSessionStateStoreOptions) {
    const rootDir = resolve(options.rootDir ?? resolveMagicBrowseHome(options));
    this.agentSessionsDir = join(rootDir, AGENT_SESSIONS_DIRNAME);
    this.now = options.now ?? (() => new Date());
  }

  async loadAgentState(sessionId: string): Promise<AgentSessionStateLoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.agentStatePath(sessionId), 'utf8');
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return {};
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        warning: `Agent session state for ${sessionId} is not valid JSON: ${errorToMessage(error)}`,
      };
    }

    const normalized = normalizePersistedAgentSessionState(parsed, sessionId);
    if (!normalized) {
      return {
        warning: `Agent session state for ${sessionId} has unsupported schema or malformed content.`,
      };
    }

    return {
      state: {
        tasks: normalized.tasks,
        messageManager: normalized.messageManager,
      },
    };
  }

  async saveAgentState(sessionId: string, state: ExecutorAgentState): Promise<void> {
    const sanitizedState = stripTransientImagesFromAgentState(state);
    const persisted: PersistedAgentSessionState = {
      version: AGENT_SESSION_SCHEMA_VERSION,
      sessionId,
      updatedAt: this.now().toISOString(),
      tasks: [...sanitizedState.tasks],
      messageManager: sanitizedState.messageManager,
    };

    await mkdir(this.agentSessionsDir, { recursive: true });
    await writeFile(this.agentStatePath(sessionId), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
  }

  async clearAgentState(sessionId: string): Promise<void> {
    await rm(this.agentStatePath(sessionId), { force: true });
  }

  private agentStatePath(sessionId: string): string {
    return join(this.agentSessionsDir, `${safeSessionFilename(sessionId)}.json`);
  }
}

function normalizePersistedAgentSessionState(
  value: unknown,
  expectedSessionId: string
): PersistedAgentSessionState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = readString(value.sessionId);
  const updatedAt = readString(value.updatedAt);
  const tasks = Array.isArray(value.tasks)
    ? value.tasks.filter((task): task is string => typeof task === 'string' && task.length > 0)
    : undefined;
  const messageManager = normalizeMessageManagerSnapshot(value.messageManager);

  if (
    value.version !== AGENT_SESSION_SCHEMA_VERSION ||
    sessionId !== expectedSessionId ||
    !updatedAt ||
    !tasks ||
    !messageManager
  ) {
    return undefined;
  }

  return {
    version: AGENT_SESSION_SCHEMA_VERSION,
    sessionId,
    updatedAt,
    tasks,
    messageManager,
  };
}

function normalizeMessageManagerSnapshot(value: unknown): MessageManagerSnapshot | undefined {
  if (!isRecord(value) || value.version !== MESSAGE_MANAGER_SNAPSHOT_VERSION) {
    return undefined;
  }

  const toolId = readPositiveInteger(value.toolId);
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeSerializedMessage)
    : undefined;

  if (!toolId || !messages || messages.some(message => !message)) {
    return undefined;
  }

  const normalizedMessages = (messages as MessageManagerSerializedMessage[]).map(
    sanitizeSerializedMessage
  );
  const totalTokens = normalizedMessages.reduce((sum, message) => sum + message.metadata.tokens, 0);
  return {
    version: MESSAGE_MANAGER_SNAPSHOT_VERSION,
    toolId,
    totalTokens,
    messages: normalizedMessages,
  };
}

function normalizeSerializedMessage(value: unknown): MessageManagerSerializedMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const role = readSerializedRole(value.role);
  const type = readString(value.type);
  const content = normalizeMessageContent(value.content);
  const metadata = normalizeMessageMetadata(value.metadata);
  const toolCalls = normalizeToolCalls(value.toolCalls);
  const toolCallId = readString(value.toolCallId);

  if (!role || !type || content === undefined || !metadata) {
    return undefined;
  }
  if (role === 'tool' && !toolCallId) {
    return undefined;
  }
  if (value.toolCalls !== undefined && !toolCalls) {
    return undefined;
  }

  return {
    role,
    type,
    content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    metadata,
  };
}

function normalizeMessageMetadata(value: unknown): MessageManagerSerializedMessage['metadata'] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tokens = readNonNegativeNumber(value.tokens);
  if (tokens === undefined) {
    return undefined;
  }

  const messageType = value.message_type === null ? null : readString(value.message_type) ?? null;
  return {
    tokens,
    message_type: messageType,
  };
}

function normalizeMessageContent(value: unknown): MessageManagerSerializedMessage['content'] | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.every(isRecord)) {
    return value.map(item => ({ ...item }));
  }
  return undefined;
}

function normalizeToolCalls(value: unknown): MessageManagerSerializedMessage['toolCalls'] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: Array<NonNullable<MessageManagerSerializedMessage['toolCalls']>[number]> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined;
    }
    const name = readString(item.name);
    const args = isRecord(item.args) ? item.args : undefined;
    const id = readString(item.id);
    const type = item.type === 'tool_call' ? 'tool_call' : undefined;
    if (!name || !args) {
      return undefined;
    }
    normalized.push({
      name,
      args: { ...args },
      ...(id ? { id } : {}),
      ...(type ? { type } : {}),
    });
  }

  return normalized;
}

function stripTransientImagesFromAgentState(state: ExecutorAgentState): ExecutorAgentState {
  return {
    tasks: [...state.tasks],
    messageManager: sanitizeMessageManagerSnapshot(state.messageManager),
  };
}

function sanitizeMessageManagerSnapshot(snapshot: MessageManagerSnapshot): MessageManagerSnapshot {
  const messages = snapshot.messages.map(sanitizeSerializedMessage);
  return {
    version: snapshot.version,
    toolId: snapshot.toolId,
    totalTokens: messages.reduce((sum, message) => sum + message.metadata.tokens, 0),
    messages,
  };
}

function sanitizeSerializedMessage(
  message: MessageManagerSerializedMessage
): MessageManagerSerializedMessage {
  return {
    ...message,
    content: sanitizeMessageContent(message.content),
  };
}

function sanitizeMessageContent(
  content: MessageManagerSerializedMessage['content']
): MessageManagerSerializedMessage['content'] {
  if (typeof content === 'string') {
    return redactTransientImageDataUrls(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }

  let removedImage = false;
  const sanitized = content
    .filter((item) => {
      const isImage = isRecord(item) && (item.type === 'image_url' || 'image_url' in item);
      if (isImage) {
        removedImage = true;
      }
      return !isImage;
    })
    .map((item) => {
      if (isTextContentItem(item)) {
        return {
          ...item,
          text: redactTransientImageDataUrls(item.text),
        };
      }
      return item;
    });

  if (!removedImage) {
    return sanitized as MessageManagerSerializedMessage['content'];
  }
  if (sanitized.length === 0) {
    return OMITTED_IMAGE_CONTENT;
  }
  if (sanitized.every(isTextContentItem)) {
    return sanitized.map((item) => item.text).join('\n');
  }
  return sanitized as MessageManagerSerializedMessage['content'];
}

function isTextContentItem(value: unknown): value is { readonly type: 'text'; readonly text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function readSerializedRole(value: unknown): MessageManagerSerializedRole | undefined {
  return value === 'system' || value === 'human' || value === 'ai' || value === 'tool'
    ? value
    : undefined;
}

function safeSessionFilename(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
