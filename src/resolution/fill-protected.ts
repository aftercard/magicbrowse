import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import {
  buildProtectedExactValueProfile,
  type ProtectedExactValueProfile,
} from '../redaction.js';
import type {
  MagicBrowseMatchGroupResult,
  MagicBrowseMatchGroupCandidate,
  MagicBrowseMatchGroupField,
  MagicBrowseMatchGroupSubject,
  MagicBrowseProtectedFieldPolicy,
} from './match.js';
import {
  projectProtectedFillOperations,
  type MagicBrowseProtectedProjectionErrorReason,
  type MagicBrowseProtectedProjectionTarget,
} from './protected-projection.js';

export type FillProtectedGroupStatus = 'filled' | 'field_errors' | 'blocked';

export type FillProtectedGroupBlockedReason =
  | MagicBrowseProtectedProjectionErrorReason
  | 'artifact_unavailable'
  | 'target_missing'
  | 'unsupported_protected_field_group'
  | 'invalid_expiry_value'
  | 'match_not_ready'
  | 'unknown_candidate_ref'
  | 'assistive_low_confidence'
  | 'assistive_unavailable';

export interface ProtectedFilledFieldRef {
  readonly fieldKey: string;
  readonly targetRef: string;
}

export interface ProtectedFieldFillError extends ProtectedFilledFieldRef {
  readonly reason: 'value_not_applied';
}

export interface MagicBrowseProtectedArtifactReadInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
}

export type MagicBrowseProtectedArtifactReadResult =
  | {
      readonly status: 'resolved';
      readonly values: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'artifact_unavailable';
    };

export interface MagicBrowseProtectedArtifactReader {
  read(input: MagicBrowseProtectedArtifactReadInput): Promise<MagicBrowseProtectedArtifactReadResult>;
}

export interface MagicBrowseProtectedAssistiveBinding {
  readonly fieldKey: string;
  readonly targetRef: string;
  readonly valueHint?: string;
  readonly label?: string;
  readonly protectedValue: string;
  readonly target: MagicBrowseProtectedFillTargetDescriptor;
}

export interface MagicBrowseProtectedAssistiveResolutionInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
  readonly bindings: readonly MagicBrowseProtectedAssistiveBinding[];
}

export type MagicBrowseProtectedAssistiveResolutionResult =
  | {
      readonly status: 'resolved';
      readonly confidence: 'high' | 'medium' | 'low';
      readonly values: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly status: 'unavailable';
    }
  | {
      readonly status: 'blocked';
      readonly reason?: string;
    };

export interface MagicBrowseProtectedAssistiveResolver {
  resolve(
    input: MagicBrowseProtectedAssistiveResolutionInput
  ): Promise<MagicBrowseProtectedAssistiveResolutionResult>;
}

export interface MagicBrowseProtectedFillTargetDescriptor extends MagicBrowseProtectedProjectionTarget {
  readonly kind?: string;
  readonly selectorMapIndex?: number;
}

export interface MagicBrowseProtectedFieldWriter {
  fill(input: {
    readonly targetRef: string;
    readonly value: string;
  }): Promise<void>;
}

export interface FillProtectedGroupInput {
  readonly sessionId?: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly match: MagicBrowseMatchGroupResult;
  readonly candidates: readonly MagicBrowseMatchGroupCandidate[];
  readonly artifactReader: MagicBrowseProtectedArtifactReader;
  readonly assistiveResolver?: MagicBrowseProtectedAssistiveResolver;
}

export interface FillProtectedGroupExecutionInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
  readonly targets: readonly MagicBrowseProtectedFillTargetDescriptor[];
  readonly artifactReader: MagicBrowseProtectedArtifactReader;
  readonly writer: MagicBrowseProtectedFieldWriter;
  readonly assistiveResolver?: MagicBrowseProtectedAssistiveResolver;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly redactionProfileRef?: string;
  readonly onProtectedRedactionProfile?: (
    profileRef: string,
    profile: ProtectedExactValueProfile
  ) => void | Promise<void>;
}

export type FillProtectedGroupResult =
  | {
      readonly status: 'filled';
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly filledFields: readonly ProtectedFilledFieldRef[];
      readonly summary: string;
    }
  | {
      readonly status: 'field_errors';
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly filledFields: readonly ProtectedFilledFieldRef[];
      readonly fieldErrors: readonly ProtectedFieldFillError[];
      readonly summary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: FillProtectedGroupBlockedReason;
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly targetRef?: string;
      readonly fieldKey?: string;
      readonly summary: string;
    };

type PreparedProtectedFillOperation = {
  readonly targetRef: string;
  readonly target: MagicBrowseProtectedFillTargetDescriptor;
  readonly value: string;
  readonly fields: readonly ProtectedFilledFieldRef[];
  readonly assistiveFallback?: MagicBrowseProtectedAssistiveBinding;
};

type PreparedProjectedField = {
  readonly field: MagicBrowseMatchGroupField;
  readonly target: MagicBrowseProtectedFillTargetDescriptor;
  readonly deterministicValue: string;
  readonly fields: readonly ProtectedFilledFieldRef[];
  readonly assistive: boolean;
  readonly selectAssistiveFallback: boolean;
};

type PrepareProtectedFillOperationsResult =
  | {
      readonly status: 'ready';
      readonly operations: readonly PreparedProtectedFillOperation[];
    }
  | {
      readonly status: 'blocked';
      readonly reason: FillProtectedGroupBlockedReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    };

export async function fillProtectedGroup(
  input: FillProtectedGroupExecutionInput
): Promise<FillProtectedGroupResult> {
  await appendProtectedFillEvent(input, 'protected_fill.start', {
    status: 'started',
    fillRef: input.subject.fillRef,
    candidateRef: input.candidate.candidateRef,
    artifactRef: input.artifactRef,
    fieldKeys: uniqueFieldKeys(input.subject.fields),
    ...(input.candidate.fieldPolicies ? { fieldPolicies: input.candidate.fieldPolicies } : {}),
  });

  const targetValidation = validateProtectedFillTargets(input);
  if (targetValidation.status === 'blocked') {
    return block(input, targetValidation.reason, {
      targetRef: targetValidation.targetRef,
      fieldKey: targetValidation.fieldKey,
    });
  }

  const artifact = await input.artifactReader.read({
    artifactRef: input.artifactRef,
    subject: input.subject,
    candidate: input.candidate,
  });
  if (artifact.status === 'blocked') {
    return block(input, artifact.reason);
  }

  const profile = buildProtectedExactValueProfile(artifact.values);
  if (Object.keys(profile.rules).length > 0) {
    const profileRef = input.redactionProfileRef ?? input.artifactRef;
    await input.runRecorder?.update({
      protectedRedactionProfiles: {
        [profileRef]: profile,
      },
    });
    await input.onProtectedRedactionProfile?.(profileRef, profile);
  }

  const prepared = await prepareProtectedFillOperations(input, artifact.values);
  if (prepared.status === 'blocked') {
    return block(input, prepared.reason, {
      targetRef: prepared.targetRef,
      fieldKey: prepared.fieldKey,
    });
  }

  const filledFields: ProtectedFilledFieldRef[] = [];
  const fieldErrors: ProtectedFieldFillError[] = [];
  for (const operation of prepared.operations) {
    try {
      await input.writer.fill({
        targetRef: operation.targetRef,
        value: operation.value,
      });
      filledFields.push(...operation.fields);
    } catch {
      const fallbackResult = await fillWithAssistiveFallback(input, operation);
      if (fallbackResult.status === 'filled') {
        filledFields.push(...operation.fields);
        continue;
      }
      if (fallbackResult.status === 'blocked') {
        return block(input, fallbackResult.reason, {
          targetRef: fallbackResult.targetRef,
          fieldKey: fallbackResult.fieldKey,
        });
      }
      fieldErrors.push(
        ...operation.fields.map((field) => ({
          ...field,
          reason: 'value_not_applied' as const,
        }))
      );
      break;
    }
  }

  if (fieldErrors.length > 0) {
    const result: FillProtectedGroupResult = {
      status: 'field_errors',
      fillRef: input.subject.fillRef,
      candidateRef: input.candidate.candidateRef,
      artifactRef: input.artifactRef,
      filledFields,
      fieldErrors,
      summary: buildSummary('field_errors', input, {
        fieldCount: filledFields.length,
      }),
    };
    await appendProtectedFillEvent(input, 'protected_fill.field_errors', {
      status: result.status,
      fillRef: result.fillRef,
      candidateRef: result.candidateRef,
      artifactRef: result.artifactRef,
      filledFields: result.filledFields,
      fieldErrors: result.fieldErrors,
    });
    return result;
  }

  const result: FillProtectedGroupResult = {
    status: 'filled',
    fillRef: input.subject.fillRef,
    candidateRef: input.candidate.candidateRef,
    artifactRef: input.artifactRef,
    filledFields,
    summary: buildSummary('filled', input, {
      fieldCount: filledFields.length,
    }),
  };
  await appendProtectedFillEvent(input, 'protected_fill.complete', {
    status: result.status,
    fillRef: result.fillRef,
    candidateRef: result.candidateRef,
    artifactRef: result.artifactRef,
    filledFields: result.filledFields,
  });
  return result;
}

async function prepareProtectedFillOperations(
  input: FillProtectedGroupExecutionInput,
  protectedValues: Readonly<Record<string, string | undefined>>
): Promise<PrepareProtectedFillOperationsResult> {
  const targetByRef = new Map(input.targets.map((target) => [target.targetRef, target]));
  const projected = projectProtectedFillOperations({
    fields: input.subject.fields,
    targets: input.targets,
    protectedValues,
  });
  if (projected.status === 'blocked') {
    return projected;
  }

  const preparedFields: PreparedProjectedField[] = [];
  const projectedOperations: Array<
    | {
        readonly kind: 'operation';
        readonly operation: PreparedProtectedFillOperation;
      }
    | {
        readonly kind: 'field';
        readonly field: PreparedProjectedField;
      }
  > = [];

  for (const operation of projected.operations) {
    const target = targetByRef.get(operation.targetRef);
    if (!target) {
      return {
        status: 'blocked',
        reason: 'target_missing',
        targetRef: operation.targetRef,
        fieldKey: operation.fields[0]?.fieldKey,
      };
    }

    const fields = operation.fields.map(fieldRef);
    if (operation.fields.length !== 1) {
      projectedOperations.push({
        kind: 'operation',
        operation: {
          targetRef: operation.targetRef,
          target,
          value: operation.value,
          fields,
        },
      });
      continue;
    }

    const field = operation.fields[0]!;
    const assistiveEligible =
      resolveProtectedFieldPolicy(input.candidate, field.fieldKey) === 'llm_assisted' &&
      shouldAssistProtectedField(field);
    const preparedField: PreparedProjectedField = {
      field,
      target,
      deterministicValue: operation.value,
      fields,
      assistive: target.kind !== 'select' && assistiveEligible,
      selectAssistiveFallback: target.kind === 'select' && assistiveEligible,
    };
    preparedFields.push(preparedField);
    projectedOperations.push({
      kind: 'field',
      field: preparedField,
    });
  }

  const assistiveValues = await resolveAssistiveValues(input, protectedValues, preparedFields);
  if (assistiveValues.status === 'blocked') {
    return assistiveValues;
  }

  const operations = projectedOperations.map((item): PreparedProtectedFillOperation => {
    if (item.kind === 'operation') {
      return item.operation;
    }

    const preparedField = item.field;
    const targetRef = preparedField.field.targetRef;
    const value =
      assistiveValues.values.get(targetRef) ??
      assistiveValues.values.get(`${preparedField.field.fieldKey}:${targetRef}`) ??
      preparedField.deterministicValue;
    const protectedValue = protectedValues[preparedField.field.fieldKey];
    const assistiveFallback =
      preparedField.selectAssistiveFallback &&
      typeof protectedValue === 'string' &&
      protectedValue.trim().length > 0
        ? {
            fieldKey: preparedField.field.fieldKey,
            targetRef,
            ...(preparedField.field.valueHint ? { valueHint: preparedField.field.valueHint } : {}),
            ...(preparedField.field.label ? { label: preparedField.field.label } : {}),
            protectedValue: protectedValue.trim(),
            target: preparedField.target,
          }
        : undefined;
    return {
      targetRef,
      target: preparedField.target,
      value,
      fields: preparedField.fields,
      ...(assistiveFallback ? { assistiveFallback } : {}),
    };
  });

  return {
    status: 'ready',
    operations,
  };
}

function validateProtectedFillTargets(
  input: FillProtectedGroupExecutionInput
):
  | {
      readonly status: 'ready';
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'target_missing';
      readonly targetRef: string;
      readonly fieldKey?: string;
    } {
  const targetRefs = new Set(input.targets.map((target) => target.targetRef));
  for (const field of input.subject.fields) {
    if (!targetRefs.has(field.targetRef)) {
      return {
        status: 'blocked',
        reason: 'target_missing',
        targetRef: field.targetRef,
        fieldKey: field.fieldKey,
      };
    }
  }
  return { status: 'ready' };
}

async function fillWithAssistiveFallback(
  input: FillProtectedGroupExecutionInput,
  operation: PreparedProtectedFillOperation
): Promise<
  | { readonly status: 'filled' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'blocked';
      readonly reason: FillProtectedGroupBlockedReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    }
> {
  if (!operation.assistiveFallback || !input.assistiveResolver) {
    return { status: 'unavailable' };
  }

  const resolution = await input.assistiveResolver.resolve({
    artifactRef: input.artifactRef,
    subject: input.subject,
    candidate: input.candidate,
    bindings: [operation.assistiveFallback],
  });
  if (resolution.status === 'unavailable') {
    return { status: 'unavailable' };
  }
  if (resolution.status === 'blocked') {
    return {
      status: 'blocked',
      reason: 'assistive_unavailable',
      targetRef: operation.assistiveFallback.targetRef,
      fieldKey: operation.assistiveFallback.fieldKey,
    };
  }
  if (resolution.confidence === 'low') {
    return {
      status: 'blocked',
      reason: 'assistive_low_confidence',
      targetRef: operation.assistiveFallback.targetRef,
      fieldKey: operation.assistiveFallback.fieldKey,
    };
  }

  const value =
    resolution.values[operation.targetRef] ??
    resolution.values[`${operation.assistiveFallback.fieldKey}:${operation.targetRef}`];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { status: 'unavailable' };
  }

  try {
    await input.writer.fill({
      targetRef: operation.targetRef,
      value: value.trim(),
    });
    return { status: 'filled' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function resolveAssistiveValues(
  input: FillProtectedGroupExecutionInput,
  protectedValues: Readonly<Record<string, string | undefined>>,
  preparedFields: readonly {
    readonly field: MagicBrowseMatchGroupField;
    readonly target: MagicBrowseProtectedFillTargetDescriptor;
    readonly deterministicValue: string;
    readonly assistive: boolean;
    readonly selectAssistiveFallback: boolean;
  }[]
): Promise<
  | {
      readonly status: 'ready';
      readonly values: ReadonlyMap<string, string>;
    }
  | {
      readonly status: 'blocked';
      readonly reason: FillProtectedGroupBlockedReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    }
> {
  const assistiveBindings: MagicBrowseProtectedAssistiveBinding[] = [];
  for (const item of preparedFields) {
    if (!item.assistive) {
      continue;
    }
    const protectedValue = protectedValues[item.field.fieldKey];
    if (typeof protectedValue !== 'string' || protectedValue.trim().length === 0) {
      return {
        status: 'blocked',
        reason: 'missing_protected_value',
        targetRef: item.field.targetRef,
        fieldKey: item.field.fieldKey,
      };
    }
    assistiveBindings.push({
      fieldKey: item.field.fieldKey,
      targetRef: item.field.targetRef,
      ...(item.field.valueHint ? { valueHint: item.field.valueHint } : {}),
      ...(item.field.label ? { label: item.field.label } : {}),
      protectedValue: protectedValue.trim(),
      target: item.target,
    });
  }

  if (assistiveBindings.length === 0 || !input.assistiveResolver) {
    return {
      status: 'ready',
      values: new Map(),
    };
  }

  const resolution = await input.assistiveResolver.resolve({
    artifactRef: input.artifactRef,
    subject: input.subject,
    candidate: input.candidate,
    bindings: assistiveBindings,
  });
  if (resolution.status === 'unavailable') {
    return {
      status: 'ready',
      values: new Map(),
    };
  }
  if (resolution.status === 'blocked') {
    return {
      status: 'blocked',
      reason: 'assistive_unavailable',
      targetRef: assistiveBindings[0]?.targetRef,
      fieldKey: assistiveBindings[0]?.fieldKey,
    };
  }
  if (resolution.confidence === 'low') {
    return {
      status: 'blocked',
      reason: 'assistive_low_confidence',
      targetRef: assistiveBindings[0]?.targetRef,
      fieldKey: assistiveBindings[0]?.fieldKey,
    };
  }

  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(resolution.values)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      values.set(key, value.trim());
    }
  }

  return {
    status: 'ready',
    values,
  };
}

function shouldAssistProtectedField(field: MagicBrowseMatchGroupField): boolean {
  if (field.fieldKey === 'full_name' || field.fieldKey === 'date_of_birth') {
    return false;
  }
  if (field.fieldKey === 'exp_month' || field.fieldKey === 'exp_year') {
    return false;
  }
  return true;
}

function uniqueFieldKeys(fields: readonly MagicBrowseMatchGroupField[]): readonly string[] {
  return [...new Set(fields.map((field) => field.fieldKey))];
}

function fieldRef(field: MagicBrowseMatchGroupField): ProtectedFilledFieldRef {
  return {
    fieldKey: field.fieldKey,
    targetRef: field.targetRef,
  };
}

async function block(
  input: FillProtectedGroupExecutionInput,
  reason: FillProtectedGroupBlockedReason,
  refs: {
    readonly targetRef?: string;
    readonly fieldKey?: string;
  } = {}
): Promise<FillProtectedGroupResult> {
  const result: FillProtectedGroupResult = {
    status: 'blocked',
    reason,
    fillRef: input.subject.fillRef,
    candidateRef: input.candidate.candidateRef,
    artifactRef: input.artifactRef,
    ...(refs.targetRef ? { targetRef: refs.targetRef } : {}),
    ...(refs.fieldKey ? { fieldKey: refs.fieldKey } : {}),
    summary: buildSummary('blocked', input, {
      reason,
    }),
  };
  await appendProtectedFillEvent(input, 'protected_fill.blocked', {
    status: result.status,
    reason,
    fillRef: result.fillRef,
    candidateRef: result.candidateRef,
    artifactRef: result.artifactRef,
    targetRef: result.targetRef,
    fieldKey: result.fieldKey,
  });
  return result;
}

function buildSummary(
  status: FillProtectedGroupStatus,
  input: FillProtectedGroupExecutionInput,
  details: {
    readonly fieldCount?: number;
    readonly reason?: FillProtectedGroupBlockedReason;
  } = {}
): string {
  const pieces = [
    `protected_fill ${status}`,
    `fill=${input.subject.fillRef}`,
    `candidate=${input.candidate.candidateRef}`,
    typeof details.fieldCount === 'number' ? `fields=${details.fieldCount}` : undefined,
    details.reason ? `reason=${details.reason}` : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.join(' ');
}

async function appendProtectedFillEvent(
  input: FillProtectedGroupExecutionInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  await input.runRecorder?.append({
    type,
    level: type === 'protected_fill.field_errors' ? 'warn' : 'info',
    data: omitUndefined({
      sessionId: input.runRecorder.sessionId,
      runId: input.runRecorder.runId,
      ...data,
    }),
  });
}

function resolveProtectedFieldPolicy(
  candidate: MagicBrowseMatchGroupCandidate,
  fieldKey: string
): MagicBrowseProtectedFieldPolicy {
  return candidate.fieldPolicies?.[fieldKey] ?? 'deterministic_only';
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}

export const __testFillProtected = {
  resolveProtectedFieldPolicy,
};
