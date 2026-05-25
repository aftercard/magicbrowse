import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ExecutionEventKind } from './vendor/agent/event/types.js';
import type { MagicBrowseLlmAdapter } from './llm/types.js';
import type {
  FillProtectedGroupInput,
  FillProtectedGroupResult,
} from './resolution/fill-protected.js';
import type { ProtectedRedactionProfiles } from './redaction.js';

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
}

export interface MagicBrowseActOptions {
  readonly sessionId?: string;
  readonly goal: string;
  readonly url?: string;
  readonly maxSteps?: number;
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
  | 'cancelled';

export type MagicBrowseActBlockedReason =
  | 'missing_input'
  | 'item_unavailable'
  | 'ambiguous'
  | 'no_path';

export type MagicBrowseActHandoff =
  | {
      readonly kind: 'protected_form';
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
}

export type MagicBrowseFillableTargetKind = 'input' | 'textarea' | 'select' | 'select-like';

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
  readonly expanded?: string;
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
  | 'click_failed';

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
      readonly summary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: MagicBrowseSubmitFormTargetBlockedReason;
      readonly targetRef: string;
      readonly pageRef?: string;
      readonly url?: string;
      readonly title?: string;
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
  | 'press_failed';

export interface MagicBrowseDeterministicActionResult {
  readonly status: MagicBrowseDeterministicActionStatus;
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly targetRef?: string;
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly reason?: MagicBrowseDeterministicActionBlockedReason;
  readonly summary: string;
}

export interface MagicBrowseClickOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseActionTargetDescriptor;
}

export interface MagicBrowseTypeOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly text: string;
}

export interface MagicBrowseFillOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly value: string;
}

export interface MagicBrowseSelectOptions {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly optionText: string;
}

export interface MagicBrowsePressOptions {
  readonly sessionId?: string;
  readonly keys: string;
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
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
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
  fillProtectedGroup(
    opts: Omit<FillProtectedGroupInput, 'sessionId'>
  ): Promise<FillProtectedGroupResult>;
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
