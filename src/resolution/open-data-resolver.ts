import type {
  OpenDataCandidateValue,
  OpenDataCandidateValueType,
  OpenDataCandidateResolvePlan,
} from './open-data-match.js';

export interface OpenDataFieldResolutionPlan {
  readonly targetRef: string;
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly type: OpenDataCandidateValueType;
  readonly resolve: OpenDataCandidateResolvePlan;
}

export type OpenDataFieldResolverOutcome =
  | {
      readonly status: 'resolved';
      readonly value?: unknown;
    }
  | {
      readonly status: 'denied';
      readonly reason?: string;
    }
  | {
      readonly status: 'failed';
      readonly reason?: string;
    };

export interface OpenDataFieldResolver {
  resolve(plan: OpenDataFieldResolutionPlan): Promise<OpenDataFieldResolverOutcome>;
  resolveBatch?(
    plans: readonly OpenDataFieldResolutionPlan[]
  ): Promise<readonly OpenDataFieldResolverOutcome[]>;
}

export type OpenDataResolverBlockedReason =
  | 'resolver_denied'
  | 'resolver_failed'
  | 'resolver_error'
  | 'resolver_wrong_type'
  | 'resolver_unexpected_batch_length';

export type OpenDataResolvedFieldValue = Exclude<OpenDataCandidateValue, null>;

export type OpenDataFieldResolutionResult =
  | {
      readonly status: 'resolved';
      readonly plan: OpenDataFieldResolutionPlan;
      readonly value: OpenDataResolvedFieldValue;
    }
  | {
      readonly status: 'blocked';
      readonly plan: OpenDataFieldResolutionPlan;
      readonly reason: OpenDataResolverBlockedReason;
    };

export async function resolveOpenDataField(
  plan: OpenDataFieldResolutionPlan,
  resolver: OpenDataFieldResolver
): Promise<OpenDataFieldResolutionResult> {
  try {
    return normalizeResolverOutcome(plan, await resolver.resolve(plan));
  } catch {
    return block(plan, 'resolver_error');
  }
}

export async function resolveOpenDataFieldBatch(
  plans: readonly OpenDataFieldResolutionPlan[],
  resolver: OpenDataFieldResolver
): Promise<readonly OpenDataFieldResolutionResult[]> {
  if (plans.length === 0) {
    return [];
  }

  if (!resolver.resolveBatch) {
    const results: OpenDataFieldResolutionResult[] = [];
    for (const plan of plans) {
      results.push(await resolveOpenDataField(plan, resolver));
    }
    return results;
  }

  let outcomes: unknown;
  try {
    outcomes = await resolver.resolveBatch(plans);
  } catch {
    return plans.map((plan) => block(plan, 'resolver_error'));
  }

  if (!Array.isArray(outcomes) || outcomes.length !== plans.length) {
    return plans.map((plan) => block(plan, 'resolver_unexpected_batch_length'));
  }

  return plans.map((plan, index) => normalizeResolverOutcome(plan, outcomes[index]));
}

function normalizeResolverOutcome(
  plan: OpenDataFieldResolutionPlan,
  outcome: OpenDataFieldResolverOutcome | undefined
): OpenDataFieldResolutionResult {
  if (!outcome) {
    return block(plan, 'resolver_failed');
  }

  switch (outcome.status) {
    case 'resolved':
      return isResolvedFieldValue(outcome.value)
        ? {
            status: 'resolved',
            plan,
            value: outcome.value,
          }
        : block(plan, 'resolver_wrong_type');
    case 'denied':
      return block(plan, 'resolver_denied');
    case 'failed':
      return block(plan, 'resolver_failed');
  }

  return block(plan, 'resolver_failed');
}

function isResolvedFieldValue(value: unknown): value is OpenDataResolvedFieldValue {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return typeof value === 'string' || typeof value === 'boolean';
}

function block(
  plan: OpenDataFieldResolutionPlan,
  reason: OpenDataResolverBlockedReason
): OpenDataFieldResolutionResult {
  return {
    status: 'blocked',
    plan,
    reason,
  };
}
