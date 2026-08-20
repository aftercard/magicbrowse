import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ExecutionEventKind } from './vendor/agent/event/types.js';
import type { MagicBrowseLlmAdapter } from './llm/types.js';
import type { ExactValueRedactionProfiles } from './redaction.js';

export interface MagicBrowseViewport {
  readonly width: number;
  readonly height: number;
}

export interface MagicBrowseProxyConfig {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

export type MagicBrowseProxySetting = string | MagicBrowseProxyConfig;

export interface MagicBrowseActivePageIdentity {
  readonly targetId?: string;
  readonly documentRef?: string;
  readonly url?: string;
  readonly title?: string;
}

export type MagicBrowseHumanVerificationKind = 'captcha';

export interface MagicBrowseHumanVerificationResolvedMarker {
  readonly kind: 'humanVerificationResolved';
  readonly verificationKind: MagicBrowseHumanVerificationKind;
  readonly pageIdentity: MagicBrowseActivePageIdentity;
  readonly resolvedAt: string;
  readonly expiresAt: string;
  readonly source: 'orchestrator';
}

export type MagicBrowseTrustedRuntimeEvidence = MagicBrowseHumanVerificationResolvedMarker;

export interface MagicBrowseMarkCaptchaResolvedOptions {
  readonly sessionId?: string;
  readonly ttlSeconds?: number;
}

export interface MagicBrowseMarkCaptchaResolvedResult {
  readonly status: 'marked';
  readonly sessionId: string;
  readonly runId?: string;
  readonly marker: MagicBrowseHumanVerificationResolvedMarker;
}

export interface MagicBrowseCloudProviderMetadata {
  readonly name: 'browserbase';
  readonly sessionId: string;
  readonly projectId?: string;
  readonly region?: string;
}

export interface MagicBrowseLaunchOptions {
  readonly url?: string;
  readonly cloud?: boolean;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly profile?: string;
  readonly userDataDir?: string;
  readonly userAgent?: string;
  readonly viewport?: MagicBrowseViewport;
  readonly chromeArgs?: readonly string[];
  readonly proxy?: MagicBrowseProxySetting;
  readonly stealth?: boolean;
}

export interface MagicBrowseAttachOptions {
  readonly cloud?: boolean;
  readonly cloudSessionId?: string;
  readonly cdpUrl?: string;
  readonly endpoint?: string;
  readonly browserWSEndpoint?: string;
  readonly browserURL?: string;
  readonly stealth?: boolean;
}

export interface MagicBrowseCloseOptions {
  readonly sessionId?: string;
}

export type MagicBrowseStatusOutcomeType =
  | 'browser_alive'
  | 'browser_not_running'
  | 'browser_mismatch';

export type MagicBrowseStatusDiagnosticReason =
  | 'browser_connect_timeout'
  | 'browser_connect_failed'
  | 'page_resolution_timeout';

export interface MagicBrowseStatusResult {
  readonly success: true;
  readonly alive: boolean;
  readonly outcomeType: MagicBrowseStatusOutcomeType;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly ownership?: MagicBrowseSessionOwnership;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly currentPageUnresolved?: true;
  readonly diagnosticReason?: MagicBrowseStatusDiagnosticReason;
}

export interface MagicBrowseScreenshotOptions {
  readonly sessionId?: string;
  readonly path?: string;
}

export interface MagicBrowseObserveOptions {
  readonly sessionId?: string;
  readonly includeOrchestration?: boolean;
  readonly viewportExpansion?: number;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  /** Aggregate wall-clock deadline for this observation. */
  readonly timeoutMs?: number;
  /** External cancellation for this observation. */
  readonly signal?: AbortSignal;
}

export interface MagicBrowseActOptions {
  readonly sessionId?: string;
  readonly goal: string;
  readonly url?: string;
  readonly maxSteps?: number;
  /** Aggregate wall-clock deadline for this act operation. */
  readonly timeoutMs?: number;
  /** External cancellation for this act operation. */
  readonly signal?: AbortSignal;
  /**
   * Per-act opt-in for including the current page screenshot in LLM browser
   * state messages. Defaults to false.
   */
  readonly useVision?: boolean;
  /**
   * Compatibility escape hatch. When set, this model is used for both
   * navigator and planner roles and takes precedence over `llmAdapter`.
   */
  readonly llm?: BaseChatModel;
  readonly llmAdapter?: MagicBrowseLlmAdapter;
  readonly onEvent?: (event: MagicBrowseStepEvent) => void;
  /**
   * If set, record a `runtime.heartbeat` debug event in the current run when
   * no executor event has been emitted for this many ms. Default 15_000 (15s).
   * Pass 0 to disable.
   */
  readonly heartbeatMs?: number;
  /**
   * Experimental acceleration hook. Disabled unless callers explicitly provide
   * hints; product CLIs should guard it behind their own feature flag.
   */
  readonly experimentalMemoryHints?: MagicBrowseExperimentalMemoryHints;
  /**
   * Experimental acceleration hook: override the planner cadence (a planner
   * turn runs every N navigator steps; runtime default is 3). Unset keeps
   * stock behavior; product CLIs should guard it behind their own flag.
   */
  readonly experimentalPlanningInterval?: number;
  /**
   * @deprecated Diagnostics are always written to the persisted run record for
   * the current browser session. This option is retained for source
   * compatibility and no longer needs to be set by callers.
   */
  readonly debug?: boolean | string;
}

export interface MagicBrowseExperimentalMemoryHints {
  readonly navigator?: string;
  readonly planner?: string;
}

export type MagicBrowsePromptActOptions = MagicBrowseActOptions;

export type MagicBrowseActStatus =
  | 'completed'
  | 'blocked'
  | 'needs_handoff'
  | 'needs_approval'
  | 'failed'
  | 'max_steps'
  | 'timed_out'
  | 'cancelled';

export type MagicBrowseActBlockedReason =
  | 'missing_input'
  | 'item_unavailable'
  | 'ambiguous'
  | 'no_path'
  | 'browser_dialog_open';

export type MagicBrowseBrowserDialogType =
  | 'alert'
  | 'confirm'
  | 'prompt'
  | 'beforeunload'
  | 'unknown';

export type MagicBrowseBrowserDialogHandled = 'accepted' | 'dismissed' | 'failed';

export interface MagicBrowseBrowserDialogSnapshot {
  readonly type: MagicBrowseBrowserDialogType;
  readonly message?: string;
  readonly handled: MagicBrowseBrowserDialogHandled;
}

/**
 * Machine-readable cause for a terminal `failed` act, so callers can decide
 * between retrying and handing the flow to the user. Absent for statuses that
 * already carry their own semantics (blocked, needs_handoff, timed_out, ...).
 */
export type MagicBrowseActFailureCode =
  | 'llm_provider_payment_required'
  | 'llm_provider_auth'
  | 'llm_provider_forbidden'
  | 'llm_request_invalid'
  | 'max_failures'
  | 'internal_error';

export type MagicBrowseActHandoff =
  | {
      readonly kind: 'memory_fill';
      readonly resumeObjective: string;
    }
  | {
      readonly kind: 'captcha';
    }
  | {
      readonly kind: 'auth';
    }
  | {
      readonly kind: 'identity_verification';
    };

export interface MagicBrowseStepEvent {
  readonly actor: string;
  readonly state: string;
  readonly details: string;
  readonly kind?: ExecutionEventKind;
  readonly handoff?: MagicBrowseActHandoff;
  readonly blockedReason?: MagicBrowseActBlockedReason;
  readonly actionName?: string;
  readonly step: number;
  readonly maxSteps?: number;
  readonly timestamp: number;
}

export interface MagicBrowseActResult {
  readonly status: MagicBrowseActStatus;
  readonly steps: readonly MagicBrowseStepEvent[];
  readonly finalUrl: string;
  readonly finalMessage?: string;
  readonly handoff?: MagicBrowseActHandoff;
  readonly blockedReason?: MagicBrowseActBlockedReason;
  readonly failureCode?: MagicBrowseActFailureCode;
  readonly dialog?: MagicBrowseBrowserDialogSnapshot;
  readonly retryable?: true;
  readonly mutationState?: 'unknown';
  readonly recovery?: 'fresh_observe_required';
}

export type MagicBrowseScreenshotResult =
  | {
      readonly status: 'captured';
      readonly path: string;
      readonly pageRef?: string;
      readonly url?: string;
      readonly title?: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'browser_connection_failed' | 'screenshot_failed';
      readonly summary: string;
      readonly pageRef?: string;
      readonly url?: string;
      readonly title?: string;
    };

export interface MagicBrowseObserveResult {
  readonly plannerView: string;
  readonly orchestration?: MagicBrowseObserveOrchestration;
  /** Trusted, page-scoped runtime facts are kept separate from untrusted DOM
   * text so downstream policy can distinguish a passive verification widget
   * from a fresh interactive challenge. */
  readonly trustedRuntimeEvidence?: readonly MagicBrowseTrustedRuntimeEvidence[];
}

export type MagicBrowseFillableTargetKind = 'input' | 'textarea' | 'select' | 'select-like';

export type MagicBrowseFieldControlKind = 'select' | 'radio' | 'checkbox' | 'toggle';

export interface MagicBrowseFieldControlOption {
  readonly value: string;
  readonly text: string;
  readonly disabled?: boolean;
  readonly bindingKey?: string;
  readonly targetRef?: string;
  readonly fallbackTargetRef?: string;
  readonly checked?: boolean;
}

export interface MagicBrowseFillableTargetSourceContext {
  readonly kind: 'selectorMap';
  readonly ref: string;
  readonly index: number;
  readonly highlightIndex?: number;
  readonly snapshotScoped: true;
}

export interface MagicBrowseFillableTargetSelectorContext {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
  readonly xpath?: string;
  readonly css?: string;
}

export interface MagicBrowseFillableTargetStateContext {
  readonly readonly: boolean;
  readonly popupBacked: boolean;
  readonly disabled: boolean;
  readonly required: boolean;
  readonly withinActiveModal?: boolean;
  readonly withinEmbeddedFrame?: boolean;
  readonly ariaInvalid?: boolean;
  readonly validationMessage?: string;
  readonly expanded?: string;
  readonly checked?: boolean;
  /** Value-free runtime state; the underlying value is never projected. */
  readonly valuePresent?: boolean;
}

export interface MagicBrowseFillableTargetFormContext {
  readonly tagName: string;
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
}

export interface MagicBrowseFillableTargetContext {
  readonly source: MagicBrowseFillableTargetSourceContext;
  readonly selector: MagicBrowseFillableTargetSelectorContext;
  readonly state: MagicBrowseFillableTargetStateContext;
  readonly form?: MagicBrowseFillableTargetFormContext;
}

export interface MagicBrowseFillableTargetDescriptor {
  readonly ref: string;
  readonly index: number;
  readonly selectorMapIndex: number;
  readonly kind: MagicBrowseFillableTargetKind;
  readonly tagName: string;
  readonly role?: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly text?: string;
  readonly placeholder?: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly selectorRoot?: string;
  readonly isReadonly: boolean;
  readonly popupBacked: boolean;
  readonly controlKind?: MagicBrowseFieldControlKind;
  readonly options?: readonly MagicBrowseFieldControlOption[];
  readonly checked?: boolean;
  /** Value-free runtime state; the underlying value is never projected. */
  readonly hasValue?: boolean;
  readonly pageRef?: string;
  readonly host?: string;
  readonly context: MagicBrowseFillableTargetContext;
}

export type MagicBrowseSubmitTargetKind = 'button' | 'input' | 'role-button';

export type MagicBrowseActionTargetKind =
  | MagicBrowseFillableTargetKind
  | MagicBrowseSubmitTargetKind
  | 'link'
  | 'generic';

export interface MagicBrowseActionTargetDescriptor {
  readonly ref: string;
  readonly index: number;
  readonly selectorMapIndex: number;
  readonly kind: MagicBrowseActionTargetKind;
  readonly tagName: string;
  readonly role?: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly text?: string;
  readonly href?: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly selectorRoot?: string;
  /** Opaque stable DOM identity for safely revalidating choice actions. */
  readonly bindingKey?: string;
  /**
   * Physical node identity from the source observation. A re-rendered
   * identical twin (same tag/id/name/xpath) carries a different node id, so
   * this is the only signal that separates "the element I observed" from
   * "an element that merely looks like it". Consequential clicks must not
   * cross that line.
   */
  readonly internalNodeId?: string;
  readonly isDisabled: boolean;
  readonly pageRef?: string;
  readonly host?: string;
  readonly context: MagicBrowseFillableTargetContext;
}

export interface MagicBrowseSubmitTargetDescriptor extends MagicBrowseActionTargetDescriptor {
  readonly kind: MagicBrowseSubmitTargetKind;
}

export type MagicBrowseSubmitFormTargetBlockedReason =
  | 'stale_target'
  | 'not_submit_target'
  | 'target_disabled'
  | 'click_failed'
  | 'browser_dialog_open';

export interface MagicBrowseSubmitFormTargetOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseSubmitTargetDescriptor;
}

export type MagicBrowseSubmitFormTargetResult =
  | {
      readonly status: 'submitted';
      readonly targetRef: string;
      readonly pageRef?: string;
      readonly url?: string;
      readonly title?: string;
      readonly dialog?: MagicBrowseBrowserDialogSnapshot;
      readonly summary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: MagicBrowseSubmitFormTargetBlockedReason;
      readonly targetRef: string;
      readonly pageRef?: string;
      readonly url?: string;
      readonly title?: string;
      readonly dialog?: MagicBrowseBrowserDialogSnapshot;
      readonly summary: string;
    };

export type MagicBrowseDeterministicActionStatus = 'completed' | 'blocked';

export type MagicBrowseDeterministicActionVerb = 'click' | 'type' | 'fill' | 'select' | 'press';

export type MagicBrowseDeterministicActionBlockedReason =
  | 'missing_session'
  | 'target_not_found'
  | 'stale_target'
  | 'unsupported_target'
  | 'target_disabled'
  | 'target_readonly'
  | 'click_failed'
  | 'input_failed'
  | 'select_failed'
  | 'press_failed'
  | 'postcondition_mismatch'
  | 'postcondition_unverifiable'
  | 'action_timeout'
  | 'action_cancelled'
  | 'browser_disconnected'
  | 'browser_dialog_open';

export type MagicBrowseDeterministicActionVerificationStrategy =
  | 'exact'
  | 'trimmed'
  | 'digits_only'
  | 'select_value';

export interface MagicBrowseDeterministicActionVerification {
  readonly verified: true;
  readonly strategy: MagicBrowseDeterministicActionVerificationStrategy;
}

export interface MagicBrowseDeterministicActionResult {
  readonly status: MagicBrowseDeterministicActionStatus;
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly targetRef?: string;
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly reason?: MagicBrowseDeterministicActionBlockedReason;
  readonly verification?: MagicBrowseDeterministicActionVerification;
  readonly dialog?: MagicBrowseBrowserDialogSnapshot;
  readonly retryable?: true;
  readonly mutationState?: 'unknown';
  readonly recovery?: 'fresh_observe_required';
  readonly summary: string;
  readonly progress?: MagicBrowseActionProgressEvidence;
}

/**
 * What observably changed after a consequential action. `none` is a first-class
 * outcome: a completed click that produced no observable progress must be
 * distinguishable from one that did — a Pay click reporting `none` almost
 * certainly did not submit anything.
 */
export type MagicBrowseActionProgressKind =
  | 'navigation'
  | 'content_mutation'
  | 'validation_blocked'
  | 'none';

export interface MagicBrowseActionProgressEvidence {
  readonly kind: MagicBrowseActionProgressKind;
  readonly urlChanged: boolean;
  readonly textChanged: boolean;
  readonly dialogAppeared: boolean;
  readonly validationSignaled: boolean;
  readonly busySignaled: boolean;
  /** Milliseconds after the action at which the change was first observed. */
  readonly observedAfterMs: number;
}

export interface MagicBrowseClickOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseActionTargetDescriptor;
  /** Must match the viewport horizon used to acquire the snapshot-scoped target. */
  readonly viewportExpansion?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Capture before/after page digests; see MagicBrowseActionProgressEvidence. */
  readonly progressEvidence?: boolean;
}

export interface MagicBrowseTypeOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly text: string;
  /** Must match the viewport horizon used to acquire the snapshot-scoped target. */
  readonly viewportExpansion?: number;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MagicBrowseFillOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly value: string;
  /** Must match the viewport horizon used to acquire the snapshot-scoped target. */
  readonly viewportExpansion?: number;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MagicBrowseSelectOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly optionText: string;
  /** Must match the viewport horizon used to acquire the snapshot-scoped target. */
  readonly viewportExpansion?: number;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MagicBrowsePressOptions {
  readonly sessionId?: string;
  readonly keys: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MagicBrowseObserveFillableTargets {
  readonly count: number;
  readonly summary: string;
  readonly descriptors: readonly MagicBrowseFillableTargetDescriptor[];
}

export interface MagicBrowseObserveActionTargets {
  readonly count: number;
  readonly summary: string;
  readonly descriptors: readonly MagicBrowseActionTargetDescriptor[];
}

export interface MagicBrowseObserveOrchestration {
  readonly fillableTargets?: MagicBrowseObserveFillableTargets;
  readonly actionTargets?: MagicBrowseObserveActionTargets;
  readonly submitTargets?: readonly MagicBrowseSubmitTargetDescriptor[];
}

export interface MagicBrowseProfileInfo {
  readonly name: string;
  readonly userDataDir: string;
}

export type MagicBrowseSessionOwnership = 'owned' | 'attached';

export interface MagicBrowseManagedSession {
  readonly id: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly ownership: MagicBrowseSessionOwnership;
  readonly cdpUrl: string;
  readonly cloudProvider?: MagicBrowseCloudProviderMetadata;
  readonly pid?: number;
  readonly profile?: MagicBrowseProfileInfo;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
  readonly humanVerificationResolved?: MagicBrowseHumanVerificationResolvedMarker;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  observe(opts?: MagicBrowseObserveOptions): Promise<MagicBrowseObserveResult>;
  act(opts: MagicBrowseActOptions): Promise<MagicBrowseActResult>;
  markCaptchaResolved(
    opts?: Omit<MagicBrowseMarkCaptchaResolvedOptions, 'sessionId'>
  ): Promise<MagicBrowseMarkCaptchaResolvedResult>;
  screenshot(
    opts?: Omit<MagicBrowseScreenshotOptions, 'sessionId'>
  ): Promise<MagicBrowseScreenshotResult>;
  click(
    opts: Omit<MagicBrowseClickOptions, 'sessionId'>
  ): Promise<MagicBrowseDeterministicActionResult>;
  type(
    opts: Omit<MagicBrowseTypeOptions, 'sessionId'>
  ): Promise<MagicBrowseDeterministicActionResult>;
  fill(
    opts: Omit<MagicBrowseFillOptions, 'sessionId'>
  ): Promise<MagicBrowseDeterministicActionResult>;
  select(
    opts: Omit<MagicBrowseSelectOptions, 'sessionId'>
  ): Promise<MagicBrowseDeterministicActionResult>;
  press(
    opts: Omit<MagicBrowsePressOptions, 'sessionId'>
  ): Promise<MagicBrowseDeterministicActionResult>;
  submitFormTarget(
    opts: Omit<MagicBrowseSubmitFormTargetOptions, 'sessionId'>
  ): Promise<MagicBrowseSubmitFormTargetResult>;
  close(): Promise<void>;
}

export type MagicBrowseSession = MagicBrowseManagedSession;

export interface MagicBrowseRunOptions extends MagicBrowseActOptions {
  readonly url: string;
  readonly cloud?: boolean;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly profile?: string;
  readonly userDataDir?: string;
  readonly userAgent?: string;
  readonly viewport?: MagicBrowseViewport;
  readonly chromeArgs?: readonly string[];
  readonly proxy?: MagicBrowseProxySetting;
  readonly stealth?: boolean;
}
