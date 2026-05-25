import type { MagicBrowseFillableTargetDescriptor } from '../types.js';
import { resolveField } from './resolve-field.js';
import type {
  ResolveFieldApplicability,
  ResolveFieldCandidate,
  ResolveFieldPlannerModel,
  ResolveFieldResolvePlan,
  ResolveFieldResult,
  ResolveFieldSource,
  ResolveFieldTargetDescriptor,
  ResolveFieldValue,
  ResolveFieldValueType,
} from './resolve-field.js';

export type OpenDataTargetDescriptor =
  | MagicBrowseFillableTargetDescriptor
  | ResolveFieldTargetDescriptor;

export type OpenDataCandidateValue = ResolveFieldValue;
export type OpenDataCandidateValueType = ResolveFieldValueType;
export type OpenDataCandidateSource = ResolveFieldSource;
export type OpenDataCandidateApplicability = ResolveFieldApplicability;
export type OpenDataCandidateResolvePlan = ResolveFieldResolvePlan['resolve'];
export type OpenDataTargetMatcherModel = ResolveFieldPlannerModel;

export interface OpenDataCandidateDescriptor {
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly value?: OpenDataCandidateValue;
  readonly source: OpenDataCandidateSource;
  readonly type: OpenDataCandidateValueType;
  readonly label?: string;
  readonly semanticTags?: readonly string[];
  readonly applicability: OpenDataCandidateApplicability;
  readonly resolve?: OpenDataCandidateResolvePlan;
}

export type MatchOpenDataTargetResult = ResolveFieldResult;
export type MatchOpenDataTargetsResult = readonly MatchOpenDataTargetResult[];

export interface MatchOpenDataTargetsInput {
  readonly targets: readonly OpenDataTargetDescriptor[];
  readonly candidates: readonly OpenDataCandidateDescriptor[];
  readonly host: string;
  readonly model: OpenDataTargetMatcherModel;
  readonly protectedTargetRefs?: ReadonlySet<string>;
}

export async function matchOpenDataTargets(
  input: MatchOpenDataTargetsInput
): Promise<MatchOpenDataTargetsResult> {
  const candidates = input.candidates.map(toResolveFieldCandidate);
  const results: ResolveFieldResult[] = [];

  for (const target of input.targets) {
    results.push(
      await resolveField({
        target,
        candidates,
        host: input.host,
        model: input.model,
        protectedTargetRefs: input.protectedTargetRefs,
      })
    );
  }

  return results;
}

function toResolveFieldCandidate(
  candidate: OpenDataCandidateDescriptor
): ResolveFieldCandidate {
  return {
    candidateRef: candidate.candidateRef,
    fieldKey: candidate.fieldKey,
    value: candidate.value,
    source: candidate.source,
    type: candidate.type,
    label: candidate.label,
    semanticTags: candidate.semanticTags,
    applicability: candidate.applicability,
    resolve: candidate.resolve,
  };
}
