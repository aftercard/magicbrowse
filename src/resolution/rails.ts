import type {
  ResolveFieldCandidate,
  ResolveFieldDecision,
  ResolveFieldNoMatchReason,
  ResolveFieldTargetDescriptor,
} from './resolve-field.js';
import { isFieldShapeCompatible } from './field-shape.js';

const NO_MATCH_REASONS = new Set<ResolveFieldNoMatchReason>([
  'protected_target',
  'low_confidence',
  'incompatible_shape',
  'scope_ineligible',
  'unknown_candidate_ref',
  'invalid_model_output',
  'matcher_unavailable',
]);

export interface ResolveFieldCandidateScope {
  readonly eligibleCandidates: readonly ResolveFieldCandidate[];
  readonly ineligibleCandidates: readonly ResolveFieldCandidate[];
}

export interface ResolveFieldValidationContext {
  readonly target: ResolveFieldTargetDescriptor;
  readonly candidates: readonly ResolveFieldCandidate[];
  readonly eligibleCandidates: readonly ResolveFieldCandidate[];
}

export type ResolveFieldDecisionValidation =
  | {
      readonly ok: true;
      readonly decision: ResolveFieldDecision;
      readonly candidate?: ResolveFieldCandidate;
      readonly candidates?: readonly ResolveFieldCandidate[];
    }
  | {
      readonly ok: false;
      readonly reason: ResolveFieldNoMatchReason;
    };

export function scopeCandidates(
  candidates: readonly ResolveFieldCandidate[],
  host: string
): ResolveFieldCandidateScope {
  const normalizedHost = normalizeHost(host);
  const eligibleCandidates: ResolveFieldCandidate[] = [];
  const ineligibleCandidates: ResolveFieldCandidate[] = [];

  for (const candidate of candidates) {
    if (isScopeEligible(candidate, normalizedHost)) {
      eligibleCandidates.push(candidate);
    } else {
      ineligibleCandidates.push(candidate);
    }
  }

  return {
    eligibleCandidates,
    ineligibleCandidates,
  };
}

export function isProtectedTarget(
  target: ResolveFieldTargetDescriptor,
  protectedTargetRefs?: ReadonlySet<string>
): boolean {
  return protectedTargetRefs?.has(target.ref) === true;
}

export function validateResolveFieldDecision(
  output: unknown,
  context: ResolveFieldValidationContext
): ResolveFieldDecisionValidation {
  const record = asRecord(output);
  if (!record) {
    return invalidModelOutput();
  }

  if (record.targetRef !== context.target.ref) {
    return invalidModelOutput();
  }

  switch (record.status) {
    case 'matched':
    case 'needs_resolution':
      return validateCandidateDecision(record, context);
    case 'ambiguous':
      return validateAmbiguousDecision(record, context);
    case 'no_match':
      return validateNoMatchDecision(record);
    default:
      return invalidModelOutput();
  }
}

function validateCandidateDecision(
  record: Record<string, unknown>,
  context: ResolveFieldValidationContext
): ResolveFieldDecisionValidation {
  const status =
    record.status === 'matched' || record.status === 'needs_resolution'
      ? record.status
      : undefined;
  if (
    !status ||
    typeof record.candidateRef !== 'string' ||
    typeof record.fieldKey !== 'string' ||
    (record.confidence !== 'high' && record.confidence !== 'medium')
  ) {
    if (record.confidence === 'low') {
      return { ok: false, reason: 'low_confidence' };
    }

    return invalidModelOutput();
  }

  const candidateLookup = lookupCandidate(record.candidateRef, context);
  if (!candidateLookup.ok) {
    return candidateLookup;
  }

  if (!isShapeCompatible(context.target, candidateLookup.candidate)) {
    return { ok: false, reason: 'incompatible_shape' };
  }

  if (status === 'needs_resolution' && !candidateLookup.candidate.resolve) {
    return invalidModelOutput();
  }

  return {
    ok: true,
    decision: {
      status,
      targetRef: context.target.ref,
      candidateRef: record.candidateRef,
      fieldKey: record.fieldKey,
      confidence: record.confidence,
    },
    candidate: candidateLookup.candidate,
  };
}

function validateAmbiguousDecision(
  record: Record<string, unknown>,
  context: ResolveFieldValidationContext
): ResolveFieldDecisionValidation {
  if (
    !Array.isArray(record.candidates) ||
    record.candidates.length === 0 ||
    !record.candidates.every((candidateRef) => typeof candidateRef === 'string')
  ) {
    return invalidModelOutput();
  }

  const candidateRefs = record.candidates as readonly string[];
  const candidates: ResolveFieldCandidate[] = [];
  for (const candidateRef of candidateRefs) {
    const candidateLookup = lookupCandidate(candidateRef, context);
    if (!candidateLookup.ok) {
      return candidateLookup;
    }

    if (!isShapeCompatible(context.target, candidateLookup.candidate)) {
      return { ok: false, reason: 'incompatible_shape' };
    }

    candidates.push(candidateLookup.candidate);
  }

  return {
    ok: true,
    decision: {
      status: 'ambiguous',
      targetRef: context.target.ref,
      candidates: candidateRefs,
    },
    candidates,
  };
}

function validateNoMatchDecision(
  record: Record<string, unknown>
): ResolveFieldDecisionValidation {
  if (!isNoMatchReason(record.reason)) {
    return invalidModelOutput();
  }

  return {
    ok: true,
    decision: {
      status: 'no_match',
      targetRef: String(record.targetRef),
      reason: record.reason,
    },
  };
}

function isNoMatchReason(value: unknown): value is ResolveFieldNoMatchReason {
  return (
    typeof value === 'string' &&
    NO_MATCH_REASONS.has(value as ResolveFieldNoMatchReason)
  );
}

function lookupCandidate(
  candidateRef: string,
  context: ResolveFieldValidationContext
):
  | { readonly ok: true; readonly candidate: ResolveFieldCandidate }
  | { readonly ok: false; readonly reason: ResolveFieldNoMatchReason } {
  const eligibleCandidate = context.eligibleCandidates.find(
    (candidate) => candidate.candidateRef === candidateRef
  );
  if (eligibleCandidate) {
    return { ok: true, candidate: eligibleCandidate };
  }

  const knownCandidate = context.candidates.find(
    (candidate) => candidate.candidateRef === candidateRef
  );
  if (knownCandidate) {
    return { ok: false, reason: 'scope_ineligible' };
  }

  return { ok: false, reason: 'unknown_candidate_ref' };
}

function isScopeEligible(candidate: ResolveFieldCandidate, normalizedHost: string): boolean {
  if (candidate.applicability.target === 'global') {
    return true;
  }

  if (candidate.applicability.target === 'host') {
    return normalizeHost(candidate.applicability.value) === normalizedHost;
  }

  return false;
}

function isShapeCompatible(
  target: ResolveFieldTargetDescriptor,
  candidate: ResolveFieldCandidate
): boolean {
  return isFieldShapeCompatible(target, candidate);
}

function normalizeHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function invalidModelOutput(): ResolveFieldDecisionValidation {
  return {
    ok: false,
    reason: 'invalid_model_output',
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
