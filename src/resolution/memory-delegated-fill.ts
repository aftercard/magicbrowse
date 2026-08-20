import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import { buildExactValueRedactionProfile, type ExactValueRedactionProfile } from '../redaction.js';
import type {
  MagicBrowseMatchGroupResult,
  MagicBrowseMatchGroupCandidate,
  MagicBrowseMatchGroupField,
  MagicBrowseMatchGroupSubject,
  MagicBrowseMemoryFieldPolicy,
} from './match.js';
import {
  projectMemoryDelegatedFillOperations,
  type MagicBrowseMemoryDelegatedProjectionErrorReason,
  type MagicBrowseMemoryDelegatedProjectionTarget,
} from './memory-delegated-projection.js';

export type MemoryDelegatedFillStatus = 'filled' | 'field_errors' | 'blocked';

export type MemoryDelegatedFillBlockedReason =
  | MagicBrowseMemoryDelegatedProjectionErrorReason
  | 'artifact_unavailable'
  | 'target_missing'
  | 'unsupported_memory_field_group'
  | 'invalid_expiry_value'
  | 'match_not_ready'
  | 'unknown_candidate_ref'
  | 'assistive_low_confidence'
  | 'assistive_unavailable';

export interface MemoryDelegatedFilledFieldRef {
  readonly fieldKey: string;
  readonly targetRef: string;
}

export interface MemoryDelegatedFieldFillError extends MemoryDelegatedFilledFieldRef {
  readonly reason: 'value_not_applied';
}

export interface MagicBrowseMemoryDelegatedArtifactReadInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
}

export type MagicBrowseMemoryDelegatedArtifactReadResult =
  | {
      readonly status: 'resolved';
      readonly values: Readonly<Record<string, string | undefined>>;
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'artifact_unavailable';
    };

export interface MagicBrowseMemoryDelegatedArtifactReader {
  read(
    input: MagicBrowseMemoryDelegatedArtifactReadInput
  ): Promise<MagicBrowseMemoryDelegatedArtifactReadResult>;
}

export interface MagicBrowseMemoryDelegatedAssistiveBinding {
  readonly fieldKey: string;
  readonly targetRef: string;
  readonly valueHint?: string;
  readonly label?: string;
  readonly memoryValue: string;
  readonly target: MagicBrowseMemoryDelegatedFillTargetDescriptor;
}

export interface MagicBrowseMemoryDelegatedAssistiveResolutionInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
  readonly bindings: readonly MagicBrowseMemoryDelegatedAssistiveBinding[];
}

export type MagicBrowseMemoryDelegatedAssistiveResolutionResult =
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

export interface MagicBrowseMemoryDelegatedAssistiveResolver {
  resolve(
    input: MagicBrowseMemoryDelegatedAssistiveResolutionInput
  ): Promise<MagicBrowseMemoryDelegatedAssistiveResolutionResult>;
}

export interface MagicBrowseMemoryDelegatedFillTargetDescriptor
  extends MagicBrowseMemoryDelegatedProjectionTarget {
  readonly kind?: string;
  readonly selectorMapIndex?: number;
}

export interface MagicBrowseMemoryDelegatedFieldWriter {
  fill(input: {
    readonly targetRef: string;
    readonly value: string;
  }): Promise<void>;
}

export interface MemoryDelegatedFillInput {
  readonly sessionId?: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly match: MagicBrowseMatchGroupResult;
  readonly candidates: readonly MagicBrowseMatchGroupCandidate[];
  readonly artifactReader: MagicBrowseMemoryDelegatedArtifactReader;
  readonly assistiveResolver?: MagicBrowseMemoryDelegatedAssistiveResolver;
}

export interface MemoryDelegatedFillExecutionInput {
  readonly artifactRef: string;
  readonly subject: MagicBrowseMatchGroupSubject;
  readonly candidate: MagicBrowseMatchGroupCandidate;
  readonly targets: readonly MagicBrowseMemoryDelegatedFillTargetDescriptor[];
  readonly artifactReader: MagicBrowseMemoryDelegatedArtifactReader;
  readonly writer: MagicBrowseMemoryDelegatedFieldWriter;
  readonly assistiveResolver?: MagicBrowseMemoryDelegatedAssistiveResolver;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly redactionProfileRef?: string;
  readonly onRedactionProfile?: (
    profileRef: string,
    profile: ExactValueRedactionProfile
  ) => void | Promise<void>;
}

export type MemoryDelegatedFillResult =
  | {
      readonly status: 'filled';
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly filledFields: readonly MemoryDelegatedFilledFieldRef[];
      readonly summary: string;
    }
  | {
      readonly status: 'field_errors';
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly filledFields: readonly MemoryDelegatedFilledFieldRef[];
      readonly fieldErrors: readonly MemoryDelegatedFieldFillError[];
      readonly summary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: MemoryDelegatedFillBlockedReason;
      readonly fillRef: string;
      readonly candidateRef: string;
      readonly artifactRef: string;
      readonly targetRef?: string;
      readonly fieldKey?: string;
      readonly summary: string;
    };

type PreparedMemoryDelegatedFillOperation = {
  readonly targetRef: string;
  readonly target: MagicBrowseMemoryDelegatedFillTargetDescriptor;
  readonly value: string;
  readonly fields: readonly MemoryDelegatedFilledFieldRef[];
  readonly assistiveFallback?: MagicBrowseMemoryDelegatedAssistiveBinding;
};

type PreparedProjectedField = {
  readonly field: MagicBrowseMatchGroupField;
  readonly target: MagicBrowseMemoryDelegatedFillTargetDescriptor;
  readonly deterministicValue: string;
  readonly fields: readonly MemoryDelegatedFilledFieldRef[];
  readonly assistive: boolean;
  readonly selectAssistiveFallback: boolean;
};

type PrepareMemoryDelegatedFillOperationsResult =
  | {
      readonly status: 'ready';
      readonly operations: readonly PreparedMemoryDelegatedFillOperation[];
    }
  | {
      readonly status: 'blocked';
      readonly reason: MemoryDelegatedFillBlockedReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    };

export async function executeMemoryDelegatedFill(
  input: MemoryDelegatedFillExecutionInput
): Promise<MemoryDelegatedFillResult> {
  await appendMemoryDelegatedFillEvent(input, 'memory_delegated_fill.start', {
    status: 'started',
    fillRef: input.subject.fillRef,
    candidateRef: input.candidate.candidateRef,
    artifactRef: input.artifactRef,
    fieldKeys: uniqueFieldKeys(input.subject.fields),
    ...(input.candidate.fieldPolicies ? { fieldPolicies: input.candidate.fieldPolicies } : {}),
  });

  const targetValidation = validateMemoryDelegatedFillTargets(input);
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

  const profile = buildExactValueRedactionProfile(
    Object.fromEntries(
      Object.entries(artifact.values).filter(([fieldKey]) => modelHiddenMemoryFieldKey(fieldKey))
    )
  );
  if (Object.keys(profile.rules).length > 0) {
    const profileRef = input.redactionProfileRef ?? input.artifactRef;
    await input.runRecorder?.update({
      redactionProfiles: {
        [profileRef]: profile,
      },
    });
    await input.onRedactionProfile?.(profileRef, profile);
  }

  const prepared = await prepareMemoryDelegatedFillOperations(input, artifact.values);
  if (prepared.status === 'blocked') {
    return block(input, prepared.reason, {
      targetRef: prepared.targetRef,
      fieldKey: prepared.fieldKey,
    });
  }

  const filledFields: MemoryDelegatedFilledFieldRef[] = [];
  const fieldErrors: MemoryDelegatedFieldFillError[] = [];
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
    const result: MemoryDelegatedFillResult = {
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
    await appendMemoryDelegatedFillEvent(input, 'memory_delegated_fill.field_errors', {
      status: result.status,
      fillRef: result.fillRef,
      candidateRef: result.candidateRef,
      artifactRef: result.artifactRef,
      filledFields: result.filledFields,
      fieldErrors: result.fieldErrors,
    });
    return result;
  }

  const result: MemoryDelegatedFillResult = {
    status: 'filled',
    fillRef: input.subject.fillRef,
    candidateRef: input.candidate.candidateRef,
    artifactRef: input.artifactRef,
    filledFields,
    summary: buildSummary('filled', input, {
      fieldCount: filledFields.length,
    }),
  };
  await appendMemoryDelegatedFillEvent(input, 'memory_delegated_fill.complete', {
    status: result.status,
    fillRef: result.fillRef,
    candidateRef: result.candidateRef,
    artifactRef: result.artifactRef,
    filledFields: result.filledFields,
  });
  return result;
}

async function prepareMemoryDelegatedFillOperations(
  input: MemoryDelegatedFillExecutionInput,
  memoryValues: Readonly<Record<string, string | undefined>>
): Promise<PrepareMemoryDelegatedFillOperationsResult> {
  const targetByRef = new Map(input.targets.map((target) => [target.targetRef, target]));
  const projected = projectMemoryDelegatedFillOperations({
    fields: input.subject.fields,
    targets: input.targets,
    memoryValues,
  });
  if (projected.status === 'blocked') {
    return projected;
  }

  const preparedFields: PreparedProjectedField[] = [];
  const projectedOperations: Array<
    | {
        readonly kind: 'operation';
        readonly operation: PreparedMemoryDelegatedFillOperation;
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
      resolveMemoryDelegatedFieldPolicy(input.candidate, field.fieldKey) === 'llm_assisted' &&
      shouldAssistMemoryDelegatedField(field);
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

  const assistiveValues = await resolveAssistiveValues(input, memoryValues, preparedFields);
  if (assistiveValues.status === 'blocked') {
    return assistiveValues;
  }

  const operations = projectedOperations.map((item): PreparedMemoryDelegatedFillOperation => {
    if (item.kind === 'operation') {
      return item.operation;
    }

    const preparedField = item.field;
    const targetRef = preparedField.field.targetRef;
    const value =
      assistiveValues.values.get(targetRef) ??
      assistiveValues.values.get(`${preparedField.field.fieldKey}:${targetRef}`) ??
      preparedField.deterministicValue;
    const memoryValue = memoryValues[preparedField.field.fieldKey];
    const assistiveFallback =
      preparedField.selectAssistiveFallback &&
      typeof memoryValue === 'string' &&
      memoryValue.trim().length > 0
        ? {
            fieldKey: preparedField.field.fieldKey,
            targetRef,
            ...(preparedField.field.valueHint ? { valueHint: preparedField.field.valueHint } : {}),
            ...(preparedField.field.label ? { label: preparedField.field.label } : {}),
            memoryValue: memoryValue.trim(),
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

function validateMemoryDelegatedFillTargets(input: MemoryDelegatedFillExecutionInput):
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
  input: MemoryDelegatedFillExecutionInput,
  operation: PreparedMemoryDelegatedFillOperation
): Promise<
  | { readonly status: 'filled' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'blocked';
      readonly reason: MemoryDelegatedFillBlockedReason;
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
  input: MemoryDelegatedFillExecutionInput,
  memoryValues: Readonly<Record<string, string | undefined>>,
  preparedFields: readonly {
    readonly field: MagicBrowseMatchGroupField;
    readonly target: MagicBrowseMemoryDelegatedFillTargetDescriptor;
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
      readonly reason: MemoryDelegatedFillBlockedReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    }
> {
  const assistiveBindings: MagicBrowseMemoryDelegatedAssistiveBinding[] = [];
  for (const item of preparedFields) {
    if (!item.assistive) {
      continue;
    }
    const memoryValue = memoryValues[item.field.fieldKey];
    if (typeof memoryValue !== 'string' || memoryValue.trim().length === 0) {
      return {
        status: 'blocked',
        reason: 'missing_memory_value',
        targetRef: item.field.targetRef,
        fieldKey: item.field.fieldKey,
      };
    }
    assistiveBindings.push({
      fieldKey: item.field.fieldKey,
      targetRef: item.field.targetRef,
      ...(item.field.valueHint ? { valueHint: item.field.valueHint } : {}),
      ...(item.field.label ? { label: item.field.label } : {}),
      memoryValue: memoryValue.trim(),
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

function shouldAssistMemoryDelegatedField(field: MagicBrowseMatchGroupField): boolean {
  return !modelHiddenMemoryFieldKey(field.fieldKey);
}

function modelHiddenMemoryFieldKey(fieldKey: string): boolean {
  const normalized = fieldKey
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  return [
    'pan',
    'card_number',
    'payment_card_number',
    'cvv',
    'cvc',
    'csc',
    'password',
    'passcode',
    'otp',
    'authentication_code',
    'auth_code',
    'api_key',
    'private_key',
    'secret',
    'token',
  ].some(
    (protectedName) =>
      normalized === protectedName ||
      normalized.startsWith(`${protectedName}_`) ||
      normalized.endsWith(`_${protectedName}`)
  );
}

function uniqueFieldKeys(fields: readonly MagicBrowseMatchGroupField[]): readonly string[] {
  return [...new Set(fields.map((field) => field.fieldKey))];
}

function fieldRef(field: MagicBrowseMatchGroupField): MemoryDelegatedFilledFieldRef {
  return {
    fieldKey: field.fieldKey,
    targetRef: field.targetRef,
  };
}

async function block(
  input: MemoryDelegatedFillExecutionInput,
  reason: MemoryDelegatedFillBlockedReason,
  refs: {
    readonly targetRef?: string;
    readonly fieldKey?: string;
  } = {}
): Promise<MemoryDelegatedFillResult> {
  const result: MemoryDelegatedFillResult = {
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
  await appendMemoryDelegatedFillEvent(input, 'memory_delegated_fill.blocked', {
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
  status: MemoryDelegatedFillStatus,
  input: MemoryDelegatedFillExecutionInput,
  details: {
    readonly fieldCount?: number;
    readonly reason?: MemoryDelegatedFillBlockedReason;
  } = {}
): string {
  const pieces = [
    `memory_delegated_fill ${status}`,
    `fill=${input.subject.fillRef}`,
    `candidate=${input.candidate.candidateRef}`,
    typeof details.fieldCount === 'number' ? `fields=${details.fieldCount}` : undefined,
    details.reason ? `reason=${details.reason}` : undefined,
  ].filter((piece): piece is string => piece !== undefined);
  return pieces.join(' ');
}

async function appendMemoryDelegatedFillEvent(
  input: MemoryDelegatedFillExecutionInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  await input.runRecorder?.append({
    type,
    level: type === 'memory_delegated_fill.field_errors' ? 'warn' : 'info',
    data: omitUndefined({
      sessionId: input.runRecorder.sessionId,
      runId: input.runRecorder.runId,
      ...data,
    }),
  });
}

function resolveMemoryDelegatedFieldPolicy(
  candidate: MagicBrowseMatchGroupCandidate,
  fieldKey: string
): MagicBrowseMemoryFieldPolicy {
  return candidate.fieldPolicies?.[fieldKey] ?? 'deterministic_only';
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}

export const __testFillMemoryDelegated = {
  resolveMemoryDelegatedFieldPolicy,
};
