import type {
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseFillableTargetDescriptor,
} from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type BrowserPage from '../vendor/browser/page.js';
import {
  executeMagicBrowseInputAction,
  validateMagicBrowseInputActionTarget,
} from './deterministic-actions.js';
import type {
  MatchOpenDataTargetResult,
  OpenDataCandidateDescriptor,
  OpenDataCandidateValue,
} from './open-data-match.js';
import {
  resolveOpenDataField,
  type OpenDataFieldResolver,
  type OpenDataFieldResolutionPlan,
  type OpenDataResolverBlockedReason,
  type OpenDataResolvedFieldValue,
} from './open-data-resolver.js';
import { projectOpenDataValueForTarget } from './value-projection.js';

export type FillOpenDataTargetStatus = 'filled' | 'blocked';

export type FillOpenDataTargetBlockedReason =
  | 'not_matched'
  | 'unknown_candidate_ref'
  | 'missing_value'
  | 'stale_target'
  | 'fill_failed'
  | 'unsupported_resolution_required'
  | 'unprojectable_value'
  | OpenDataResolverBlockedReason;

export interface FillOpenDataTargetInput {
  readonly sessionId?: string;
  readonly target: MagicBrowseFillableTargetDescriptor;
  readonly match: MatchOpenDataTargetResult;
  readonly candidates: readonly OpenDataCandidateDescriptor[];
  readonly resolver?: OpenDataFieldResolver;
  readonly runRecorder?: MagicBrowseRunRecorder;
}

export type FillOpenDataTargetResult =
  | {
      readonly status: 'filled';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
      readonly valueRef: string;
      readonly summary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: FillOpenDataTargetBlockedReason;
      readonly targetRef: string;
      readonly candidateRef?: string;
      readonly fieldKey?: string;
      readonly valueRef?: string;
      readonly summary: string;
    };

export interface FillOpenDataTargetExecutionInput extends FillOpenDataTargetInput {
  readonly page: Pick<BrowserPage, 'getState' | 'inputTextElementNode'>;
}

export async function fillOpenDataTarget(
  input: FillOpenDataTargetExecutionInput
): Promise<FillOpenDataTargetResult> {
  await appendFillEvent(input, 'open_data_fill.start', {
    status: 'started',
    ...matchEventRefs(input.match),
  });

  switch (input.match.status) {
    case 'matched':
      return fillMatchedOpenDataTarget(input, input.match);
    case 'needs_resolution':
      return fillResolvedOpenDataTarget(input, input.match);
    case 'ambiguous':
    case 'no_match':
      return block(input, 'not_matched', matchEventRefs(input.match));
  }
}

async function fillMatchedOpenDataTarget(
  input: FillOpenDataTargetExecutionInput,
  match: Extract<MatchOpenDataTargetResult, { readonly status: 'matched' }>
): Promise<FillOpenDataTargetResult> {
  const refs = matchEventRefs(match);

  if (match.targetRef !== input.target.ref) {
    return block(input, 'not_matched', refs);
  }

  const candidate = input.candidates.find(
    (item) => item.candidateRef === match.candidateRef
  );
  if (!candidate || candidate.fieldKey !== match.fieldKey) {
    return block(input, 'unknown_candidate_ref', refs);
  }

  if (match.valueRef !== createOpenDataValueRef(candidate.candidateRef)) {
    return block(input, 'unknown_candidate_ref', refs);
  }

  const value = dereferenceCandidateValue(candidate);
  if (value === undefined) {
    return block(input, 'missing_value', refs);
  }

  return fillProjectedTarget(input, refs, candidate.fieldKey, value, match.valueHint);
}

async function fillResolvedOpenDataTarget(
  input: FillOpenDataTargetExecutionInput,
  match: Extract<MatchOpenDataTargetResult, { readonly status: 'needs_resolution' }>
): Promise<FillOpenDataTargetResult> {
  const refs = matchEventRefs(match);

  if (match.targetRef !== input.target.ref) {
    return block(input, 'not_matched', refs);
  }

  const candidate = input.candidates.find(
    (item) => item.candidateRef === match.candidateRef
  );
  if (!candidate || candidate.fieldKey !== match.fieldKey) {
    return block(input, 'unknown_candidate_ref', refs);
  }

  const plan = validateResolutionPlan(match, candidate);
  if (!plan) {
    return block(input, 'unsupported_resolution_required', refs);
  }

  if (!input.resolver) {
    return block(input, 'unsupported_resolution_required', refs);
  }

  const validation = await validateMagicBrowseInputActionTarget({
    page: input.page,
    target: input.target,
  });
  if (validation.status === 'blocked') {
    return block(input, mapInputActionBlockedReason(validation.reason), refs);
  }

  await appendFillEvent(input, 'open_data_resolve.start', {
    status: 'started',
    targetRef: refs.targetRef,
    candidateRef: refs.candidateRef,
    fieldKey: refs.fieldKey,
  });
  const resolution = await resolveOpenDataField(plan, input.resolver);
  if (resolution.status === 'blocked') {
    await appendFillEvent(
      input,
      resolution.reason === 'resolver_error'
        ? 'open_data_resolve.error'
        : 'open_data_resolve.blocked',
      {
        status: 'blocked',
        reason: resolution.reason,
        targetRef: refs.targetRef,
        candidateRef: refs.candidateRef,
        fieldKey: refs.fieldKey,
      }
    );
    return block(input, resolution.reason, refs);
  }

  const resolvedRefs: FillEventRefs = {
    ...refs,
    valueRef: createOpenDataValueRef(match.candidateRef),
  };
  await appendFillEvent(input, 'open_data_resolve.complete', {
    status: 'resolved',
    targetRef: refs.targetRef,
    candidateRef: refs.candidateRef,
    fieldKey: refs.fieldKey,
  });

  return fillProjectedTarget(
    input,
    resolvedRefs,
    candidate.fieldKey,
    stringifyOpenDataValue(resolution.value),
    match.valueHint
  );
}

async function fillProjectedTarget(
  input: FillOpenDataTargetExecutionInput,
  refs: FillEventRefs,
  fieldKey: string,
  value: string,
  valueHint: Extract<
    MatchOpenDataTargetResult,
    { readonly status: 'matched' | 'needs_resolution' }
  >['valueHint']
): Promise<FillOpenDataTargetResult> {
  const projection = projectOpenDataValueForTarget({
    fieldKey,
    value,
    target: input.target,
    ...(valueHint ? { valueHint } : {}),
  });
  if (projection.status === 'blocked') {
    return block(input, projection.reason, refs);
  }
  if (projection.value === null) {
    return block(input, 'missing_value', refs);
  }

  return fillValidatedTarget(input, refs, stringifyOpenDataValue(projection.value));
}

function validateResolutionPlan(
  match: Extract<MatchOpenDataTargetResult, { readonly status: 'needs_resolution' }>,
  candidate: OpenDataCandidateDescriptor
): OpenDataFieldResolutionPlan | undefined {
  if (!candidate.resolve) {
    return undefined;
  }

  const plan = match.plan;
  if (
    plan.targetRef !== match.targetRef ||
    plan.candidateRef !== match.candidateRef ||
    plan.fieldKey !== match.fieldKey ||
    plan.valueHint !== match.valueHint ||
    plan.type !== candidate.type ||
    plan.resolve.kind !== candidate.resolve.kind ||
    plan.resolve.key !== candidate.resolve.key
  ) {
    return undefined;
  }

  return plan;
}

async function fillValidatedTarget(
  input: FillOpenDataTargetExecutionInput,
  refs: FillEventRefs,
  value: string
): Promise<FillOpenDataTargetResult> {
  const actionResult = await executeMagicBrowseInputAction({
    action: 'fill',
    sessionId: input.sessionId,
    target: input.target,
    text: value,
    page: input.page,
  });
  if (actionResult.status === 'blocked') {
    const reason = mapInputActionBlockedReason(actionResult.reason);
    if (reason !== 'stale_target') {
      await appendFillEvent(input, 'open_data_fill.error', {
        status: 'blocked',
        reason: 'fill_failed',
        ...refs,
      });
      return buildBlockedResult(input, 'fill_failed', refs);
    }

    return block(input, reason, refs);
  }

  const result: FillOpenDataTargetResult = {
    status: 'filled',
    targetRef: input.target.ref,
    candidateRef: refs.candidateRef!,
    fieldKey: refs.fieldKey!,
    valueRef: refs.valueRef!,
    summary: buildSummary('filled', {
      targetRef: input.target.ref,
      candidateRef: refs.candidateRef,
      fieldKey: refs.fieldKey,
    }),
  };

  await appendFillEvent(input, 'open_data_fill.complete', {
    status: result.status,
    targetRef: result.targetRef,
    candidateRef: result.candidateRef,
    fieldKey: result.fieldKey,
    valueRef: result.valueRef,
  });
  return result;
}

function dereferenceCandidateValue(
  candidate: OpenDataCandidateDescriptor
): string | undefined {
  const value = candidate.value;
  if (value === undefined || value === null) {
    return undefined;
  }
  return stringifyOpenDataValue(value);
}

function stringifyOpenDataValue(
  value: Exclude<OpenDataCandidateValue, null> | OpenDataResolvedFieldValue
): string {
  return typeof value === 'string' ? value : String(value);
}

function mapInputActionBlockedReason(
  reason: MagicBrowseDeterministicActionBlockedReason | undefined
): FillOpenDataTargetBlockedReason {
  switch (reason) {
    case 'target_not_found':
    case 'stale_target':
    case 'target_disabled':
    case 'target_readonly':
      return 'stale_target';
    default:
      return 'fill_failed';
  }
}

async function block(
  input: FillOpenDataTargetExecutionInput,
  reason: FillOpenDataTargetBlockedReason,
  refs: FillEventRefs
): Promise<FillOpenDataTargetResult> {
  const result = buildBlockedResult(input, reason, refs);
  await appendFillEvent(input, 'open_data_fill.blocked', {
    status: result.status,
    reason,
    targetRef: result.targetRef,
    candidateRef: result.candidateRef,
    fieldKey: result.fieldKey,
    valueRef: result.valueRef,
  });
  return result;
}

function buildBlockedResult(
  input: FillOpenDataTargetExecutionInput,
  reason: FillOpenDataTargetBlockedReason,
  refs: FillEventRefs
): FillOpenDataTargetResult {
  return {
    status: 'blocked',
    reason,
    targetRef: input.target.ref,
    ...(refs.candidateRef ? { candidateRef: refs.candidateRef } : {}),
    ...(refs.fieldKey ? { fieldKey: refs.fieldKey } : {}),
    ...(refs.valueRef ? { valueRef: refs.valueRef } : {}),
    summary: buildSummary('blocked', {
      targetRef: input.target.ref,
      candidateRef: refs.candidateRef,
      fieldKey: refs.fieldKey,
      reason,
    }),
  };
}

type FillEventRefs = {
  readonly targetRef: string;
  readonly candidateRef?: string;
  readonly fieldKey?: string;
  readonly valueRef?: string;
};

function matchEventRefs(match: MatchOpenDataTargetResult): FillEventRefs {
  switch (match.status) {
    case 'matched':
      return {
        targetRef: match.targetRef,
        candidateRef: match.candidateRef,
        fieldKey: match.fieldKey,
        valueRef: match.valueRef,
      };
    case 'needs_resolution':
      return {
        targetRef: match.targetRef,
        candidateRef: match.candidateRef,
        fieldKey: match.fieldKey,
      };
    case 'ambiguous':
    case 'no_match':
      return {
        targetRef: match.targetRef,
      };
  }
}

async function appendFillEvent(
  input: FillOpenDataTargetExecutionInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const isError = type === 'open_data_fill.error' || type === 'open_data_resolve.error';
  await input.runRecorder?.append({
    type,
    level: isError ? 'error' : 'info',
    message: isError ? openDataErrorMessage(type) : undefined,
    data: omitUndefined({
      sessionId: input.sessionId,
      runId: input.runRecorder.runId,
      targetRef: input.target.ref,
      ...data,
    }),
  });
}

function openDataErrorMessage(type: string): string {
  return type === 'open_data_resolve.error'
    ? 'Open-data field resolver failed.'
    : 'Open-data field fill failed.';
}

function buildSummary(
  status: FillOpenDataTargetStatus,
  refs: {
    readonly targetRef: string;
    readonly candidateRef?: string;
    readonly fieldKey?: string;
    readonly reason?: FillOpenDataTargetBlockedReason;
  }
): string {
  const pieces = [
    `open_data_fill ${status}`,
    `target=${refs.targetRef}`,
    refs.candidateRef ? `candidate=${refs.candidateRef}` : undefined,
    refs.fieldKey ? `field=${refs.fieldKey}` : undefined,
    refs.reason ? `reason=${refs.reason}` : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.join(' ');
}

function createOpenDataValueRef(candidateRef: string): string {
  return `value:${candidateRef}:${hashRef(candidateRef)}`;
}

function hashRef(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}
