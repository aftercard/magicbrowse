import type {
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseActionTargetDescriptor,
  MagicBrowseFillableTargetDescriptor,
} from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type BrowserPage from '../vendor/browser/page.js';
import type { DOMElementNode } from '../vendor/browser/dom/views.js';
import type { BrowserState } from '../vendor/browser/views.js';
import {
  actionDescriptorsMatch,
  createActionTargetDescriptor,
  createResolveFieldTargetDescriptor,
  resolveSelectorMapElementForTarget,
} from './targets.js';

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

interface DeterministicActionBaseInput {
  readonly sessionId?: string;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly readPageIdentity?: () => Promise<Pick<PageIdentity, 'url' | 'title'>>;
}

export interface ExecuteMagicBrowseInputActionInput extends DeterministicActionBaseInput {
  readonly action: Extract<MagicBrowseDeterministicActionVerb, 'type' | 'fill'>;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly text: string;
  readonly page: Pick<BrowserPage, 'getState' | 'inputTextElementNode'>;
  readonly failOnClientValidation?: boolean;
}

export interface ExecuteMagicBrowseClickActionInput extends DeterministicActionBaseInput {
  readonly target: MagicBrowseActionTargetDescriptor;
  readonly page: Pick<BrowserPage, 'getState' | 'clickElementNode'>;
}

export interface ExecuteMagicBrowseSelectActionInput extends DeterministicActionBaseInput {
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly optionText: string;
  readonly page: Pick<BrowserPage, 'getState' | 'selectDropdownOption'>;
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
  });
  if (resolved.status === 'blocked') {
    return block(input, input.action, resolved.reason, {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  try {
    const inputResult = await input.page.inputTextElementNode(false, resolved.element, input.text);
    await appendDeterministicActionEvent(input, 'deterministic_action.input_target', {
      status: 'completed',
      action: input.action,
      targetRef: input.target.ref,
      pageRef: input.target.pageRef,
      inputTarget: inputResult?.inputTarget,
    });
    if (input.failOnClientValidation && inputResult?.clientValidation.invalid) {
      return block(input, input.action, 'input_failed', {
        targetRef: input.target.ref,
        ...resolved.identity,
      });
    }
  } catch {
    return block(input, input.action, 'input_failed', {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  return complete(input, input.action, {
    targetRef: input.target.ref,
    ...resolved.identity,
    ...(await readCurrentPageIdentity(input)),
  });
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
  });
  if (resolved.status === 'blocked') {
    return block(input, 'click', resolved.reason, {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  try {
    await input.page.clickElementNode(false, resolved.element);
  } catch {
    return block(input, 'click', 'click_failed', {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  return complete(input, 'click', {
    targetRef: input.target.ref,
    ...resolved.identity,
    ...(await readCurrentPageIdentity(input)),
  });
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
  });
  if (resolved.status === 'blocked') {
    return block(input, 'select', resolved.reason, {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  try {
    await input.page.selectDropdownOption(input.target.selectorMapIndex, input.optionText);
  } catch {
    return block(input, 'select', 'select_failed', {
      targetRef: input.target.ref,
      ...resolved.identity,
    });
  }

  return complete(input, 'select', {
    targetRef: input.target.ref,
    ...resolved.identity,
    ...(await readCurrentPageIdentity(input)),
  });
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
    return block(input, 'press', 'press_failed');
  }

  return complete(input, 'press', await readCurrentPageIdentity(input));
}

export async function validateMagicBrowseInputActionTarget(input: {
  readonly page: Pick<BrowserPage, 'getState'>;
  readonly target: MagicBrowseFillableTargetDescriptor;
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

  const current = createResolveFieldTargetDescriptor({
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
  if (!fillableDescriptorsMatch(input.target, current)) {
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
}): MagicBrowseDeterministicActionResult {
  return buildResult({
    status: 'blocked',
    action: input.action,
    reason: input.reason,
    targetRef: input.targetRef,
    pageRef: input.pageRef,
    url: input.url,
    title: input.title,
  });
}

async function validateMagicBrowseClickActionTarget(input: {
  readonly page: Pick<BrowserPage, 'getState'>;
  readonly target: MagicBrowseActionTargetDescriptor;
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

  return {
    status: 'ready',
    element,
    identity,
  };
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
  identity: PageIdentity & { readonly targetRef?: string } = {}
): Promise<MagicBrowseDeterministicActionResult> {
  const result = buildResult({
    status: 'completed',
    action,
    ...identity,
  });
  await appendDeterministicActionEvent(input, 'deterministic_action.complete', { ...result });
  return result;
}

async function block(
  input: DeterministicActionBaseInput,
  action: MagicBrowseDeterministicActionVerb,
  reason: MagicBrowseDeterministicActionBlockedReason,
  identity: PageIdentity & { readonly targetRef?: string } = {}
): Promise<MagicBrowseDeterministicActionResult> {
  const result = buildMagicBrowseDeterministicActionBlockedResult({
    action,
    reason,
    ...identity,
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
}): MagicBrowseDeterministicActionResult {
  return omitUndefined({
    status: input.status,
    action: input.action,
    targetRef: input.targetRef,
    pageRef: input.pageRef,
    url: input.url,
    title: input.title,
    reason: input.reason,
    summary: deterministicActionSummary(input),
  });
}

function deterministicActionSummary(input: {
  readonly status: 'completed' | 'blocked';
  readonly action: MagicBrowseDeterministicActionVerb;
  readonly reason?: MagicBrowseDeterministicActionBlockedReason;
  readonly targetRef?: string;
}): string {
  const pieces = [
    `magicbrowse_action ${input.status}`,
    `action=${input.action}`,
    input.targetRef ? `target=${input.targetRef}` : undefined,
    input.reason ? `reason=${input.reason}` : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.join(' ');
}

async function appendDeterministicActionEvent(
  input: DeterministicActionBaseInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  await input.runRecorder?.append({
    type,
    level: data.status === 'blocked' ? 'warn' : 'info',
    data: omitUndefined({
      sessionId: input.sessionId,
      runId: input.runRecorder.runId,
      action: data.action,
      status: data.status,
      targetRef: data.targetRef,
      pageRef: data.pageRef,
      url: data.url,
      title: data.title,
      reason: data.reason,
      inputTarget: data.inputTarget,
      summary: data.summary,
    }),
  });
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

function fillableDescriptorsMatch(
  expected: MagicBrowseFillableTargetDescriptor,
  actual: MagicBrowseFillableTargetDescriptor
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
    expected.isReadonly === actual.isReadonly &&
    sameOptionalString(expected.context.selector.id, actual.context.selector.id) &&
    sameOptionalString(expected.context.selector.name, actual.context.selector.name) &&
    sameOptionalString(expected.context.selector.role, actual.context.selector.role) &&
    sameOptionalString(expected.context.selector.xpath, actual.context.selector.xpath) &&
    sameOptionalString(expected.context.selector.css, actual.context.selector.css) &&
    expected.context.state.readonly === actual.context.state.readonly &&
    expected.context.state.disabled === actual.context.state.disabled &&
    expected.context.state.required === actual.context.state.required &&
    sameOptionalString(expected.context.state.expanded, actual.context.state.expanded) &&
    sameOptionalString(expected.context.form?.tagName, actual.context.form?.tagName, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.context.form?.id, actual.context.form?.id) &&
    sameOptionalString(expected.context.form?.name, actual.context.form?.name) &&
    sameOptionalString(expected.context.form?.label, actual.context.form?.label)
  );
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
