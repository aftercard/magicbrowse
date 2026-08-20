import type {
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseDeterministicActionVerification,
  MagicBrowseDeterministicActionVerificationStrategy,
  MagicBrowseActionProgressEvidence,
  MagicBrowseActionProgressKind,
  MagicBrowseActionTargetDescriptor,
  MagicBrowseBrowserDialogSnapshot,
  MagicBrowseFillableTargetDescriptor,
} from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type BrowserPage from '../vendor/browser/page.js';
import type { PageProgressDigest } from '../vendor/browser/page.js';
import type { DOMElementNode } from '../vendor/browser/dom/views.js';
import type { BrowserState, PageState } from '../vendor/browser/views.js';
import {
  isBlockingNativeBrowserDialog,
  type NativeBrowserDialogGuard,
} from '../runtime/native-dialogs.js';
import {
  actionDescriptorsMatch,
  createActionTargetDescriptor,
  createMemoryFieldTargetDescriptor,
  resolveSelectorMapElementForTarget,
} from './targets.js';
import { redactSensitiveValue, type ExactValueRedactionProfiles } from '../redaction.js';
import {
  validateTargetObservationLease,
  type MutationLeaseAction,
  type TargetObservationLease,
} from './target-observation-lease.js';

type PageIdentity = {
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
};

type TargetResolution =
  | {
      readonly status: 'ready';
      readonly element: DOMElementNode;
      readonly identity: PageIdentity;
    }
  | {
      readonly status: 'blocked';
      readonly reason: MagicBrowseDeterministicActionBlockedReason;
      readonly identity: PageIdentity;
    };

type PostconditionRead =
  | {
      readonly status: 'readable';
      readonly value: string;
      readonly identity: PageIdentity;
    }
  | {
      readonly status: 'unverifiable';
      readonly identity: PageIdentity;
    };

interface DeterministicActionBaseInput {
  readonly sessionId?: string;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly readPageIdentity?: () => Promise<Pick<PageIdentity, 'url' | 'title'>>;
  readonly nativeDialog?: Pick<
    NativeBrowserDialogGuard,
    'lastDialog' | 'blockingDialog' | 'settle'
  >;
}

export interface ExecuteMagicBrowseInputActionInput extends DeterministicActionBaseInput {
  readonly action: Extract<MagicBrowseDeterministicActionVerb, 'type' | 'fill'>;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly text: string;
  readonly page: Pick<BrowserPage, 'getState' | 'inputTextElementNode' | 'readElementNodeValue'>;
  readonly failOnClientValidation?: boolean;
  readonly observationLease?: TargetObservationLease;
}

export interface ExecuteMagicBrowseClickActionInput extends DeterministicActionBaseInput {
  readonly target: MagicBrowseActionTargetDescriptor;
  readonly page: Pick<BrowserPage, 'getState' | 'clickElementNode'> &
    Partial<Pick<BrowserPage, 'capturePageProgressDigest'>>;
  /**
   * Capture before/after page digests and report what observably changed.
   * Meant for consequential clicks (final commitments) where "completed but
   * nothing happened" must surface as evidence, not read as success.
   */
  readonly progressEvidence?: boolean;
  readonly observationLease?: TargetObservationLease;
}

export interface ExecuteMagicBrowseSelectActionInput extends DeterministicActionBaseInput {
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly optionText: string;
  readonly page: Pick<
    BrowserPage,
    'getState' | 'selectDropdownOptionByExactTextOrValue' | 'readElementNodeValue'
  >;
  readonly observationLease?: TargetObservationLease;
}

export interface ExecuteMagicBrowsePressActionInput extends DeterministicActionBaseInput {
  readonly keys: string;
  readonly page: Pick<BrowserPage, 'sendKeys'>;
}

export async function executeMagicBrowseInputAction(
  input: ExecuteMagicBrowseInputActionInput
): Promise<MagicBrowseDeterministicActionResult> {
  await appendDeterministicActionEvent(input, 'deterministic_action.start', {
    status: 'started',
    action: input.action,
    targetRef: input.target.ref,
    pageRef: input.target.pageRef,
  });

  const validation = validateTextLikeInputTarget(input.target);
  if (validation) {
    return block(input, input.action, validation, {
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
    });
  }

  const resolved = await validateMagicBrowseInputActionTarget({
    page: input.page,
    target: input.target,
    observationLease: input.observationLease,
    action: input.action,
  });
  if (resolved.status === 'blocked') {
    return block(input, input.action, resolved.reason, {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(resolved.identity),
    });
  }

  try {
    const inputResult = await input.page.inputTextElementNode(false, resolved.element, input.text);
    await appendDeterministicActionEvent(input, 'deterministic_action.input_target', {
      status: 'written',
      action: input.action,
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
      inputTarget: inputResult?.inputTarget,
    });
    if (input.failOnClientValidation && inputResult?.clientValidation.invalid) {
      const dialogBlock = await blockNativeDialogIfNeeded(input, input.action, {
        targetRef: input.target.ref,
        ...protectedWriteIdentity(resolved.identity),
      });
      if (dialogBlock) {
        return dialogBlock;
      }
      return block(input, input.action, 'input_failed', {
        targetRef: input.target.ref,
        ...protectedWriteIdentity(resolved.identity),
      });
    }
  } catch {
    const dialogBlock = await blockNativeDialogIfNeeded(input, input.action, {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(resolved.identity),
    });
    if (dialogBlock) {
      return dialogBlock;
    }
    return block(input, input.action, 'input_failed', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(resolved.identity),
    });
  }

  const dialog = await readHandledNativeDialog(input);
  if (isBlockingNativeBrowserDialog(dialog)) {
    return block(
      input,
      input.action,
      'browser_dialog_open',
      {
        targetRef: input.target.ref,
        ...protectedWriteIdentity(resolved.identity),
      },
      dialog
    );
  }

  const postcondition = await readMagicBrowseInputPostcondition(input.page, input.target);
  if (postcondition.status === 'unverifiable') {
    return block(input, input.action, 'postcondition_unverifiable', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    });
  }
  const strategy = textVerificationStrategy(input.text, postcondition.value);
  if (!strategy) {
    return block(input, input.action, 'postcondition_mismatch', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    });
  }
  return complete(
    input,
    input.action,
    {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    },
    dialog,
    verifiedWith(strategy)
  );
}

export async function executeMagicBrowseClickAction(
  input: ExecuteMagicBrowseClickActionInput
): Promise<MagicBrowseDeterministicActionResult> {
  await appendDeterministicActionEvent(input, 'deterministic_action.start', {
    status: 'started',
    action: 'click',
    targetRef: input.target.ref,
    pageRef: input.target.pageRef,
  });

  if (input.target.isDisabled || input.target.context.state.disabled) {
    return block(input, 'click', 'target_disabled', {
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
    });
  }

  const resolved = await validateMagicBrowseClickActionTarget({
    page: input.page,
    target: input.target,
    observationLease: input.observationLease,
  });
  if (resolved.status === 'blocked') {
    return block(input, 'click', resolved.reason, {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  const beforeDigest =
    input.progressEvidence && input.page.capturePageProgressDigest
      ? await input.page.capturePageProgressDigest().catch(() => undefined)
      : undefined;

  try {
    await input.page.clickElementNode(false, resolved.element);
  } catch {
    const dialogBlock = await blockNativeDialogIfNeeded(input, 'click', {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
    if (dialogBlock) {
      return dialogBlock;
    }
    return block(input, 'click', 'click_failed', {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  const dialog = await readHandledNativeDialog(input);
  if (isBlockingNativeBrowserDialog(dialog)) {
    return block(
      input,
      'click',
      'browser_dialog_open',
      {
        targetRef: input.target.ref,
        ...resolved.identity,
      },
      dialog
    );
  }
  const progress = await captureProgressEvidence(input.page, beforeDigest);
  return complete(
    input,
    'click',
    {
      targetRef: input.target.ref,
      ...resolved.identity,
      ...(await readCurrentPageIdentity(input)),
    },
    dialog,
    undefined,
    progress
  );
}

export async function executeMagicBrowseSelectAction(
  input: ExecuteMagicBrowseSelectActionInput
): Promise<MagicBrowseDeterministicActionResult> {
  await appendDeterministicActionEvent(input, 'deterministic_action.start', {
    status: 'started',
    action: 'select',
    targetRef: input.target.ref,
    pageRef: input.target.pageRef,
  });

  if (input.target.context.state.disabled) {
    return block(input, 'select', 'target_disabled', {
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
    });
  }
  if (input.target.isReadonly || input.target.context.state.readonly) {
    return block(input, 'select', 'target_readonly', {
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
    });
  }
  if (input.target.kind !== 'select') {
    return block(input, 'select', 'unsupported_target', {
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
    });
  }

  const resolved = await validateMagicBrowseInputActionTarget({
    page: input.page,
    target: input.target,
    observationLease: input.observationLease,
    action: 'select',
  });
  if (resolved.status === 'blocked') {
    return block(input, 'select', resolved.reason, {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(resolved.identity),
    });
  }

  let expectedOptionValue: string;
  try {
    // Alias matching runs only after exact text/value matching finds nothing and
    // still demands a unique normalized hit, so it is safe for every select.
    // Gating it on a Latin label regex only stripped the fallback from
    // non-English forms (Pays, Land, Страна).
    expectedOptionValue = await input.page.selectDropdownOptionByExactTextOrValue(
      resolved.element,
      input.optionText,
      { allowCountryAlias: true }
    );
  } catch (error) {
    const dialogBlock = await blockNativeDialogIfNeeded(input, 'select', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(resolved.identity),
    });
    if (dialogBlock) {
      return dialogBlock;
    }
    return block(
      input,
      'select',
      isPreMutationStaleSelectError(error) ? 'stale_target' : 'select_failed',
      {
        targetRef: input.target.ref,
        ...protectedWriteIdentity(resolved.identity),
      }
    );
  }

  const dialog = await readHandledNativeDialog(input);
  if (isBlockingNativeBrowserDialog(dialog)) {
    return block(
      input,
      'select',
      'browser_dialog_open',
      {
        targetRef: input.target.ref,
        ...protectedWriteIdentity(resolved.identity),
      },
      dialog
    );
  }

  const postcondition = await readMagicBrowseInputPostcondition(input.page, input.target);
  if (postcondition.status === 'unverifiable') {
    return block(input, 'select', 'postcondition_unverifiable', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    });
  }
  if (postcondition.value !== expectedOptionValue) {
    return block(input, 'select', 'postcondition_mismatch', {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    });
  }
  return complete(
    input,
    'select',
    {
      targetRef: input.target.ref,
      ...protectedWriteIdentity(postcondition.identity),
    },
    dialog,
    verifiedWith('select_value')
  );
}

function isPreMutationStaleSelectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Resolved dropdown element not found') ||
    message.includes('Element not found or puppeteer is not connected')
  );
}

export async function executeMagicBrowsePressAction(
  input: ExecuteMagicBrowsePressActionInput
): Promise<MagicBrowseDeterministicActionResult> {
  await appendDeterministicActionEvent(input, 'deterministic_action.start', {
    status: 'started',
    action: 'press',
  });

  try {
    await input.page.sendKeys(input.keys);
  } catch {
    const dialogBlock = await blockNativeDialogIfNeeded(input, 'press');
    if (dialogBlock) {
      return dialogBlock;
    }
    return block(input, 'press', 'press_failed');
  }

  const dialog = await readHandledNativeDialog(input);
  if (isBlockingNativeBrowserDialog(dialog)) {
    return block(input, 'press', 'browser_dialog_open', {}, dialog);
  }
  return complete(input, 'press', await readCurrentPageIdentity(input), dialog);
}

export async function validateMagicBrowseInputActionTarget(input: {
  readonly page: Pick<BrowserPage, 'getState'>;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly observationLease?: TargetObservationLease;
  readonly action?: Extract<MutationLeaseAction, 'fill' | 'type' | 'select'>;
}): Promise<TargetResolution> {
  const state = await input.page.getState(false);
  const identity = identityFromState(state);
  if (input.target.pageRef && identity.pageRef && input.target.pageRef !== identity.pageRef) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }
  const element = resolveSelectorMapElementForTarget(state, input.target);
  if (!element) {
    return {
      status: 'blocked',
      reason: 'target_not_found',
      identity,
    };
  }

  const current = createMemoryFieldTargetDescriptor({
    state,
    element,
    selectorMapIndex: input.target.selectorMapIndex,
  });
  if (!current) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }
  const mutationBlock = validateOptionalObservationLease({
    lease: input.observationLease,
    current,
    element,
    state,
    action: input.action ?? 'fill',
  });
  if (mutationBlock) {
    return { status: 'blocked', reason: 'stale_target', identity };
  }
  if (current.context.state.disabled) {
    return {
      status: 'blocked',
      reason: 'target_disabled',
      identity,
    };
  }
  if (current.isReadonly || current.context.state.readonly) {
    return {
      status: 'blocked',
      reason: 'target_readonly',
      identity,
    };
  }
  // Full descriptor identity (label/placeholder/xpath/selectorRoot included) must
  // still hold on this fresh re-observation. Only mutable state is tolerated —
  // readonly/disabled are rejected separately above, so relaxing them here cannot
  // widen the write. A weaker selector-only match would let a duplicate
  // mobile/desktop control that merely shares id/name absorb a protected value.
  if (!fillableDescriptorsMatch(input.target, current, { ignoreMutableState: true })) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }

  return {
    status: 'ready',
    element,
    identity,
  };
}

export function buildMagicBrowseDeterministicActionBlockedResult(input: {
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly reason: MagicBrowseDeterministicActionBlockedReason;
  readonly targetRef?: string;
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly dialog?: MagicBrowseBrowserDialogSnapshot;
  readonly retryable?: true;
  readonly mutationState?: 'unknown';
  readonly recovery?: 'fresh_observe_required';
}): MagicBrowseDeterministicActionResult {
  return buildResult({
    status: 'blocked',
    action: input.action,
    reason: input.reason,
    targetRef: input.targetRef,
    pageRef: input.pageRef,
    url: input.url,
    title: input.title,
    dialog: input.dialog,
    retryable: input.retryable,
    mutationState: input.mutationState,
    recovery: input.recovery,
  });
}

async function validateMagicBrowseClickActionTarget(input: {
  readonly page: Pick<BrowserPage, 'getState'>;
  readonly target: MagicBrowseActionTargetDescriptor;
  readonly observationLease?: TargetObservationLease;
}): Promise<TargetResolution> {
  const state = await input.page.getState(false);
  const identity = identityFromState(state);
  const element = resolveSelectorMapElementForTarget(state, input.target);
  if (!element) {
    return {
      status: 'blocked',
      reason: 'target_not_found',
      identity,
    };
  }

  const current = createActionTargetDescriptor({
    state,
    element,
    selectorMapIndex: input.target.selectorMapIndex,
  });
  if (!current) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }
  if (
    validateOptionalObservationLease({
      lease: input.observationLease,
      current,
      element,
      state,
      action: 'click',
    })
  ) {
    return { status: 'blocked', reason: 'stale_target', identity };
  }
  if (current.isDisabled || current.context.state.disabled) {
    return {
      status: 'blocked',
      reason: 'target_disabled',
      identity,
    };
  }
  if (!actionDescriptorsMatch(input.target, current)) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }
  // Attribute equality cannot see an in-place re-render: the twin keeps the
  // tag, id, name and xpath of the node we observed. The physical node id is
  // the only discriminator, and a consequential click on a twin is exactly a
  // click on an element nobody observed.
  if (
    input.target.internalNodeId &&
    element.internalNodeId &&
    element.internalNodeId !== input.target.internalNodeId
  ) {
    return {
      status: 'blocked',
      reason: 'stale_target',
      identity,
    };
  }

  return {
    status: 'ready',
    element,
    identity,
  };
}

function validateOptionalObservationLease(input: {
  readonly lease?: TargetObservationLease;
  readonly current: MagicBrowseFillableTargetDescriptor | MagicBrowseActionTargetDescriptor;
  readonly element: DOMElementNode;
  readonly state: PageState;
  readonly action: MutationLeaseAction;
}): 'relevant_dom_mutation' | 'mutation_history_unavailable' | undefined {
  if (!input.lease) return undefined;
  const frame = input.state.formMutationFrames?.find(
    (candidate) => candidate.checkpoint?.documentRef === input.lease?.documentRef
  );
  const validation = validateTargetObservationLease({
    lease: input.lease,
    currentElement: input.element,
    currentDescriptor: input.current,
    action: input.action,
    mutationWindow:
      frame?.checkpoint && !frame.missing
        ? {
            checkpoint: frame.checkpoint,
            summaries: frame.summaries,
            coverageAvailable: frame.coverageAvailable,
          }
        : undefined,
  });
  return validation.status === 'blocked' ? validation.cause : undefined;
}

function validateTextLikeInputTarget(
  target: MagicBrowseFillableTargetDescriptor
): MagicBrowseDeterministicActionBlockedReason | undefined {
  if (target.context.state.disabled) {
    return 'target_disabled';
  }
  if (target.isReadonly || target.context.state.readonly) {
    return 'target_readonly';
  }
  return target.kind === 'input' || target.kind === 'textarea' ? undefined : 'unsupported_target';
}

async function complete(
  input: DeterministicActionBaseInput,
  action: MagicBrowseDeterministicActionVerb,
  identity: PageIdentity & { readonly targetRef?: string } = {},
  dialog?: MagicBrowseBrowserDialogSnapshot,
  verification?: MagicBrowseDeterministicActionVerification,
  progress?: MagicBrowseActionProgressEvidence
): Promise<MagicBrowseDeterministicActionResult> {
  const result = buildResult({
    status: 'completed',
    action,
    ...identity,
    dialog,
    verification,
    ...(progress ? { progress } : {}),
  });
  await appendDeterministicActionEvent(input, 'deterministic_action.complete', { ...result });
  return result;
}

// Settle checkpoints for progress-evidence capture: SPA reactions land within
// a few hundred ms; a second look catches slower async transitions without
// stalling the caller for more than ~1.6s total.
const PROGRESS_EVIDENCE_CHECKPOINT_MS = [400, 1200] as const;

async function captureProgressEvidence(
  page: Partial<Pick<BrowserPage, 'capturePageProgressDigest'>>,
  before: PageProgressDigest | undefined
): Promise<MagicBrowseActionProgressEvidence | undefined> {
  if (!before || !page.capturePageProgressDigest) return undefined;
  let elapsed = 0;
  let after: PageProgressDigest | undefined;
  for (const checkpointMs of PROGRESS_EVIDENCE_CHECKPOINT_MS) {
    await new Promise((resolve) => setTimeout(resolve, checkpointMs - elapsed));
    elapsed = checkpointMs;
    after = await page.capturePageProgressDigest().catch(() => undefined);
    // A digest that failed (navigation destroyed the context mid-read) is
    // itself navigation evidence; retry once at the next checkpoint.
    if (after && digestChanged(before, after)) break;
  }
  if (!after) {
    return {
      kind: 'navigation',
      urlChanged: true,
      textChanged: true,
      dialogAppeared: false,
      validationSignaled: false,
      busySignaled: false,
      observedAfterMs: elapsed,
    };
  }
  const urlChanged = after.url !== before.url;
  const textChanged = after.textHash !== before.textHash || after.textLength !== before.textLength;
  const dialogAppeared = after.dialogLikeCount > before.dialogLikeCount;
  const validationSignaled = after.invalidFieldCount > before.invalidFieldCount;
  const busySignaled = after.busyCount > before.busyCount;
  const kind: MagicBrowseActionProgressKind = urlChanged
    ? 'navigation'
    : validationSignaled && !dialogAppeared
      ? 'validation_blocked'
      : textChanged || dialogAppeared || busySignaled
        ? 'content_mutation'
        : 'none';
  return {
    kind,
    urlChanged,
    textChanged,
    dialogAppeared,
    validationSignaled,
    busySignaled,
    observedAfterMs: elapsed,
  };
}

function digestChanged(before: PageProgressDigest, after: PageProgressDigest): boolean {
  return (
    after.url !== before.url ||
    after.textHash !== before.textHash ||
    after.textLength !== before.textLength ||
    after.dialogLikeCount !== before.dialogLikeCount ||
    after.invalidFieldCount !== before.invalidFieldCount ||
    after.busyCount !== before.busyCount
  );
}

async function block(
  input: DeterministicActionBaseInput,
  action: MagicBrowseDeterministicActionVerb,
  reason: MagicBrowseDeterministicActionBlockedReason,
  identity: PageIdentity & { readonly targetRef?: string } = {},
  dialog?: MagicBrowseBrowserDialogSnapshot
): Promise<MagicBrowseDeterministicActionResult> {
  const result = buildMagicBrowseDeterministicActionBlockedResult({
    action,
    reason,
    ...identity,
    dialog,
  });
  await appendDeterministicActionEvent(input, 'deterministic_action.blocked', { ...result });
  return result;
}

function buildResult(input: {
  readonly status: 'completed' | 'blocked';
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly reason?: MagicBrowseDeterministicActionBlockedReason;
  readonly targetRef?: string;
  readonly pageRef?: string;
  readonly url?: string;
  readonly title?: string;
  readonly dialog?: MagicBrowseBrowserDialogSnapshot;
  readonly verification?: MagicBrowseDeterministicActionVerification;
  readonly retryable?: true;
  readonly mutationState?: 'unknown';
  readonly recovery?: 'fresh_observe_required';
  readonly progress?: MagicBrowseActionProgressEvidence;
}): MagicBrowseDeterministicActionResult {
  return omitUndefined({
    status: input.status,
    action: input.action,
    targetRef: input.targetRef,
    pageRef: input.pageRef,
    url: input.url,
    title: input.title,
    reason: input.reason,
    dialog: input.dialog,
    verification: input.verification,
    retryable: input.retryable,
    mutationState: input.mutationState,
    recovery: input.recovery,
    progress: input.progress,
    summary: deterministicActionSummary(input),
  });
}

function deterministicActionSummary(input: {
  readonly status: 'completed' | 'blocked';
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly reason?: MagicBrowseDeterministicActionBlockedReason;
  readonly targetRef?: string;
  readonly dialog?: MagicBrowseBrowserDialogSnapshot;
}): string {
  const pieces = [
    `magicbrowse_action ${input.status}`,
    `action=${input.action}`,
    input.targetRef ? `target=${input.targetRef}` : undefined,
    input.reason ? `reason=${input.reason}` : undefined,
    input.dialog ? `dialog=${input.dialog.type}:${input.dialog.handled}` : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.join(' ');
}

async function appendDeterministicActionEvent(
  input: DeterministicActionBaseInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const safeData = redactSensitiveValue(
    omitUndefined({
      sessionId: input.sessionId,
      runId: input.runRecorder?.runId,
      action: data.action,
      status: data.status,
      targetRef: data.targetRef,
      pageRef: data.pageRef,
      url: data.url,
      title: data.title,
      reason: data.reason,
      dialog: data.dialog,
      verification: data.verification,
      inputTarget: data.inputTarget,
      summary: data.summary,
    }),
    { redactionProfiles: input.redactionProfiles }
  );
  await input.runRecorder?.append({
    type,
    level: data.status === 'blocked' ? 'warn' : 'info',
    data: safeData,
  });
}

async function readHandledNativeDialog(
  input: DeterministicActionBaseInput
): Promise<MagicBrowseBrowserDialogSnapshot | undefined> {
  await input.nativeDialog?.settle();
  return input.nativeDialog?.lastDialog();
}

async function blockNativeDialogIfNeeded(
  input: DeterministicActionBaseInput,
  action: MagicBrowseDeterministicActionVerb,
  identity: PageIdentity & { readonly targetRef?: string } = {}
): Promise<MagicBrowseDeterministicActionResult | undefined> {
  const dialog = await readHandledNativeDialog(input);
  if (!isBlockingNativeBrowserDialog(dialog)) {
    return undefined;
  }
  return block(input, action, 'browser_dialog_open', identity, dialog);
}

async function readCurrentPageIdentity(input: DeterministicActionBaseInput): Promise<PageIdentity> {
  try {
    return omitUndefined((await input.readPageIdentity?.()) ?? {});
  } catch {
    return {};
  }
}

function identityFromState(state: Pick<BrowserState, 'tabId' | 'url' | 'title'>): PageIdentity {
  return omitUndefined({
    pageRef: `tab:${state.tabId}`,
    url: state.url,
    title: state.title,
  });
}

function protectedWriteIdentity(identity: PageIdentity): PageIdentity {
  return identity.pageRef ? { pageRef: identity.pageRef } : {};
}

function fillableDescriptorsMatch(
  expected: MagicBrowseFillableTargetDescriptor,
  actual: MagicBrowseFillableTargetDescriptor,
  options: { readonly ignoreMutableState?: boolean } = {}
): boolean {
  return (
    expected.ref === actual.ref &&
    expected.selectorMapIndex === actual.selectorMapIndex &&
    expected.kind === actual.kind &&
    sameString(expected.tagName, actual.tagName, { normalizeCase: true }) &&
    sameOptionalString(expected.label, actual.label) &&
    sameOptionalString(expected.displayLabel, actual.displayLabel) &&
    sameOptionalString(expected.text, actual.text) &&
    sameOptionalString(expected.placeholder, actual.placeholder) &&
    sameOptionalString(expected.inputName, actual.inputName) &&
    sameOptionalString(expected.inputType, actual.inputType, { normalizeCase: true }) &&
    sameOptionalString(expected.autocomplete, actual.autocomplete) &&
    sameOptionalString(expected.selectorRoot, actual.selectorRoot) &&
    (options.ignoreMutableState || expected.isReadonly === actual.isReadonly) &&
    sameOptionalString(expected.context.selector.id, actual.context.selector.id) &&
    sameOptionalString(expected.context.selector.name, actual.context.selector.name) &&
    sameOptionalString(expected.context.selector.role, actual.context.selector.role) &&
    sameOptionalString(expected.context.selector.xpath, actual.context.selector.xpath) &&
    sameOptionalString(expected.context.selector.css, actual.context.selector.css) &&
    (options.ignoreMutableState ||
      expected.context.state.readonly === actual.context.state.readonly) &&
    (options.ignoreMutableState ||
      expected.context.state.disabled === actual.context.state.disabled) &&
    expected.context.state.required === actual.context.state.required &&
    (options.ignoreMutableState ||
      sameOptionalString(expected.context.state.expanded, actual.context.state.expanded)) &&
    sameOptionalString(expected.context.form?.tagName, actual.context.form?.tagName, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.context.form?.id, actual.context.form?.id) &&
    sameOptionalString(expected.context.form?.name, actual.context.form?.name) &&
    sameOptionalString(expected.context.form?.label, actual.context.form?.label)
  );
}

async function readMagicBrowseInputPostcondition(
  page: Pick<BrowserPage, 'getState' | 'readElementNodeValue'>,
  target: MagicBrowseFillableTargetDescriptor
): Promise<PostconditionRead> {
  let state: PageState;
  try {
    state = await page.getState(false);
  } catch {
    return { status: 'unverifiable', identity: {} };
  }

  const identity = identityFromState(state);
  const element = resolveInputPostconditionElement(state, target);
  if (!element) {
    return { status: 'unverifiable', identity };
  }

  try {
    const value = await page.readElementNodeValue(element);
    return typeof value === 'string'
      ? { status: 'readable', value, identity }
      : { status: 'unverifiable', identity };
  } catch {
    // Cross-origin hosted payment fields can be present in the fresh DOM
    // snapshot while a second Puppeteer lookup cannot reacquire the same
    // iframe-owned node. buildDomTree records the live form value on the
    // resolved input node, so use that fresh snapshot as the bounded
    // postcondition fallback. The caller still compares the value exactly (or
    // by the existing formatting-only rule) and never returns or records it.
    const snapshotValue = element.attributes.value;
    return typeof snapshotValue === 'string'
      ? { status: 'readable', value: snapshotValue, identity }
      : { status: 'unverifiable', identity };
  }
}

function resolveInputPostconditionElement(
  state: PageState,
  target: MagicBrowseFillableTargetDescriptor
): DOMElementNode | undefined {
  const direct = resolveSelectorMapElementForTarget(state, target);
  if (direct) {
    const current = createMemoryFieldTargetDescriptor({
      state,
      element: direct,
      selectorMapIndex: target.selectorMapIndex,
    });
    if (current && fillableDescriptorsMatch(target, current, { ignoreMutableState: true })) {
      return direct;
    }
  }

  // Selector-map indexes are snapshot-scoped and may be renumbered after a
  // write. Rebind only when one current field preserves the original strong
  // DOM identity; ambiguity or replacement still fails closed.
  const matches: DOMElementNode[] = [];
  for (const [selectorMapIndex, candidate] of state.selectorMap.entries()) {
    const current = createMemoryFieldTargetDescriptor({
      state,
      element: candidate,
      selectorMapIndex,
    });
    if (current && postconditionDescriptorsMatch(target, current)) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function postconditionDescriptorsMatch(
  expected: MagicBrowseFillableTargetDescriptor,
  actual: MagicBrowseFillableTargetDescriptor
): boolean {
  const expectedSelector = expected.context.selector;
  const actualSelector = actual.context.selector;
  const hasStrongSelector = Boolean(
    expectedSelector.id || expectedSelector.name || expectedSelector.xpath || expectedSelector.css
  );

  return (
    hasStrongSelector &&
    expected.pageRef === actual.pageRef &&
    expected.kind === actual.kind &&
    sameString(expected.tagName, actual.tagName, { normalizeCase: true }) &&
    sameOptionalString(expected.inputName, actual.inputName) &&
    sameOptionalString(expected.inputType, actual.inputType, { normalizeCase: true }) &&
    sameOptionalString(expected.autocomplete, actual.autocomplete) &&
    strongestStableSelectorMatches(expectedSelector, actualSelector) &&
    sameOptionalString(expected.context.form?.tagName, actual.context.form?.tagName, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.context.form?.id, actual.context.form?.id) &&
    sameOptionalString(expected.context.form?.name, actual.context.form?.name)
  );
}

function strongestStableSelectorMatches(
  expected: MagicBrowseFillableTargetDescriptor['context']['selector'],
  actual: MagicBrowseFillableTargetDescriptor['context']['selector']
): boolean {
  if (expected.id) {
    return expected.id === actual.id;
  }
  if (expected.name) {
    return expected.name === actual.name;
  }
  if (expected.xpath) {
    return expected.xpath === actual.xpath;
  }
  return Boolean(expected.css) && expected.css === actual.css;
}

function textVerificationStrategy(
  expected: string,
  observed: string
): MagicBrowseDeterministicActionVerificationStrategy | undefined {
  if (observed === expected) {
    return 'exact';
  }
  if (observed.trim() === expected.trim()) {
    return 'trimmed';
  }
  if (isDigitFormattingOnly(expected) && isDigitFormattingOnly(observed)) {
    const expectedDigits = expected.replace(/\D/g, '');
    const observedDigits = observed.replace(/\D/g, '');
    if (expectedDigits.length > 0 && observedDigits === expectedDigits) {
      return 'digits_only';
    }
  }
  return undefined;
}

function isDigitFormattingOnly(value: string): boolean {
  return /^[\d\s()+./-]+$/u.test(value);
}

function verifiedWith(
  strategy: MagicBrowseDeterministicActionVerificationStrategy
): MagicBrowseDeterministicActionVerification {
  return { verified: true, strategy };
}

function sameOptionalString(
  expected: string | undefined,
  actual: string | undefined,
  options: { readonly normalizeCase?: boolean } = {}
): boolean {
  if (expected === undefined) {
    return true;
  }
  return sameString(expected, actual, options);
}

function sameString(
  expected: string,
  actual: string | undefined,
  options: { readonly normalizeCase?: boolean } = {}
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (options.normalizeCase) {
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return expected === actual;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}
