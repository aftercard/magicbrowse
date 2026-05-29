import { createHash } from 'node:crypto';

import {
  buildProtectedExactValueProfile as buildExactValueRedactionProfile,
  type ProtectedExactValueProfile as ExactValueRedactionProfile,
  type ProtectedExactValueRule as ExactValueRedactionRule,
} from '../redaction.js';
import {
  fillProtectedGroup as executeLegacyProtectedFillGroup,
  type MagicBrowseProtectedArtifactReader as DelegatedFillArtifactReader,
  type MagicBrowseProtectedAssistiveResolver as DelegatedFillAssistiveResolver,
  type MagicBrowseProtectedFieldWriter as DelegatedFillFieldWriter,
  type MagicBrowseProtectedFillTargetDescriptor as DelegatedFillTargetDescriptor,
} from './fill-protected.js';
import type { MagicBrowseMatchGroupCandidate, MagicBrowseMatchGroupSubject } from './match.js';

export type MemoryFillFieldState =
  | 'ready'
  | 'already_filled'
  | 'missing'
  | 'conflict'
  | 'provider_needs_reauth'
  | 'provider_unavailable'
  | 'skipped'
  | 'unsupported_frame';

export interface MemoryObservedTarget {
  readonly targetRef?: string;
  readonly id?: string;
  readonly ref?: string;
  readonly label?: string;
  readonly kind?: string;
  readonly fieldName?: string;
  readonly required?: boolean;
  readonly action?: string;
  readonly unsupportedFrame?: boolean;
  readonly alreadyFilled?: boolean;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly readonly?: boolean;
  readonly fillable?: boolean;
  readonly subjectRole?: string;
  readonly subject_role?: string;
}

export type MemoryTargetMatch =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly fieldRef: string;
      readonly fieldName: string;
      readonly confidence: 'high' | 'medium';
      readonly projectionHint?: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly targetRef: string;
      readonly fieldRefs: readonly string[];
    }
  | {
      readonly status: 'no_match';
      readonly targetRef: string;
      readonly reason?: string;
    }
  | {
      readonly status: 'invalid_model_output';
      readonly targetRef: string;
      readonly reason?: string;
    };

export interface MemoryPlanField {
  readonly targetRef: string;
  readonly fieldName: string;
  readonly fieldRef?: string;
  readonly projectionHint?: string;
  readonly subjectRole?: string;
  readonly state: MemoryFillFieldState;
  readonly valueHandle?: string;
  readonly itemRef?: string;
  readonly providerManaged?: boolean;
  readonly candidateHandles?: readonly MemoryCandidateHandle[];
  readonly reason?: string;
  readonly askBeforeUse?: boolean;
}

export interface MemoryCandidateHandle {
  readonly itemRef: string;
  readonly safeLabel: string;
  readonly fieldRef?: string;
  readonly fieldName?: string;
  readonly valueHandle?: string;
  readonly providerManaged?: boolean;
  readonly subjectRole?: string;
}

export interface MemoryPlanBlocker {
  readonly kind: string;
  readonly targetRef?: string;
  readonly fieldName?: string;
  readonly fieldRef?: string;
  readonly itemRef?: string;
  readonly subjectRole?: string;
  readonly blocking?: boolean;
  readonly candidates?: readonly MemoryCandidateHandle[];
  readonly reason?: string;
}

export interface MemoryValueFreeDiagnostics {
  readonly warnings?: readonly string[];
  readonly events?: readonly Record<string, unknown>[];
}

export interface MemoryFillPlan {
  readonly id: string;
  readonly valueVisibility: 'handles_only';
  readonly pageFingerprint: string;
  readonly fields: readonly MemoryPlanField[];
  readonly blockers: readonly MemoryPlanBlocker[];
  readonly finalCommitmentTargets: readonly {
    readonly targetRef: string;
    readonly label?: string;
    readonly action?: string;
  }[];
  readonly diagnostics?: MemoryValueFreeDiagnostics;
}

export interface MemoryApplyFieldOutcome {
  readonly targetRef: string;
  readonly fieldName: string;
  readonly status: 'filled' | 'skipped' | 'blocked' | 'field_error';
  readonly reason?: string;
}

export interface MemoryApplyFillResult {
  readonly status:
    | 'filled'
    | 'partial'
    | 'needs_replan'
    | 'waiting_for_user'
    | 'blocked'
    | 'no_progress';
  readonly fields: readonly MemoryApplyFieldOutcome[];
  readonly blockers: readonly MemoryPlanBlocker[];
  readonly completedLedger: readonly {
    readonly targetRef: string;
    readonly fieldName: string;
  }[];
  readonly redactionProfileRefs: readonly string[];
  readonly finalCommitmentClicked: false;
  readonly diagnostics?: MemoryValueFreeDiagnostics;
}

export interface MemoryBrowserFillWriter {
  fill(input: {
    readonly targetRef: string;
    readonly value: string;
  }): Promise<
    | void
    | { readonly status: 'filled' }
    | { readonly status: 'needs_replan'; readonly reason?: string }
    | { readonly status: 'blocked' | 'field_error'; readonly reason?: string }
  >;
}

export type MemoryRedactionProfileInstaller = (
  input: Readonly<{
    profileRef: string;
    profile: ExactValueRedactionProfile;
    targetRef: string;
    fieldName: string;
  }>
) => void | Promise<void>;

export interface MemoryDelegatedFillExecutionDescriptor {
  readonly ref: string;
  readonly targetRef?: string;
  readonly valueHandle?: string;
  readonly itemRef?: string;
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
  readonly targets: readonly DelegatedFillTargetDescriptor[];
  readonly artifactReader: DelegatedFillArtifactReader;
  readonly writer: DelegatedFillFieldWriter;
  readonly assistiveResolver?: DelegatedFillAssistiveResolver;
  readonly redactionProfileRef?: string;
}

const MARKETING_FIELD_NAMES = new Set(['marketing_opt_in', 'newsletter', 'survey']);
export async function createMemoryFillPlan(input: {
  readonly pageFingerprint?: string;
  readonly page?: {
    readonly fingerprint?: string;
    readonly targets?: readonly MemoryObservedTarget[];
  };
  readonly targets?: readonly MemoryObservedTarget[];
  readonly targetMatches?: readonly MemoryTargetMatch[];
  readonly memoryCatalog: {
    readonly valueVisibility: 'handles_only';
    readonly handles?: readonly Record<string, unknown>[];
    readonly missing?: readonly Record<string, unknown>[];
    readonly conflicts?: readonly Record<string, unknown>[];
    readonly availability?: Record<string, unknown>;
    readonly unavailable?: readonly Record<string, unknown>[];
  };
  readonly llmVisibleObservation?: unknown;
  readonly memoryValues?: Record<string, string | undefined>;
  readonly materializedValues?: Record<string, string | undefined>;
}): Promise<MemoryFillPlan> {
  const pageFingerprint = input.page?.fingerprint ?? input.pageFingerprint ?? 'fresh';
  const targets = input.page?.targets ?? input.targets ?? [];
  const targetMatchesByRef = indexTargetMatches(input.targetMatches);
  const fields: MemoryPlanField[] = [];
  const blockers: MemoryPlanBlocker[] = [];
  const finalCommitmentTargets: MemoryFillPlan['finalCommitmentTargets'][number][] = [];

  for (const target of targets) {
    const targetRef = readTargetRef(target);
    if (!targetRef) {
      continue;
    }

    if (isFinalCommitmentTarget(target)) {
      finalCommitmentTargets.push({
        targetRef,
        ...(target.label ? { label: target.label } : {}),
        ...(target.action ? { action: target.action } : {}),
      });
      continue;
    }

    const field = buildPlanField(
      targetRef,
      targetMatchesByRef.get(targetRef),
      target,
      input.memoryCatalog
    );
    fields.push(field);
    blockers.push(...planBlockers(field));
  }

  const diagnostics = buildProjectionDiagnostics(
    'memory_fill.plan_input_projection',
    input.llmVisibleObservation,
    input.memoryValues,
    input.materializedValues
  );

  return {
    id: `memory_fill_plan_${digestStable({
      pageFingerprint,
      targets: targets.map(readTargetRef),
    }).slice(0, 16)}`,
    valueVisibility: 'handles_only',
    pageFingerprint,
    fields,
    blockers: dedupeBlockers([
      ...blockers,
      ...catalogOnlyBlockers(input.memoryCatalog.missing, 'missing'),
      ...catalogOnlyBlockers(input.memoryCatalog.conflicts, 'conflict'),
    ]),
    finalCommitmentTargets,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export async function applyMemoryFillPlan(input: {
  readonly plan: MemoryFillPlan;
  readonly currentPageState: {
    readonly fingerprint: string;
    readonly targets?: readonly MemoryObservedTarget[];
  };
  readonly materializeValue: (
    handle: string
  ) => Promise<string | number | { readonly value?: unknown }>;
  readonly browserWriter: MemoryBrowserFillWriter;
  readonly installRedactionProfile?: MemoryRedactionProfileInstaller;
  readonly delegatedFillDescriptors?: readonly MemoryDelegatedFillExecutionDescriptor[];
  readonly postFillObservation?: unknown;
  readonly replanObservation?: unknown;
  readonly memoryValues?: Record<string, string | undefined>;
}): Promise<MemoryApplyFillResult> {
  const materializedValues: Record<string, string | undefined> = {};
  const delegatedRedactionProfiles: ExactValueRedactionProfile[] = [];
  const buildResult = (
    status: MemoryApplyFillResult['status'],
    fields: readonly MemoryApplyFieldOutcome[],
    blockers: readonly MemoryPlanBlocker[],
    completedLedger: MemoryApplyFillResult['completedLedger'],
    redactionProfileRefs: readonly string[]
  ) =>
    buildApplyResult(
      status,
      fields,
      blockers,
      completedLedger,
      redactionProfileRefs,
      buildApplyProjectionDiagnostics(input, status, materializedValues, delegatedRedactionProfiles)
    );

  const staleBlocker = stalePageBlocker(input.plan, input.currentPageState.fingerprint);
  if (staleBlocker) {
    return buildResult('needs_replan', [], [staleBlocker], [], []);
  }

  const preMaterializeBlockers = collectPreMaterializeBlockers(input.plan.fields);
  if (preMaterializeBlockers.length > 0) {
    return buildResult(
      preMaterializeBlockers.some((blocker) => blocker.kind === 'unsupported_frame')
        ? 'blocked'
        : 'waiting_for_user',
      [],
      preMaterializeBlockers,
      [],
      []
    );
  }

  const fields: MemoryApplyFieldOutcome[] = [];
  const completedLedger: Array<MemoryApplyFillResult['completedLedger'][number]> = [];
  const redactionProfileRefs: string[] = [];

  for (const field of input.plan.fields) {
    if (field.state === 'already_filled' || field.state === 'skipped') {
      fields.push({
        targetRef: field.targetRef,
        fieldName: field.fieldName,
        status: 'skipped',
        reason: field.state,
      });
      continue;
    }
    if (field.state !== 'ready') {
      continue;
    }

    const targetBlocker = currentTargetBlocker(field, input.currentPageState.targets);
    if (targetBlocker) {
      return buildResult(
        targetBlocker.kind === 'unsupported_frame' ? 'blocked' : 'needs_replan',
        fields,
        [targetBlocker],
        completedLedger,
        redactionProfileRefs
      );
    }

    if (!field.valueHandle) {
      return buildResult(
        'waiting_for_user',
        fields,
        [applyBlocker(field, 'memory.provide_missing')],
        completedLedger,
        redactionProfileRefs
      );
    }

    if (requiresDelegatedFillAdapter(field)) {
      const delegatedResult = await executeDelegatedMemoryField(
        input,
        field,
        delegatedRedactionProfiles
      );
      fields.push(delegatedResult.outcome);
      redactionProfileRefs.push(...delegatedResult.redactionProfileRefs);

      if (delegatedResult.status === 'filled') {
        completedLedger.push({
          targetRef: field.targetRef,
          fieldName: field.fieldName,
        });
        continue;
      }

      return buildResult(
        delegatedResult.status === 'needs_replan'
          ? 'needs_replan'
          : completedLedger.length > 0
            ? 'partial'
            : delegatedResult.status === 'field_errors'
              ? 'no_progress'
              : 'blocked',
        fields,
        [delegatedResult.blocker],
        completedLedger,
        redactionProfileRefs
      );
    }

    const value = stringifyRuntimeOnlyValue(await input.materializeValue(field.valueHandle));
    materializedValues[field.valueHandle] = value;
    const redactionProfileRef = `memory_redaction_${digestStable({
      h: field.valueHandle,
      v: value,
    }).slice(0, 16)}`;
    const redactionProfile = buildExactValueRedactionProfile({
      [field.fieldName]: value,
      [field.valueHandle]: value,
    });
    if (Object.keys(redactionProfile.rules).length > 0) {
      await input.installRedactionProfile?.({
        profileRef: redactionProfileRef,
        profile: redactionProfile,
        targetRef: field.targetRef,
        fieldName: field.fieldName,
      });
      redactionProfileRefs.push(redactionProfileRef);
    }
    const writeResult = (await input.browserWriter.fill({
      targetRef: field.targetRef,
      value,
    })) ?? { status: 'filled' as const };

    if (writeResult.status === 'blocked' || writeResult.status === 'field_error') {
      fields.push({
        targetRef: field.targetRef,
        fieldName: field.fieldName,
        status: writeResult.status,
        reason: writeResult.reason,
      });
      return buildResult(
        completedLedger.length > 0 ? 'partial' : 'no_progress',
        fields,
        [applyBlocker(field, 'fill_blocked', writeResult.reason)],
        completedLedger,
        redactionProfileRefs
      );
    }

    fields.push({
      targetRef: field.targetRef,
      fieldName: field.fieldName,
      status: 'filled',
    });
    completedLedger.push({
      targetRef: field.targetRef,
      fieldName: field.fieldName,
    });

    if (writeResult.status === 'needs_replan') {
      return buildResult(
        'needs_replan',
        fields,
        [applyBlocker(field, 'mutation_boundary', writeResult.reason)],
        completedLedger,
        redactionProfileRefs
      );
    }
  }

  const finalStopBlockers = input.plan.finalCommitmentTargets.map((target) => ({
    kind: 'final_commitment_stop',
    targetRef: target.targetRef,
    blocking: true,
  }));
  return buildResult(
    completedLedger.length > 0 ? 'filled' : 'no_progress',
    fields,
    finalStopBlockers,
    completedLedger,
    redactionProfileRefs
  );
}

export function requiresDelegatedFillAdapter(
  field: Pick<MemoryPlanField, 'providerManaged'>
): boolean {
  return field.providerManaged === true;
}

async function executeDelegatedMemoryField(
  input: {
    readonly delegatedFillDescriptors?: readonly MemoryDelegatedFillExecutionDescriptor[];
    readonly installRedactionProfile?: MemoryRedactionProfileInstaller;
  },
  field: MemoryPlanField,
  delegatedRedactionProfiles: ExactValueRedactionProfile[]
): Promise<{
  readonly status: 'filled' | 'field_errors' | 'blocked' | 'needs_replan';
  readonly outcome: MemoryApplyFieldOutcome;
  readonly blocker: MemoryPlanBlocker;
  readonly redactionProfileRefs: readonly string[];
}> {
  const descriptor = findDelegatedFillDescriptor(input.delegatedFillDescriptors, field);
  if (!descriptor) {
    return delegatedExecutionBlocked(field, 'delegated_execution_descriptor_required');
  }

  const redactionProfileRefs: string[] = [];
  const result = await executeLegacyProtectedFillGroup({
    artifactRef: descriptor.artifactRef,
    subject: descriptor.subject,
    candidate: descriptor.candidate,
    targets: descriptor.targets,
    artifactReader: descriptor.artifactReader,
    writer: descriptor.writer,
    ...(descriptor.assistiveResolver ? { assistiveResolver: descriptor.assistiveResolver } : {}),
    ...(descriptor.redactionProfileRef
      ? { redactionProfileRef: descriptor.redactionProfileRef }
      : {}),
    onProtectedRedactionProfile: async (profileRef, profile) => {
      delegatedRedactionProfiles.push(profile);
      redactionProfileRefs.push(profileRef);
      await input.installRedactionProfile?.({
        profileRef,
        profile,
        targetRef: field.targetRef,
        fieldName: field.fieldName,
      });
    },
  });

  if (result.status === 'filled') {
    return {
      status: 'filled',
      outcome: {
        targetRef: field.targetRef,
        fieldName: field.fieldName,
        status: 'filled',
      },
      blocker: applyBlocker(field, 'mutation_boundary'),
      redactionProfileRefs,
    };
  }

  if (result.status === 'field_errors') {
    return {
      status: 'field_errors',
      outcome: {
        targetRef: field.targetRef,
        fieldName: field.fieldName,
        status: 'field_error',
        reason: 'delegated_field_error',
      },
      blocker: applyBlocker(field, 'fill_blocked', 'delegated_field_error'),
      redactionProfileRefs,
    };
  }

  if (result.reason === 'target_missing' || result.reason === 'match_not_ready') {
    return {
      status: 'needs_replan',
      outcome: {
        targetRef: field.targetRef,
        fieldName: field.fieldName,
        status: 'blocked',
        reason: result.reason,
      },
      blocker: applyBlocker(field, 'mutation_boundary', result.reason),
      redactionProfileRefs,
    };
  }

  return delegatedExecutionBlocked(field, result.reason, redactionProfileRefs);
}

function delegatedExecutionBlocked(
  field: MemoryPlanField,
  reason: string,
  redactionProfileRefs: readonly string[] = []
): {
  readonly status: 'blocked';
  readonly outcome: MemoryApplyFieldOutcome;
  readonly blocker: MemoryPlanBlocker;
  readonly redactionProfileRefs: readonly string[];
} {
  return {
    status: 'blocked',
    outcome: {
      targetRef: field.targetRef,
      fieldName: field.fieldName,
      status: 'blocked',
      reason,
    },
    blocker: applyBlocker(
      field,
      field.providerManaged ? 'provider_fill_unavailable' : 'delegated_fill_unavailable',
      reason
    ),
    redactionProfileRefs,
  };
}

function findDelegatedFillDescriptor(
  descriptors: readonly MemoryDelegatedFillExecutionDescriptor[] | undefined,
  field: MemoryPlanField
): MemoryDelegatedFillExecutionDescriptor | undefined {
  return descriptors?.find((descriptor) => descriptorMatchesField(descriptor, field));
}

function descriptorMatchesField(
  descriptor: MemoryDelegatedFillExecutionDescriptor,
  field: MemoryPlanField
): boolean {
  return (
    descriptor.targetRef === field.targetRef ||
    (field.valueHandle !== undefined && descriptor.valueHandle === field.valueHandle) ||
    (field.itemRef !== undefined && descriptor.itemRef === field.itemRef) ||
    descriptor.subject.fields.some((entry) => entry.targetRef === field.targetRef)
  );
}

export function buildMemoryLlmVisibleProjection(input: {
  readonly observation: unknown;
  readonly memoryValues?: Record<string, string | undefined>;
  readonly materializedValues?: Record<string, string | undefined>;
  readonly redactionProfiles?: readonly ExactValueRedactionProfile[];
}): unknown {
  const knownValues = {
    ...(input.memoryValues ?? {}),
    ...(input.materializedValues ?? {}),
  };
  const profile = buildExactValueRedactionProfile(knownValues);
  return redactKnownMemoryValue(input.observation, [
    ...Object.values(profile.rules),
    ...(input.redactionProfiles ?? []).flatMap((entry) => Object.values(entry.rules)),
  ]);
}

function buildPlanField(
  targetRef: string,
  targetMatch: MemoryTargetMatch | undefined,
  target: MemoryObservedTarget,
  catalog: {
    readonly handles?: readonly Record<string, unknown>[];
    readonly missing?: readonly Record<string, unknown>[];
    readonly conflicts?: readonly Record<string, unknown>[];
    readonly availability?: Record<string, unknown>;
    readonly unavailable?: readonly Record<string, unknown>[];
  }
): MemoryPlanField {
  if (!targetMatch) {
    return buildUnmatchedPlanField(
      targetRef,
      target,
      target.unsupportedFrame
        ? 'unsupported_frame'
        : target.alreadyFilled
          ? 'already_filled'
          : 'memory_match_required'
    );
  }

  switch (targetMatch.status) {
    case 'matched':
      return buildMatchedPlanField(targetRef, targetMatch, target, catalog);
    case 'ambiguous':
      return buildAmbiguousPlanField(targetRef, targetMatch, target, catalog);
    case 'no_match':
      return buildUnmatchedPlanField(targetRef, target, 'memory_match_no_match');
    case 'invalid_model_output':
      return buildUnmatchedPlanField(targetRef, target, 'memory_match_invalid_model_output');
  }
}

function buildMatchedPlanField(
  targetRef: string,
  targetMatch: Extract<MemoryTargetMatch, { readonly status: 'matched' }>,
  target: MemoryObservedTarget,
  catalog: {
    readonly handles?: readonly Record<string, unknown>[];
    readonly missing?: readonly Record<string, unknown>[];
    readonly conflicts?: readonly Record<string, unknown>[];
    readonly availability?: Record<string, unknown>;
    readonly unavailable?: readonly Record<string, unknown>[];
  }
): MemoryPlanField {
  const subjectRole = readSubjectRole(target);
  const fieldIdentity = {
    targetRef,
    fieldName: targetMatch.fieldName,
    fieldRef: targetMatch.fieldRef,
    ...(targetMatch.projectionHint ? { projectionHint: targetMatch.projectionHint } : {}),
    ...(subjectRole ? { subjectRole } : {}),
  };

  if (MARKETING_FIELD_NAMES.has(targetMatch.fieldName)) {
    return {
      ...fieldIdentity,
      state: 'skipped',
      reason: 'optional_marketing_or_unrelated',
    };
  }
  if (target.unsupportedFrame) {
    return {
      ...fieldIdentity,
      state: 'unsupported_frame',
      reason: 'unsupported_frame',
    };
  }
  if (target.alreadyFilled) {
    return {
      ...fieldIdentity,
      state: 'already_filled',
    };
  }

  const providerState = providerStateForField(targetMatch, catalog);
  if (providerState) {
    return {
      ...fieldIdentity,
      state: providerState,
      reason: providerState,
    };
  }

  const conflict = findCatalogEntryByFieldRef(catalog.conflicts, targetMatch.fieldRef);
  if (conflict) {
    return {
      ...fieldIdentity,
      state: 'conflict',
      candidateHandles: readCandidateHandles(conflict),
    };
  }
  if (findCatalogEntryByFieldRef(catalog.missing, targetMatch.fieldRef)) {
    return {
      ...fieldIdentity,
      state: 'missing',
    };
  }

  const subjectConflict = subjectBindingConflict(
    catalog.handles,
    targetMatch.fieldRef,
    subjectRole
  );
  if (subjectConflict) {
    return {
      ...fieldIdentity,
      state: 'conflict',
      candidateHandles: subjectConflict,
      reason: 'subject_binding_ambiguous',
    };
  }

  const handle = findHandle(catalog.handles, targetMatch.fieldRef, subjectRole);
  if (handle) {
    return {
      ...fieldIdentity,
      state: 'ready',
      valueHandle: handle.valueHandle,
      ...(handle.itemRef ? { itemRef: handle.itemRef } : {}),
      ...(handle.subjectRole ? { subjectRole: handle.subjectRole } : {}),
      ...(handle.providerManaged ? { providerManaged: true } : {}),
      ...(handle.askBeforeUse ? { askBeforeUse: true } : {}),
    };
  }

  return {
    ...fieldIdentity,
    state: target.required ? 'missing' : 'skipped',
    reason:
      subjectRole && hasCatalogHandles(catalog.handles, targetMatch.fieldRef)
        ? 'subject_role_memory_missing'
        : target.required
          ? 'required_memory_missing'
          : 'optional_unmatched',
  };
}

function buildAmbiguousPlanField(
  targetRef: string,
  targetMatch: Extract<MemoryTargetMatch, { readonly status: 'ambiguous' }>,
  target: MemoryObservedTarget,
  catalog: {
    readonly handles?: readonly Record<string, unknown>[];
  }
): MemoryPlanField {
  if (target.unsupportedFrame) {
    return buildUnmatchedPlanField(targetRef, target, 'unsupported_frame');
  }
  if (target.alreadyFilled) {
    return buildUnmatchedPlanField(targetRef, target, 'already_filled');
  }

  const candidateHandles = targetMatch.fieldRefs.flatMap((fieldRef) =>
    matchingHandles(catalog.handles, fieldRef).map(readHandleCandidate)
  );
  const fieldName =
    candidateHandles.map((candidate) => candidate.fieldName).find(Boolean) ?? 'unknown';

  return {
    targetRef,
    fieldName,
    state: 'conflict',
    candidateHandles,
    reason: 'memory_match_ambiguous',
    ...(readSubjectRole(target) ? { subjectRole: readSubjectRole(target) } : {}),
  };
}

function buildUnmatchedPlanField(
  targetRef: string,
  target: MemoryObservedTarget,
  reason: string
): MemoryPlanField {
  const subjectRole = readSubjectRole(target);
  if (reason === 'already_filled') {
    return {
      targetRef,
      fieldName: 'unknown',
      ...(subjectRole ? { subjectRole } : {}),
      state: 'already_filled',
    };
  }
  if (reason === 'unsupported_frame') {
    return {
      targetRef,
      fieldName: 'unknown',
      ...(subjectRole ? { subjectRole } : {}),
      state: 'unsupported_frame',
      reason,
    };
  }

  return {
    targetRef,
    fieldName: 'unknown',
    ...(subjectRole ? { subjectRole } : {}),
    state: 'skipped',
    reason,
  };
}

function planBlockers(field: MemoryPlanField): MemoryPlanBlocker[] {
  const blockers: MemoryPlanBlocker[] = [];
  if (field.askBeforeUse) {
    blockers.push(applyBlocker(field, 'ask_before_use'));
  }
  if (field.state === 'missing') {
    blockers.push(applyBlocker(field, 'missing'));
  }
  if (field.state === 'conflict') {
    blockers.push(applyBlocker(field, 'conflict'));
  }
  if (
    field.state === 'provider_needs_reauth' ||
    field.state === 'provider_unavailable' ||
    field.state === 'unsupported_frame'
  ) {
    blockers.push(applyBlocker(field, field.state, field.reason));
  }
  if (
    field.state === 'skipped' &&
    (field.reason === 'field_name_required' ||
      field.reason === 'memory_match_required' ||
      field.reason === 'memory_match_no_match' ||
      field.reason === 'memory_match_invalid_model_output')
  ) {
    blockers.push(applyBlocker(field, 'unsupported_semantic_field', field.reason));
  }
  return blockers;
}

function collectPreMaterializeBlockers(fields: readonly MemoryPlanField[]): MemoryPlanBlocker[] {
  const blockers: MemoryPlanBlocker[] = [];
  for (const field of fields) {
    if (field.askBeforeUse) {
      blockers.push(applyBlocker(field, 'memory.ask_before_use'));
      continue;
    }
    if (field.state === 'missing') {
      blockers.push(applyBlocker(field, 'memory.provide_missing'));
    }
    if (field.state === 'conflict') {
      blockers.push(applyBlocker(field, 'memory.choose_candidate'));
    }
    if (field.state === 'provider_needs_reauth') {
      blockers.push(applyBlocker(field, 'memory.provider_reauth'));
    }
    if (field.state === 'provider_unavailable' || field.state === 'unsupported_frame') {
      blockers.push(applyBlocker(field, field.state));
    }
  }
  return blockers;
}

function applyBlocker(field: MemoryPlanField, kind: string, reason?: string): MemoryPlanBlocker {
  return {
    kind,
    targetRef: field.targetRef,
    fieldName: field.fieldName,

    ...(field.fieldRef ? { fieldRef: field.fieldRef } : {}),
    ...(field.fieldName ? { fieldName: field.fieldName } : {}),
    ...(field.itemRef ? { itemRef: field.itemRef } : {}),
    ...(field.subjectRole ? { subjectRole: field.subjectRole } : {}),
    ...(field.candidateHandles ? { candidates: field.candidateHandles } : {}),
    blocking: true,
    ...(reason ? { reason } : {}),
  };
}

function currentTargetBlocker(
  field: MemoryPlanField,
  targets: readonly MemoryObservedTarget[] | undefined
): MemoryPlanBlocker | null {
  if (!targets) {
    return null;
  }

  const target = targets.find((entry) => readTargetRef(entry) === field.targetRef);
  if (!target) {
    return applyBlocker(field, 'stale_target', 'target_missing');
  }
  if (target.unsupportedFrame) {
    return applyBlocker(field, 'unsupported_frame', 'unsupported_frame');
  }
  if (
    target.fillable === false ||
    target.disabled === true ||
    target.readOnly === true ||
    target.readonly === true
  ) {
    return applyBlocker(field, 'stale_target', 'target_not_fillable');
  }

  return null;
}

function stalePageBlocker(plan: MemoryFillPlan, fingerprint: string): MemoryPlanBlocker | null {
  if (plan.pageFingerprint === fingerprint) {
    return null;
  }
  return {
    kind: 'stale_page',
    reason: 'page_fingerprint_changed',
    blocking: true,
  };
}

function buildApplyResult(
  status: MemoryApplyFillResult['status'],
  fields: readonly MemoryApplyFieldOutcome[],
  blockers: readonly MemoryPlanBlocker[],
  completedLedger: MemoryApplyFillResult['completedLedger'],
  redactionProfileRefs: readonly string[],
  diagnostics?: MemoryValueFreeDiagnostics
): MemoryApplyFillResult {
  return {
    status,
    fields,
    blockers,
    completedLedger,
    redactionProfileRefs,
    finalCommitmentClicked: false,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function buildApplyProjectionDiagnostics(
  input: {
    readonly postFillObservation?: unknown;
    readonly replanObservation?: unknown;
    readonly memoryValues?: Record<string, string | undefined>;
  },
  status: MemoryApplyFillResult['status'],
  materializedValues: Record<string, string | undefined>,
  redactionProfiles: readonly ExactValueRedactionProfile[]
): MemoryValueFreeDiagnostics | undefined {
  if (status === 'needs_replan') {
    return buildProjectionDiagnostics(
      'memory_fill.replan_projection',
      input.replanObservation,
      input.memoryValues,
      materializedValues,
      redactionProfiles
    );
  }

  return buildProjectionDiagnostics(
    'memory_fill.post_fill_projection',
    input.postFillObservation,
    input.memoryValues,
    materializedValues,
    redactionProfiles
  );
}

function buildProjectionDiagnostics(
  type: string,
  observation: unknown,
  memoryValues?: Record<string, string | undefined>,
  materializedValues?: Record<string, string | undefined>,
  redactionProfiles: readonly ExactValueRedactionProfile[] = []
): MemoryValueFreeDiagnostics | undefined {
  if (observation === undefined) {
    return undefined;
  }

  return {
    events: [
      {
        type,
        observation: buildMemoryLlmVisibleProjection({
          observation,
          memoryValues,
          materializedValues,
          redactionProfiles,
        }),
      },
    ],
  };
}

function redactKnownMemoryValue(
  value: unknown,
  rules: readonly ExactValueRedactionRule[],
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactKnownMemoryText(value, rules);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth > 20) {
    return '[MaxDepth]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactKnownMemoryValue(entry, rules, seen, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactKnownMemoryValue(entry, rules, seen, depth + 1),
    ])
  );
}

function redactKnownMemoryText(value: string, rules: readonly ExactValueRedactionRule[]): string {
  if (value.length === 0 || rules.length === 0) {
    return value;
  }

  const ranges = rules
    .filter((rule) => rule.length > 0)
    .sort((left, right) => right.length - left.length)
    .flatMap((rule) =>
      rule.kind === 'digits' ? findKnownDigitRanges(value, rule) : findKnownExactRanges(value, rule)
    );

  return replaceKnownRanges(value, ranges);
}

function findKnownExactRanges(
  value: string,
  rule: ExactValueRedactionRule
): Array<{ readonly start: number; readonly end: number }> {
  if (rule.length > value.length) {
    return [];
  }

  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  for (let index = 0; index <= value.length - rule.length; index += 1) {
    const candidate = value.slice(index, index + rule.length);
    if (digestText(candidate) === rule.digest) {
      ranges.push({ start: index, end: index + rule.length });
    }
  }
  return ranges;
}

function findKnownDigitRanges(
  value: string,
  rule: ExactValueRedactionRule
): Array<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  const digitRunPattern = /[\d\s./-]{4,}/g;
  let match: RegExpExecArray | null;
  while ((match = digitRunPattern.exec(value)) !== null) {
    const raw = match[0] ?? '';
    const digits = [...raw]
      .map((char, offset) => ({ char, offset }))
      .filter(({ char }) => /\d/.test(char));
    if (digits.length < rule.length) {
      continue;
    }

    for (let index = 0; index <= digits.length - rule.length; index += 1) {
      const window = digits.slice(index, index + rule.length);
      const candidate = window.map(({ char }) => char).join('');
      if (digestText(candidate) !== rule.digest) {
        continue;
      }
      const first = window[0]!;
      const last = window.at(-1)!;
      ranges.push({
        start: match.index + first.offset,
        end: match.index + last.offset + 1,
      });
    }
  }
  return ranges;
}

function replaceKnownRanges(
  value: string,
  ranges: Array<{ readonly start: number; readonly end: number }>
): string {
  if (ranges.length === 0) {
    return value;
  }

  const merged: Array<{ readonly start: number; readonly end: number }> = [];
  for (const range of ranges
    .filter((entry) => entry.end > entry.start)
    .sort((left, right) => left.start - right.start || right.end - left.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }

  let output = '';
  let cursor = 0;
  for (const range of merged) {
    output += value.slice(cursor, range.start);
    output += '[REDACTED]';
    cursor = range.end;
  }
  output += value.slice(cursor);
  return output;
}

function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function providerStateForField(
  field: {
    readonly fieldRef: string;
    readonly fieldName: string;
  },
  catalog: {
    readonly handles?: readonly Record<string, unknown>[];
    readonly availability?: Record<string, unknown>;
    readonly unavailable?: readonly Record<string, unknown>[];
  }
): Extract<MemoryFillFieldState, 'provider_needs_reauth' | 'provider_unavailable'> | null {
  if (findCatalogEntryByFieldRef(catalog.unavailable, field.fieldRef)) {
    return 'provider_unavailable';
  }
  const availability = asRecord(
    catalog.availability?.[field.fieldRef] ?? catalog.availability?.[field.fieldName]
  );
  if (availability.status === 'needs_reauth') {
    return 'provider_needs_reauth';
  }
  if (availability.status === 'unavailable') {
    return 'provider_unavailable';
  }
  const providerHandle = matchingHandles(catalog.handles, field.fieldRef).find(
    isProviderHandleRecord
  );
  if (!providerHandle) {
    return null;
  }
  return null;
}

function catalogOnlyBlockers(
  entries: readonly Record<string, unknown>[] | undefined,
  kind: string
): MemoryPlanBlocker[] {
  return (entries ?? []).flatMap((entry): MemoryPlanBlocker[] => {
    const fieldName = readFieldName(entry);
    if (!fieldName) {
      return [];
    }
    return [
      {
        kind,
        fieldName,
        ...(kind === 'conflict' ? { candidates: readCandidateHandles(entry) } : {}),
        blocking: true,
      },
    ];
  });
}

function findHandle(
  handles: readonly Record<string, unknown>[] | undefined,
  fieldRef: string,
  subjectRole?: string
): {
  valueHandle: string;
  itemRef?: string;
  askBeforeUse?: boolean;
  subjectRole?: string;
  providerManaged?: boolean;
} | null {
  const candidates = matchingHandles(handles, fieldRef);
  const handle = subjectRole
    ? candidates.find((entry) => readSubjectRole(entry) === subjectRole)
    : candidates[0];
  if (!handle) {
    return null;
  }
  const itemRef = readItemRef(handle);
  const handleSubjectRole = readSubjectRole(handle);
  return {
    valueHandle:
      firstString(
        handle.handle,
        handle.valueHandle,
        asRecord(handle.valueHandle).ref,
        asRecord(handle.value_handle).ref
      ) ?? `handle_${digestStable(handle).slice(0, 16)}`,
    ...(itemRef ? { itemRef } : {}),
    ...(handleSubjectRole ? { subjectRole: handleSubjectRole } : {}),
    ...(handle.askBeforeUse === true || handle.ask_before_use === true
      ? { askBeforeUse: true }
      : {}),
    ...(isProviderHandleRecord(handle) ? { providerManaged: true } : {}),
  };
}

function matchingHandles(
  handles: readonly Record<string, unknown>[] | undefined,
  fieldRef: string
): Record<string, unknown>[] {
  return (handles ?? []).filter((entry) => readFieldRef(entry) === fieldRef);
}

function hasCatalogHandles(
  handles: readonly Record<string, unknown>[] | undefined,
  fieldRef: string
): boolean {
  return matchingHandles(handles, fieldRef).length > 0;
}

function subjectBindingConflict(
  handles: readonly Record<string, unknown>[] | undefined,
  fieldRef: string,
  subjectRole?: string
): MemoryCandidateHandle[] | null {
  const candidates = matchingHandles(handles, fieldRef);
  if (candidates.length <= 1) {
    return null;
  }

  if (subjectRole) {
    const matchingSubject = candidates.filter((entry) => readSubjectRole(entry) === subjectRole);
    return matchingSubject.length > 1 ? matchingSubject.map(readHandleCandidate) : null;
  }

  const subjectRoles = new Set(
    candidates.flatMap((entry) => {
      const role = readSubjectRole(entry);
      return role ? [role] : [];
    })
  );
  return subjectRoles.size > 1 ? candidates.map(readHandleCandidate) : null;
}

function readHandleCandidate(entry: Record<string, unknown>): MemoryCandidateHandle {
  const subjectRole = readSubjectRole(entry);
  const fieldRef = readFieldRef(entry);
  const fieldName = readFieldName(entry);
  return {
    itemRef:
      readItemRef(entry) ??
      `memory_item_${digestStable({ fieldRef, fieldName, subjectRole }).slice(0, 16)}`,
    safeLabel: firstString(entry.safeLabel, entry.safe_label) ?? 'Memory item',
    ...(fieldRef ? { fieldRef } : {}),
    ...(fieldName ? { fieldName } : {}),
    ...(firstString(entry.valueHandle, entry.handle)
      ? { valueHandle: firstString(entry.valueHandle, entry.handle) }
      : {}),
    ...(isProviderHandleRecord(entry) ? { providerManaged: true } : {}),
    ...(subjectRole ? { subjectRole } : {}),
  };
}

function findCatalogEntryByFieldRef(
  entries: readonly Record<string, unknown>[] | undefined,
  fieldRef: string
): Record<string, unknown> | undefined {
  return entries?.find((entry) => readFieldRef(entry) === fieldRef);
}

function readCandidateHandles(entry: Record<string, unknown>): MemoryCandidateHandle[] {
  const rawCandidates = Array.isArray(entry.candidates) ? entry.candidates : [];
  return rawCandidates.flatMap((candidate): MemoryCandidateHandle[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return [];
    }
    const record = candidate as Record<string, unknown>;
    return [
      {
        itemRef: readItemRef(record) ?? 'memory_item',
        safeLabel: firstString(record.safeLabel, record.safe_label) ?? 'Memory item',
        ...(readFieldRef(record) ? { fieldRef: readFieldRef(record) } : {}),
        ...(readFieldName(record) ? { fieldName: readFieldName(record) } : {}),
        ...(firstString(record.valueHandle, record.handle)
          ? { valueHandle: firstString(record.valueHandle, record.handle) }
          : {}),
        ...(isProviderHandleRecord(record) ? { providerManaged: true } : {}),
        ...(readSubjectRole(record) ? { subjectRole: readSubjectRole(record) } : {}),
      },
    ];
  });
}

function dedupeBlockers(blockers: readonly MemoryPlanBlocker[]): MemoryPlanBlocker[] {
  const seen = new Set<string>();
  const out: MemoryPlanBlocker[] = [];
  for (const blocker of blockers) {
    const key = `${blocker.kind}:${blocker.targetRef ?? ''}:${blocker.fieldName ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(blocker);
  }
  return out;
}

function readTargetRef(target: MemoryObservedTarget): string | undefined {
  return firstString(target.targetRef, target.ref, target.id);
}

function readSubjectRole(
  entry: MemoryObservedTarget | Record<string, unknown>
): string | undefined {
  return firstString(
    (entry as Record<string, unknown>).subjectRole,
    (entry as Record<string, unknown>).subject_role
  );
}

function isFinalCommitmentTarget(target: MemoryObservedTarget): boolean {
  return target.action === 'final_commitment';
}

function indexTargetMatches(
  matches: readonly MemoryTargetMatch[] | undefined
): ReadonlyMap<string, MemoryTargetMatch> {
  return new Map((matches ?? []).map((match) => [match.targetRef, match]));
}

function readFieldRef(entry: Record<string, unknown>): string | undefined {
  return firstString(entry.fieldRef, entry.field_ref, entry.ref);
}

function readFieldName(entry: Record<string, unknown>): string | undefined {
  return firstString(entry.fieldName, entry.field_name, entry.name);
}

function isProviderHandleRecord(entry: Record<string, unknown>): boolean {
  const valueHandle = asRecord(entry.valueHandle ?? entry.value_handle);
  return (
    entry.providerManaged === true ||
    entry.provider_managed === true ||
    valueHandle.resolver === 'provider' ||
    valueHandle.valueClass === 'provider_ref' ||
    valueHandle.value_class === 'provider_ref'
  );
}

function readItemRef(entry: Record<string, unknown>): string | undefined {
  return firstString(entry.itemRef, entry.item_ref);
}

function stringifyRuntimeOnlyValue(value: string | number | { readonly value?: unknown }): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return value.value === undefined || value.value === null ? '' : String(value.value);
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
