// Public API for @aftercard/magicbrowse.

import type {
  MagicBrowseActOptions,
  MagicBrowseActResult,
  MagicBrowseActionTargetDescriptor,
  MagicBrowseActionTargetKind,
  MagicBrowseAttachOptions,
  MagicBrowseClickOptions,
  MagicBrowseCloseOptions,
  MagicBrowseCloudProviderMetadata,
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionStatus,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseDeterministicActionVerification,
  MagicBrowseDeterministicActionVerificationStrategy,
  MagicBrowseFillOptions,
  MagicBrowseFieldControlKind,
  MagicBrowseFieldControlOption,
  MagicBrowseFillableTargetContext,
  MagicBrowseFillableTargetDescriptor,
  MagicBrowseFillableTargetFormContext,
  MagicBrowseFillableTargetKind,
  MagicBrowseFillableTargetSelectorContext,
  MagicBrowseFillableTargetSourceContext,
  MagicBrowseFillableTargetStateContext,
  MagicBrowseLaunchOptions,
  MagicBrowseMarkCaptchaResolvedOptions,
  MagicBrowseMarkCaptchaResolvedResult,
  MagicBrowseManagedSession,
  MagicBrowseObserveActionTargets,
  MagicBrowseObserveFillableTargets,
  MagicBrowseObserveOrchestration,
  MagicBrowseObserveOptions,
  MagicBrowseObserveResult,
  MagicBrowsePressOptions,
  MagicBrowseRunOptions,
  MagicBrowseScreenshotOptions,
  MagicBrowseScreenshotResult,
  MagicBrowseSelectOptions,
  MagicBrowseStatusResult,
  MagicBrowseSubmitFormTargetOptions,
  MagicBrowseSubmitFormTargetResult,
  MagicBrowseTypeOptions,
} from './types.js';
import { defaultSessionManager } from './session-manager-instance.js';

export async function launch(
  options: MagicBrowseLaunchOptions = {}
): Promise<MagicBrowseManagedSession> {
  return defaultSessionManager.launch(options);
}

export async function attach(
  options: MagicBrowseAttachOptions
): Promise<MagicBrowseManagedSession> {
  return defaultSessionManager.attach(options);
}

export async function act(options: MagicBrowseActOptions): Promise<MagicBrowseActResult> {
  return defaultSessionManager.act(options);
}

export async function markCaptchaResolved(
  options: MagicBrowseMarkCaptchaResolvedOptions = {}
): Promise<MagicBrowseMarkCaptchaResolvedResult> {
  return defaultSessionManager.markCaptchaResolved(options);
}

export async function observe(
  options: MagicBrowseObserveOptions = {}
): Promise<MagicBrowseObserveResult> {
  return defaultSessionManager.observe(options);
}

export async function screenshot(
  options: MagicBrowseScreenshotOptions = {}
): Promise<MagicBrowseScreenshotResult> {
  return defaultSessionManager.screenshot(options);
}

export async function click(
  options: MagicBrowseClickOptions
): Promise<MagicBrowseDeterministicActionResult> {
  return defaultSessionManager.click(options);
}

export async function type(
  options: MagicBrowseTypeOptions
): Promise<MagicBrowseDeterministicActionResult> {
  return defaultSessionManager.type(options);
}

export async function fill(
  options: MagicBrowseFillOptions
): Promise<MagicBrowseDeterministicActionResult> {
  return defaultSessionManager.fill(options);
}

export async function select(
  options: MagicBrowseSelectOptions
): Promise<MagicBrowseDeterministicActionResult> {
  return defaultSessionManager.select(options);
}

export async function press(
  options: MagicBrowsePressOptions
): Promise<MagicBrowseDeterministicActionResult> {
  return defaultSessionManager.press(options);
}

export async function submitFormTarget(
  options: MagicBrowseSubmitFormTargetOptions
): Promise<MagicBrowseSubmitFormTargetResult> {
  return defaultSessionManager.submitFormTarget(options);
}

export async function close(options: MagicBrowseCloseOptions = {}): Promise<void> {
  return defaultSessionManager.close(options);
}

export async function currentSession(): Promise<MagicBrowseManagedSession | undefined> {
  return defaultSessionManager.currentSession();
}

export async function status(): Promise<MagicBrowseStatusResult> {
  return defaultSessionManager.status();
}

export async function run(options: MagicBrowseRunOptions): Promise<MagicBrowseActResult> {
  const session = await launch({
    url: options.url,
    cloud: options.cloud,
    headless: options.headless,
    executablePath: options.executablePath,
    profile: options.profile,
    userDataDir: options.userDataDir,
    userAgent: options.userAgent,
    viewport: options.viewport,
    chromeArgs: options.chromeArgs,
    stealth: options.stealth,
  });

  try {
    return await act({
      sessionId: session.id,
      goal: options.goal,
      maxSteps: options.maxSteps,
      useVision: options.useVision,
      llm: options.llm,
      llmAdapter: options.llmAdapter,
      onEvent: options.onEvent,
      heartbeatMs: options.heartbeatMs,
      experimentalMemoryHints: options.experimentalMemoryHints,
      debug: options.debug,
    });
  } finally {
    await close({ sessionId: session.id });
  }
}

export {
  DIRECT_LLM_PROVIDER_REGISTRY,
  createDirectLlmAdapter,
  createNavigatorLlm,
  createPlannerLlm,
  listDirectLlmProviderFamilies,
  MissingLlmConfigError,
} from './llm/create-llm.js';
export type {
  CreateDirectLlmAdapterOptions,
  CreateDirectRoleLlmOptions,
  DirectLlmProviderOptions,
} from './llm/create-llm.js';
export { DIRECT_LLM_PROVIDER_FAMILIES } from './llm/types.js';
export { BrowserContext } from './browser/browser-context.js';
export { Executor } from './vendor/agent/executor.js';
export {
  EventType,
  ExecutionState,
  Actors,
} from './vendor/agent/event/types.js';
export {
  createMagicBrowseSessionManager,
  DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS,
  MagicBrowseSessionManager,
} from './transport/session-manager.js';
export {
  createMagicBrowseStealthPuppeteerClient,
  MAGICBROWSE_STEALTH_DISABLED_EVASIONS,
} from './transport/stealth-client.js';
export {
  createDetachedChromeBrowserLauncher,
  chromeArgsForEnvironment,
  normalizeProxySetting,
  resolveChromeExecutablePath,
} from './transport/owned-browser-launcher.js';
export { createFileAgentSessionStateStore } from './transport/agent-session-store.js';
export {
  createFileMagicBrowseSessionStore,
  resolveMagicBrowseHome,
  normalizePersistedMagicBrowseSession,
} from './transport/session-store.js';
export { createFileMagicBrowseRunStore } from './transport/run-store.js';
export {
  resolveActivePage,
  readPageIdentity,
} from './transport/page-resolver.js';
export {
  buildMemoryMatchPrompt,
  matchMemoryTargets,
  memoryDescriptorMatchJsonSchema,
} from './resolution/memory-match.js';
export type {
  MagicBrowseMemoryDelegatedArtifactReader as MemoryDelegatedFillArtifactReader,
  MagicBrowseMemoryDelegatedAssistiveBinding as MemoryDelegatedFillAssistiveBinding,
  MagicBrowseMemoryDelegatedAssistiveResolver as MemoryDelegatedFillAssistiveResolver,
  MagicBrowseMemoryDelegatedAssistiveResolutionInput as MemoryDelegatedFillAssistiveResolutionInput,
  MagicBrowseMemoryDelegatedAssistiveResolutionResult as MemoryDelegatedFillAssistiveResolutionResult,
  MagicBrowseMemoryDelegatedFieldWriter as MemoryDelegatedFillFieldWriter,
  MagicBrowseMemoryDelegatedFillTargetDescriptor as MemoryDelegatedFillTargetDescriptor,
} from './resolution/memory-delegated-fill.js';
export type {
  MatchMemoryTargetResult,
  MatchMemoryTargetsInput,
  MatchMemoryTargetsResult,
  MemoryDescriptorAvailability,
  MemoryDescriptorMatcherModel,
  MemoryDescriptorMatcherRequest,
  MemoryFieldDescriptor,
  MemoryMatchInvalidReason,
  MemoryMatchNoMatchReason,
  MemorySafeFieldDescriptor,
  MemorySafeTargetDescriptor,
  MemoryTargetDescriptor,
} from './resolution/memory-match.js';
export { classifyMemoryTargets } from './resolution/memory-target-classifier.js';
export type {
  MemoryTargetClassification,
  MemoryTargetClassifierTarget,
} from './resolution/memory-target-classifier.js';
export {
  resolveAttachEndpoint,
  buildCdpHttpEndpointUrl,
} from './transport/attach-endpoint.js';
export { redactSensitiveText, redactSensitiveValue } from './redaction.js';
export { buildExactValueRedactionProfile } from './redaction.js';
export {
  buildMagicBrowseFormContractPrompt,
  compileMagicBrowseFormContract,
  magicBrowseFormContractJsonSchema,
  MAGICBROWSE_FORM_CONTRACT_JSON_SCHEMA,
} from './resolution/form-contract.js';
export type {
  CompileMagicBrowseFormContractInput,
  CompileMagicBrowseFormContractResult,
  MagicBrowseFormContract,
  MagicBrowseFormControl,
  MagicBrowseFormControlOption,
  MagicBrowseFormContractClassification,
  MagicBrowseFormContractCompilerModel,
  MagicBrowseFormContractCompilerRequest,
  MagicBrowseFormFieldIntent,
  MagicBrowseFormFieldRelevance,
  MagicBrowseFormFieldSensitivity,
  MagicBrowseFormSubjectMode,
} from './resolution/form-contract.js';
export { MAGICBROWSE_SEMANTIC_MATCH_JSON_SCHEMA } from './resolution/semantic-match.js';
export type { AgentEvent } from './vendor/agent/event/types.js';
export type {
  MagicBrowseActOptions,
  MagicBrowseActBlockedReason,
  MagicBrowseActHandoff,
  MagicBrowsePromptActOptions,
  MagicBrowseProxyConfig,
  MagicBrowseProxySetting,
  MagicBrowseActResult,
  MagicBrowseActStatus,
  MagicBrowseActionTargetDescriptor,
  MagicBrowseActionTargetKind,
  MagicBrowseActivePageIdentity,
  MagicBrowseAttachOptions,
  MagicBrowseBrowserDialogHandled,
  MagicBrowseBrowserDialogSnapshot,
  MagicBrowseBrowserDialogType,
  MagicBrowseActionProgressEvidence,
  MagicBrowseActionProgressKind,
  MagicBrowseClickOptions,
  MagicBrowseCloseOptions,
  MagicBrowseCloudProviderMetadata,
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionStatus,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseDeterministicActionVerification,
  MagicBrowseDeterministicActionVerificationStrategy,
  MagicBrowseFillOptions,
  MagicBrowseFieldControlKind,
  MagicBrowseFieldControlOption,
  MagicBrowseFillableTargetContext,
  MagicBrowseFillableTargetDescriptor,
  MagicBrowseFillableTargetFormContext,
  MagicBrowseFillableTargetKind,
  MagicBrowseFillableTargetSelectorContext,
  MagicBrowseFillableTargetSourceContext,
  MagicBrowseFillableTargetStateContext,
  MagicBrowseLaunchOptions,
  MagicBrowseHumanVerificationKind,
  MagicBrowseHumanVerificationResolvedMarker,
  MagicBrowseMarkCaptchaResolvedOptions,
  MagicBrowseMarkCaptchaResolvedResult,
  MagicBrowseExperimentalMemoryHints,
  MagicBrowseManagedSession,
  MagicBrowseObserveActionTargets,
  MagicBrowseObserveFillableTargets,
  MagicBrowseObserveOrchestration,
  MagicBrowseObserveOptions,
  MagicBrowseObserveResult,
  MagicBrowsePressOptions,
  MagicBrowseRunOptions,
  MagicBrowseScreenshotOptions,
  MagicBrowseScreenshotResult,
  MagicBrowseSelectOptions,
  MagicBrowseSession,
  MagicBrowseSessionOwnership,
  MagicBrowseStepEvent,
  MagicBrowseStatusOutcomeType,
  MagicBrowseStatusResult,
  MagicBrowseSubmitFormTargetBlockedReason,
  MagicBrowseSubmitFormTargetOptions,
  MagicBrowseSubmitFormTargetResult,
  MagicBrowseSubmitTargetDescriptor,
  MagicBrowseSubmitTargetKind,
  MagicBrowseTypeOptions,
  MagicBrowseTrustedRuntimeEvidence,
  MagicBrowseViewport,
} from './types.js';
export type {
  MagicBrowseLlmAdapter,
  MagicBrowseLlmAdapterCapabilities,
  MagicBrowseLlmCreateModelOptions,
  MagicBrowseLlmModelRole,
  MagicBrowseLlmProviderFamily,
  MagicBrowseLlmStructuredOutputMode,
} from './llm/types.js';
export type {
  MagicBrowseRunEvent,
  MagicBrowseRunEventInput,
  MagicBrowseRunRecord,
  MagicBrowseRunRecorder,
  MagicBrowseRunStatus,
  MagicBrowseRunStore,
} from './transport/run-store.js';
export type {
  MagicBrowseMatchAmbiguousGroupResult,
  MagicBrowseMatchApplicability,
  MagicBrowseMatchExternalResolvePlan,
  MagicBrowseMatchGroupCandidate,
  MagicBrowseMatchGroupField,
  MagicBrowseMatchGroupInput,
  MagicBrowseMatchGroupRejectedField,
  MagicBrowseMatchGroupResolutionPlan,
  MagicBrowseMatchGroupResult,
  MagicBrowseMatchGroupSubject,
  MagicBrowseMatchInput,
  MagicBrowseMatchNeedsResolutionGroupResult,
  MagicBrowseMatchNoMatchGroupReason,
  MagicBrowseMatchNoMatchGroupResult,
  MagicBrowseMatchReadyGroupResult,
  MagicBrowseMatchResult,
  MagicBrowseMatchSubject,
} from './resolution/match.js';
export type {
  MagicBrowseSemanticMatcherModel,
  MagicBrowseSemanticMatcherRequest,
} from './resolution/semantic-match.js';
export type {
  ExactValueRedactionProfile,
  ExactValueRedactionRule,
  ExactValueRedactionProfiles,
} from './redaction.js';

export { replay } from './replay/replay.js';
export type {
  MagicBrowseReplayEvent,
  MagicBrowseReplayOptions,
  MagicBrowseReplayResult,
  MagicBrowseReplayStatus,
} from './replay/replay.js';
export { flowDefinitionSchema, parseFlowDefinition } from './replay/flow-schema.js';
export type {
  MagicBrowseFlowDefinition,
  MagicBrowseFlowStep,
  MagicBrowseFlowTargetQuery,
} from './replay/flow-schema.js';
export { replayOrAct, composeReplayOrAct } from './replay/replay-or-act.js';
export type {
  MagicBrowseReplayOrActOptions,
  MagicBrowseReplayOrActResult,
} from './replay/replay-or-act.js';
export { buildDraftFlow, deriveFlowSkeleton } from './replay/derive.js';
export type { DerivedFlowSkeleton, PersistedStepHistory } from './replay/derive.js';
