import {
  isProtectedTarget,
  scopeCandidates,
} from './rails.js';
import {
  matchSemanticTargets,
  openDataSemanticSchema,
  type MagicBrowseSemanticMatcherModel,
  type MagicBrowseSemanticMatcherRequest,
  type MagicBrowseOpenDataValueHint,
} from './semantic-match.js';

export type ResolveFieldValue = string | number | boolean | null;
export type ResolveFieldValueType = 'text' | 'email' | 'date' | 'secret';
export type ResolveFieldSource = 'profile_facts' | 'session_open_value' | 'resolver';

export type ResolveFieldApplicability =
  | { readonly target: 'global' }
  | { readonly target: 'host'; readonly value: string };

export interface ResolveFieldTargetDescriptor {
  readonly ref: string;
  readonly index?: number;
  readonly selectorMapIndex?: number;
  readonly pageRef?: string;
  readonly kind?: string;
  readonly tagName?: string;
  readonly role?: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly text?: string;
  readonly placeholder?: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly selectorRoot?: string;
  readonly isReadonly?: boolean;
  readonly popupBacked?: boolean;
  readonly allowedActions?: readonly string[];
  readonly host?: string;
  readonly context?: unknown;
}

export interface ResolveFieldResolvePlan {
  readonly targetRef: string;
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly valueHint?: MagicBrowseOpenDataValueHint;
  readonly type: ResolveFieldValueType;
  readonly resolve: {
    readonly kind: 'external_lookup';
    readonly key: string;
  };
}

export interface ResolveFieldCandidate {
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly value?: ResolveFieldValue;
  readonly source: ResolveFieldSource;
  readonly type: ResolveFieldValueType;
  readonly label?: string;
  readonly semanticTags?: readonly string[];
  readonly applicability: ResolveFieldApplicability;
  readonly resolve?: ResolveFieldResolvePlan['resolve'];
}

export type ResolveFieldNoMatchReason =
  | 'protected_target'
  | 'low_confidence'
  | 'incompatible_shape'
  | 'scope_ineligible'
  | 'unknown_candidate_ref'
  | 'invalid_model_output'
  | 'matcher_unavailable';

export type ResolveFieldDecision =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
      readonly valueHint?: MagicBrowseOpenDataValueHint;
      readonly confidence: 'high' | 'medium';
    }
  | {
      readonly status: 'needs_resolution';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
      readonly valueHint?: MagicBrowseOpenDataValueHint;
      readonly confidence: 'high' | 'medium';
    }
  | {
      readonly status: 'ambiguous';
      readonly targetRef: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'no_match';
      readonly targetRef: string;
      readonly reason: ResolveFieldNoMatchReason;
    };

export type ResolveFieldResult =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly fieldKey: string;
      readonly candidateRef: string;
      readonly valueRef: string;
      readonly valueHint?: MagicBrowseOpenDataValueHint;
      readonly confidence: 'high' | 'medium';
    }
  | {
      readonly status: 'needs_resolution';
      readonly targetRef: string;
      readonly fieldKey: string;
      readonly candidateRef: string;
      readonly valueHint?: MagicBrowseOpenDataValueHint;
      readonly confidence: 'high' | 'medium';
      readonly plan: ResolveFieldResolvePlan;
    }
  | {
      readonly status: 'ambiguous';
      readonly targetRef: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'no_match';
      readonly targetRef: string;
      readonly reason: ResolveFieldNoMatchReason;
    };

export type ResolveFieldPlannerRequest = MagicBrowseSemanticMatcherRequest;

export type ResolveFieldPlannerModel = MagicBrowseSemanticMatcherModel;

export interface ResolveFieldInput {
  readonly target: ResolveFieldTargetDescriptor;
  readonly candidates: readonly ResolveFieldCandidate[];
  readonly host: string;
  readonly model: ResolveFieldPlannerModel;
  readonly protectedTargetRefs?: ReadonlySet<string>;
  readonly store?: unknown;
  readonly resolver?: unknown;
  readonly fill?: unknown;
}

export async function resolveField(input: ResolveFieldInput): Promise<ResolveFieldResult> {
  if (isProtectedTarget(input.target, input.protectedTargetRefs)) {
    return noMatch(input.target.ref, 'protected_target');
  }

  const candidates = hydrateCandidateValues(input.candidates, input.store);
  const candidateScope = scopeCandidates(candidates, input.host);
  if (candidateScope.eligibleCandidates.length === 0) {
    return noMatch(
      input.target.ref,
      candidateScope.ineligibleCandidates.length > 0 ? 'scope_ineligible' : 'low_confidence'
    );
  }

  const result = await matchSemanticTargets({
    targets: [input.target],
    candidates: candidateScope.eligibleCandidates,
    schemas: [openDataSemanticSchema(candidateScope.eligibleCandidates)],
    host: input.host,
    model: input.model,
    protectedTargetRefs: input.protectedTargetRefs,
  });

  const decision = result.fieldResults[0];
  if (!decision) {
    return noMatch(input.target.ref, 'invalid_model_output');
  }

  switch (decision.status) {
    case 'matched':
      return {
        status: 'matched',
        targetRef: input.target.ref,
        fieldKey: decision.fieldKey,
        candidateRef: decision.candidateRef,
        valueRef: decision.valueRef,
        ...(decision.valueHint ? { valueHint: decision.valueHint } : {}),
        confidence: decision.confidence,
      };
    case 'needs_resolution': {
      return {
        status: 'needs_resolution',
        targetRef: input.target.ref,
        fieldKey: decision.fieldKey,
        candidateRef: decision.candidateRef,
        ...(decision.valueHint ? { valueHint: decision.valueHint } : {}),
        confidence: decision.confidence,
        plan: {
          targetRef: decision.plan.targetRef,
          candidateRef: decision.plan.candidateRef,
          fieldKey: decision.plan.fieldKey,
          ...(decision.plan.valueHint ? { valueHint: decision.plan.valueHint } : {}),
          type: decision.plan.type,
          resolve: decision.plan.resolve,
        },
      };
    }
    case 'ambiguous':
      return {
        status: 'ambiguous',
        targetRef: input.target.ref,
        candidates: decision.candidates,
      };
    case 'no_match':
      return noMatch(input.target.ref, decision.reason);
  }
}

function noMatch(targetRef: string, reason: ResolveFieldNoMatchReason): ResolveFieldResult {
  return {
    status: 'no_match',
    targetRef,
    reason,
  };
}

function hydrateCandidateValues(
  candidates: readonly ResolveFieldCandidate[],
  store: unknown
): readonly ResolveFieldCandidate[] {
  if (!store || typeof store !== 'object' || typeof (store as { read?: unknown }).read !== 'function') {
    return candidates;
  }

  const reader = store as { read(candidateRef: string): ResolveFieldValue | undefined };
  return candidates.map((candidate) => {
    if (candidate.value !== undefined) {
      return candidate;
    }
    const value = reader.read(candidate.candidateRef);
    return value === undefined ? candidate : { ...candidate, value };
  });
}
