// Public API for @aftercard-ai/magicbrowse.

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
  MagicBrowseFillOptions,
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
import type {
  FillOpenDataTargetInput,
  FillOpenDataTargetResult,
} from './resolution/fill-open-data.js';
import type {
  FillProtectedGroupInput,
  FillProtectedGroupResult,
} from './resolution/fill-protected.js';
import { createMagicBrowseSessionManager } from './transport/session-manager.js';

const defaultSessionManager = createMagicBrowseSessionManager();

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

export async function fillOpenDataTarget(
  options: FillOpenDataTargetInput
): Promise<FillOpenDataTargetResult> {
  return defaultSessionManager.fillOpenDataTarget(options);
}

export async function fillProtectedGroup(
  options: FillProtectedGroupInput
): Promise<FillProtectedGroupResult> {
  return defaultSessionManager.fillProtectedGroup(options);
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
export { EventType, ExecutionState, Actors } from './vendor/agent/event/types.js';
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
export { resolveActivePage, readPageIdentity } from './transport/page-resolver.js';
export { resolveAttachEndpoint, buildCdpHttpEndpointUrl } from './transport/attach-endpoint.js';
export { redactSensitiveText, redactSensitiveValue } from './redaction.js';
export { buildProtectedExactValueProfile } from './redaction.js';
export { match } from './resolution/match.js';
export { matchOpenDataTargets } from './resolution/open-data-match.js';
export {
  matchProtectedFillSubjects,
  matchProtectedFillSubjectsWithDiagnostics,
  PROTECTED_FIELD_KEYS,
} from './resolution/protected-fields.js';
export { projectOpenDataValueForTarget } from './resolution/value-projection.js';
export type {
  MatchProtectedFillSubjectsDiagnostics,
  MatchProtectedFillSubjectsOutput,
  MatchProtectedFillSubjectsRejectedGroup,
  MatchProtectedFillSubjectsRejectedGroupReason,
} from './resolution/protected-fields.js';
export {
  buildSemanticMatchPrompt,
  MAGICBROWSE_SEMANTIC_MATCH_JSON_SCHEMA,
  matchSemanticTargets,
  openDataSemanticSchema,
  protectedSemanticSchemas,
} from './resolution/semantic-match.js';
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
  MagicBrowseClickOptions,
  MagicBrowseCloseOptions,
  MagicBrowseCloudProviderMetadata,
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionStatus,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseFillOptions,
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
  MagicBrowseMatchAmbiguousResult,
  MagicBrowseMatchFieldInput,
  MagicBrowseMatchFieldResult,
  MagicBrowseMatchGroupCandidate,
  MagicBrowseMatchGroupField,
  MagicBrowseMatchGroupInput,
  MagicBrowseMatchGroupRejectedField,
  MagicBrowseMatchGroupResolutionPlan,
  MagicBrowseMatchGroupResult,
  MagicBrowseMatchGroupSubject,
  MagicBrowseMatchInput,
  MagicBrowseMatchNeedsResolutionGroupResult,
  MagicBrowseMatchNeedsResolutionResult,
  MagicBrowseMatchNoMatchGroupReason,
  MagicBrowseMatchNoMatchGroupResult,
  MagicBrowseMatchNoMatchResult,
  MagicBrowseProtectedBindingValueHint,
  MagicBrowseProtectedFieldPolicies,
  MagicBrowseProtectedFieldPolicy,
  MagicBrowseMatchReadyGroupResult,
  MagicBrowseMatchReadyResult,
  MagicBrowseMatchResult,
  MagicBrowseMatchSubject,
} from './resolution/match.js';
export type {
  MatchOpenDataTargetResult,
  MatchOpenDataTargetsInput,
  MatchOpenDataTargetsResult,
  OpenDataCandidateApplicability,
  OpenDataCandidateDescriptor,
  OpenDataCandidateResolvePlan,
  OpenDataCandidateSource,
  OpenDataCandidateValue,
  OpenDataCandidateValueType,
  OpenDataTargetDescriptor,
  OpenDataTargetMatcherModel,
} from './resolution/open-data-match.js';
export type {
  OpenDataValueProjectionBlockedReason,
  OpenDataValueProjectionHint,
  OpenDataValueProjectionResult,
  ProjectOpenDataValueForTargetInput,
} from './resolution/value-projection.js';
export type {
  FillOpenDataTargetBlockedReason,
  FillOpenDataTargetInput,
  FillOpenDataTargetResult,
  FillOpenDataTargetStatus,
} from './resolution/fill-open-data.js';
export type {
  MagicBrowseProtectedArtifactReadInput,
  MagicBrowseProtectedArtifactReadResult,
  MagicBrowseProtectedArtifactReader,
  MagicBrowseProtectedAssistiveBinding,
  MagicBrowseProtectedAssistiveResolutionInput,
  MagicBrowseProtectedAssistiveResolutionResult,
  MagicBrowseProtectedAssistiveResolver,
  MagicBrowseProtectedFillTargetDescriptor,
  FillProtectedGroupBlockedReason,
  FillProtectedGroupInput,
  FillProtectedGroupResult,
  FillProtectedGroupStatus,
  ProtectedFieldFillError,
  ProtectedFilledFieldRef,
} from './resolution/fill-protected.js';
export type { MagicBrowseProtectedFieldKey } from './resolution/protected-fields.js';
export type {
  MagicBrowseSemanticApplicability,
  MagicBrowseSemanticCandidateDescriptor,
  MagicBrowseSemanticCandidateSource,
  MagicBrowseSemanticConfidence,
  MagicBrowseSemanticFieldResult,
  MagicBrowseSemanticGroupField,
  MagicBrowseSemanticGroupResult,
  MagicBrowseSemanticMatchInput,
  MagicBrowseOpenDataValueHint,
  MagicBrowseSemanticMatchPurpose,
  MagicBrowseSemanticMatchResult,
  MagicBrowseSemanticMatcherModel,
  MagicBrowseSemanticMatcherRequest,
  MagicBrowseSemanticNoMatchReason,
  MagicBrowseSemanticPageContext,
  MagicBrowseProtectedSemanticValueHint,
  MagicBrowseSemanticRejectedGroup,
  MagicBrowseSemanticRejectedGroupField,
  MagicBrowseSemanticRejectedGroupFieldReason,
  MagicBrowseSemanticRejectedGroupReason,
  MagicBrowseSemanticSchemaDescriptor,
  MagicBrowseSemanticSchemaFieldDescriptor,
  MagicBrowseSemanticTargetDescriptor,
  MagicBrowseSemanticValueHint,
  MagicBrowseSemanticValueType,
} from './resolution/semantic-match.js';
export type {
  ProtectedExactValueProfile,
  ProtectedExactValueRule,
  ProtectedRedactionProfiles,
} from './redaction.js';
export type {
  OpenDataFieldResolutionPlan,
  OpenDataFieldResolver,
  OpenDataFieldResolverOutcome,
  OpenDataResolverBlockedReason,
} from './resolution/open-data-resolver.js';
