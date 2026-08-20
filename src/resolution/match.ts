export type MagicBrowseMatchApplicability =
  | { readonly target: 'global' }
  | { readonly target: 'host'; readonly value: string };

export interface MagicBrowseMatchExternalResolvePlan {
  readonly kind: 'external_lookup';
  readonly key: string;
}

export type MagicBrowseMemoryBindingValueHint =
  | 'direct'
  | 'full_name.given'
  | 'full_name.family'
  | 'date_of_birth.day'
  | 'date_of_birth.month'
  | 'date_of_birth.year';

export type MagicBrowseMemoryFieldPolicy = 'deterministic_only' | 'llm_assisted';
export type MagicBrowseMemoryFieldPolicies = Readonly<
  Partial<Record<string, MagicBrowseMemoryFieldPolicy>>
>;

export interface MagicBrowseMatchGroupField {
  readonly fieldKey: string;
  readonly targetRef: string;
  readonly label?: string;
  readonly required?: boolean;
  readonly valueHint?: MagicBrowseMemoryBindingValueHint;
}

export interface MagicBrowseMatchGroupRejectedField {
  readonly targetRef?: string;
  readonly fieldKey?: string;
  readonly label?: string;
  readonly valueHint?: string;
  readonly reason: string;
}

export interface MagicBrowseMatchGroupSubject {
  readonly fillRef: string;
  readonly pageRef: string;
  readonly scopeRef?: string;
  readonly purpose: string;
  readonly fields: readonly MagicBrowseMatchGroupField[];
  readonly rejectedFields?: readonly MagicBrowseMatchGroupRejectedField[];
}

export interface MagicBrowseMatchGroupCandidate {
  readonly candidateRef: string;
  readonly sourceRef?: string;
  readonly fieldKeys: readonly string[];
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly applicability?: MagicBrowseMatchApplicability;
  readonly artifactRef?: string;
  readonly resolve?: MagicBrowseMatchExternalResolvePlan;
  readonly fieldPolicies?: MagicBrowseMemoryFieldPolicies;
}

export interface MagicBrowseMatchGroupInput {
  readonly from: readonly MagicBrowseMatchGroupCandidate[];
  readonly host?: string;
}

export type MagicBrowseMatchInput = MagicBrowseMatchGroupInput;
export type MagicBrowseMatchSubject = MagicBrowseMatchGroupSubject;

export interface MagicBrowseMatchGroupResolutionPlan {
  readonly fillRef: string;
  readonly pageRef: string;
  readonly scopeRef?: string;
  readonly purpose: string;
  readonly candidateRef: string;
  readonly sourceRef?: string;
  readonly fieldKeys: readonly string[];
  readonly fields?: readonly MagicBrowseMatchGroupField[];
  readonly fieldPolicies?: MagicBrowseMemoryFieldPolicies;
  readonly resolve: MagicBrowseMatchExternalResolvePlan;
}

export interface MagicBrowseMatchReadyGroupResult {
  readonly kind: 'ready_group';
  readonly fillRef: string;
  readonly purpose: string;
  readonly candidateRef: string;
  readonly sourceRef?: string;
  readonly fieldKeys: readonly string[];
  readonly artifactRef: string;
  readonly confidence: 'high' | 'medium';
  readonly fields?: readonly MagicBrowseMatchGroupField[];
  readonly fieldPolicies?: MagicBrowseMemoryFieldPolicies;
}

export interface MagicBrowseMatchNeedsResolutionGroupResult {
  readonly kind: 'needs_resolution_group';
  readonly fillRef: string;
  readonly purpose: string;
  readonly candidateRef: string;
  readonly sourceRef?: string;
  readonly fieldKeys: readonly string[];
  readonly confidence: 'high' | 'medium';
  readonly fields?: readonly MagicBrowseMatchGroupField[];
  readonly fieldPolicies?: MagicBrowseMemoryFieldPolicies;
  readonly plan: MagicBrowseMatchGroupResolutionPlan;
}

export interface MagicBrowseMatchAmbiguousGroupResult {
  readonly kind: 'ambiguous_group';
  readonly fillRef: string;
  readonly candidates: readonly string[];
}

export type MagicBrowseMatchNoMatchGroupReason =
  | 'no_candidate'
  | 'scope_ineligible'
  | 'incompatible_shape'
  | 'low_confidence';

export interface MagicBrowseMatchNoMatchGroupResult {
  readonly kind: 'no_match_group';
  readonly fillRef: string;
  readonly reason: MagicBrowseMatchNoMatchGroupReason;
}

export type MagicBrowseMatchGroupResult =
  | MagicBrowseMatchReadyGroupResult
  | MagicBrowseMatchNeedsResolutionGroupResult
  | MagicBrowseMatchAmbiguousGroupResult
  | MagicBrowseMatchNoMatchGroupResult;

export type MagicBrowseMatchResult = MagicBrowseMatchGroupResult;

type RankedGroupCandidate = MagicBrowseMatchGroupCandidate & {
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly label?: string;
  readonly overlapCount: number;
};

export async function match(
  subject: MagicBrowseMatchGroupSubject,
  input: MagicBrowseMatchGroupInput
): Promise<MagicBrowseMatchGroupResult>;
export function match(
  subject: MagicBrowseMatchSubject,
  input: MagicBrowseMatchInput
): Promise<MagicBrowseMatchResult> {
  return Promise.resolve(matchGroup(subject, input));
}

function matchGroup(subject: unknown, input: MagicBrowseMatchInput): MagicBrowseMatchGroupResult {
  const fillRef = groupFillRef(subject);
  if (!isMagicBrowseMatchGroupSubject(subject)) {
    return noGroupMatch(fillRef, 'incompatible_shape');
  }

  const source = Array.isArray(input.from) ? input.from : [];
  if (source.length === 0) {
    return noGroupMatch(subject.fillRef, 'no_candidate');
  }

  const candidates = source.filter(isMagicBrowseMatchGroupCandidate);
  if (candidates.length === 0) {
    return noGroupMatch(subject.fillRef, 'incompatible_shape');
  }

  const scopeEligible = candidates.filter((candidate) =>
    applicabilityMatches(candidate.applicability, input.host)
  );
  if (scopeEligible.length === 0) {
    return noGroupMatch(subject.fillRef, 'scope_ineligible');
  }

  const fieldKeys = subject.fields.map((field) => field.fieldKey);
  const fieldKeySet = new Set(fieldKeys);
  if (fieldKeySet.size === 0) {
    return noGroupMatch(subject.fillRef, 'incompatible_shape');
  }

  const ranked = scopeEligible
    .map((candidate) => {
      const matchedFieldKeys = matchGroupFieldKeys(subject.fields, candidate);
      return {
        ...candidate,
        fieldKeys: matchedFieldKeys,
        overlapCount: matchedFieldKeys.length,
      };
    })
    .filter((candidate) => candidate.overlapCount > 0)
    .sort(compareGroupCandidates);

  if (ranked.length === 0) {
    return noGroupMatch(subject.fillRef, 'incompatible_shape');
  }

  const matchable = ranked.filter((candidate) => candidate.confidence !== 'low');
  if (matchable.length === 0) {
    return noGroupMatch(subject.fillRef, 'low_confidence');
  }

  const selected = matchable[0];
  if (!selected) {
    return noGroupMatch(subject.fillRef, 'no_candidate');
  }

  const ambiguousCandidates = matchable.filter(
    (candidate) =>
      candidate.overlapCount === selected.overlapCount &&
      confidenceRank(candidate.confidence) === confidenceRank(selected.confidence)
  );
  if (ambiguousCandidates.length > 1) {
    return {
      kind: 'ambiguous_group',
      fillRef: subject.fillRef,
      candidates: ambiguousCandidates.map((candidate) => candidate.candidateRef),
    };
  }

  const confidence = resultConfidence(selected, fieldKeySet.size);
  const metadata = groupResultMetadata(subject, selected);
  if (selected.artifactRef) {
    return {
      kind: 'ready_group',
      fillRef: subject.fillRef,
      purpose: subject.purpose,
      candidateRef: selected.candidateRef,
      ...(selected.sourceRef ? { sourceRef: selected.sourceRef } : {}),
      fieldKeys: selected.fieldKeys,
      artifactRef: selected.artifactRef,
      confidence,
      ...metadata,
    };
  }

  if (selected.resolve) {
    return {
      kind: 'needs_resolution_group',
      fillRef: subject.fillRef,
      purpose: subject.purpose,
      candidateRef: selected.candidateRef,
      ...(selected.sourceRef ? { sourceRef: selected.sourceRef } : {}),
      fieldKeys: selected.fieldKeys,
      confidence,
      ...metadata,
      plan: {
        fillRef: subject.fillRef,
        pageRef: subject.pageRef,
        ...(subject.scopeRef ? { scopeRef: subject.scopeRef } : {}),
        purpose: subject.purpose,
        candidateRef: selected.candidateRef,
        ...(selected.sourceRef ? { sourceRef: selected.sourceRef } : {}),
        fieldKeys: selected.fieldKeys,
        ...metadata,
        resolve: selected.resolve,
      },
    };
  }

  return noGroupMatch(subject.fillRef, 'no_candidate');
}

function isGroupLikeSubject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'fillRef' in value;
}

function isMagicBrowseMatchGroupSubject(value: unknown): value is MagicBrowseMatchGroupSubject {
  if (!isGroupLikeSubject(value)) {
    return false;
  }

  const record = value as Partial<MagicBrowseMatchGroupSubject>;
  return (
    typeof record.fillRef === 'string' &&
    typeof record.pageRef === 'string' &&
    typeof record.purpose === 'string' &&
    (record.scopeRef === undefined || typeof record.scopeRef === 'string') &&
    Array.isArray(record.fields) &&
    record.fields.every(isMagicBrowseMatchGroupField)
  );
}

function isMagicBrowseMatchGroupField(value: unknown): value is MagicBrowseMatchGroupField {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MagicBrowseMatchGroupField>;
  return (
    typeof record.fieldKey === 'string' &&
    typeof record.targetRef === 'string' &&
    (record.label === undefined || typeof record.label === 'string') &&
    (record.required === undefined || typeof record.required === 'boolean') &&
    (record.valueHint === undefined || isMemoryBindingValueHint(record.valueHint))
  );
}

function isMagicBrowseMatchGroupCandidate(value: unknown): value is MagicBrowseMatchGroupCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MagicBrowseMatchGroupCandidate> & {
    readonly confidence?: unknown;
  };
  return (
    typeof record.candidateRef === 'string' &&
    (record.sourceRef === undefined || typeof record.sourceRef === 'string') &&
    Array.isArray(record.fieldKeys) &&
    record.fieldKeys.every((fieldKey) => typeof fieldKey === 'string') &&
    record.fieldKeys.length > 0 &&
    isGroupConfidence(record.confidence) &&
    (record.applicability === undefined || isMagicBrowseMatchApplicability(record.applicability)) &&
    (record.artifactRef === undefined || typeof record.artifactRef === 'string') &&
    (record.resolve === undefined || isMagicBrowseExternalResolvePlan(record.resolve)) &&
    (record.fieldPolicies === undefined || isMemoryFieldPolicies(record.fieldPolicies))
  );
}

function isMemoryBindingValueHint(value: unknown): value is MagicBrowseMemoryBindingValueHint {
  return (
    value === 'direct' ||
    value === 'full_name.given' ||
    value === 'full_name.family' ||
    value === 'date_of_birth.day' ||
    value === 'date_of_birth.month' ||
    value === 'date_of_birth.year'
  );
}

function isMemoryFieldPolicies(value: unknown): value is MagicBrowseMemoryFieldPolicies {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (policy) => policy === 'deterministic_only' || policy === 'llm_assisted'
  );
}

function isGroupConfidence(value: unknown): boolean {
  return value === undefined || value === 'high' || value === 'medium' || value === 'low';
}

function isMagicBrowseMatchApplicability(value: unknown): value is MagicBrowseMatchApplicability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MagicBrowseMatchApplicability>;
  if (record.target === 'global') {
    return true;
  }

  return record.target === 'host' && typeof record.value === 'string';
}

function isMagicBrowseExternalResolvePlan(
  value: unknown
): value is MagicBrowseMatchExternalResolvePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<MagicBrowseMatchExternalResolvePlan>;
  return record.kind === 'external_lookup' && typeof record.key === 'string';
}

function applicabilityMatches(
  applicability: MagicBrowseMatchApplicability | undefined,
  host: string | undefined
): boolean {
  if (!applicability || applicability.target === 'global') {
    return true;
  }

  if (!host) {
    return false;
  }

  return normalizeHost(applicability.value) === normalizeHost(host);
}

function confidenceRank(confidence: 'high' | 'medium' | 'low' | undefined): number {
  if (confidence === 'high') {
    return 2;
  }
  if (confidence === 'medium') {
    return 1;
  }
  if (confidence === 'low') {
    return -1;
  }
  return 0;
}

function compareGroupCandidates(left: RankedGroupCandidate, right: RankedGroupCandidate): number {
  const overlapDelta = right.overlapCount - left.overlapCount;
  if (overlapDelta !== 0) {
    return overlapDelta;
  }

  const confidenceDelta = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const labelDelta = (left.label ?? '').localeCompare(right.label ?? '');
  if (labelDelta !== 0) {
    return labelDelta;
  }

  return left.candidateRef.localeCompare(right.candidateRef);
}

function matchGroupFieldKeys(
  fields: readonly MagicBrowseMatchGroupField[],
  candidate: MagicBrowseMatchGroupCandidate
): readonly string[] {
  const candidateFieldKeys = new Set(candidate.fieldKeys);
  const matched: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!candidateFieldKeys.has(field.fieldKey) || seen.has(field.fieldKey)) {
      continue;
    }
    seen.add(field.fieldKey);
    matched.push(field.fieldKey);
  }

  return matched;
}

function groupResultMetadata(
  subject: MagicBrowseMatchGroupSubject,
  candidate: MagicBrowseMatchGroupCandidate
): {
  readonly fields?: readonly MagicBrowseMatchGroupField[];
  readonly fieldPolicies?: MagicBrowseMemoryFieldPolicies;
} {
  const hasValueHints = subject.fields.some((field) => field.valueHint !== undefined);
  return {
    ...(hasValueHints ? { fields: subject.fields } : {}),
    ...(candidate.fieldPolicies ? { fieldPolicies: candidate.fieldPolicies } : {}),
  };
}

function resultConfidence(
  candidate: RankedGroupCandidate,
  subjectFieldCount: number
): 'high' | 'medium' {
  if (candidate.confidence === 'high' || candidate.confidence === 'medium') {
    return candidate.confidence;
  }

  return candidate.overlapCount === subjectFieldCount ? 'high' : 'medium';
}

function normalizeHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function groupFillRef(subject: unknown): string {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) {
    return 'unknown';
  }

  const fillRef = (subject as { readonly fillRef?: unknown }).fillRef;
  return typeof fillRef === 'string' ? fillRef : 'unknown';
}

function noGroupMatch(
  fillRef: string,
  reason: MagicBrowseMatchNoMatchGroupReason
): MagicBrowseMatchNoMatchGroupResult {
  return {
    kind: 'no_match_group',
    fillRef,
    reason,
  };
}
