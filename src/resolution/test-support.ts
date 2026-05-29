import type { MagicBrowseSemanticMatcherRequest } from './semantic-match.js';

export type FakeFieldValue = string | number | boolean | null;

export type FakeFieldValueType = 'text' | 'email' | 'date' | 'secret';

export type FakeFieldSource = 'memory' | 'session_open_value' | 'resolver';

export type FakeApplicability =
  | { readonly target: 'global' }
  | { readonly target: 'host'; readonly value: string };

export interface FakeTargetDescriptor {
  readonly ref: string;
  readonly pageRef: string;
  readonly kind: 'input' | 'textarea' | 'select';
  readonly label: string;
  readonly displayLabel: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly allowedActions: readonly string[];
  readonly host?: string;
  readonly context: {
    readonly landmark?: {
      readonly kind: string;
      readonly label: string;
    };
  };
}

export interface FakeCandidate {
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly value?: FakeFieldValue;
  readonly source: FakeFieldSource;
  readonly type: FakeFieldValueType;
  readonly label?: string;
  readonly semanticTags?: readonly string[];
  readonly applicability: FakeApplicability;
  readonly resolve?: FakeResolvePlan['resolve'];
}

export interface FakeResolvePlan {
  readonly targetRef: string;
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly type: FakeFieldValueType;
  readonly resolve: {
    readonly kind: 'external_lookup';
    readonly key: string;
  };
}

export type FakeResolveFieldDecision =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
      readonly confidence: 'high' | 'medium';
    }
  | {
      readonly status: 'needs_resolution';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
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
      readonly reason: FakeNoMatchReason;
    };

export type FakeNoMatchReason =
  | 'protected_target'
  | 'low_confidence'
  | 'incompatible_shape'
  | 'scope_ineligible'
  | 'unknown_candidate_ref'
  | 'invalid_model_output';

export type FakeResolveFieldPublicResult =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly fieldKey: string;
      readonly candidateRef: string;
      readonly valueRef: string;
      readonly confidence: 'high' | 'medium';
    }
  | {
      readonly status: 'needs_resolution';
      readonly targetRef: string;
      readonly fieldKey: string;
      readonly candidateRef: string;
      readonly confidence: 'high' | 'medium';
      readonly plan: FakeResolvePlan;
    }
  | {
      readonly status: 'ambiguous';
      readonly targetRef: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'no_match';
      readonly targetRef: string;
      readonly reason: FakeNoMatchReason;
    };

export type FakePlannerRequest = MagicBrowseSemanticMatcherRequest & {
  readonly target: FakeTargetDescriptor;
  readonly targets: readonly FakeTargetDescriptor[];
  readonly candidates: readonly FakeCandidate[];
  readonly schemas: readonly unknown[];
};

export interface FakePlannerModel {
  readonly requests: readonly FakePlannerRequest[];
  decide(request: MagicBrowseSemanticMatcherRequest): Promise<unknown>;
}

export interface FakeCandidateStore {
  readonly readCalls: readonly string[];
  entries(): readonly FakeCandidate[];
  read(candidateRef: string): FakeFieldValue | undefined;
}

export interface FakeResolver {
  readonly resolveCalls: readonly FakeResolvePlan[];
  resolve(plan: FakeResolvePlan): Promise<{ readonly kind: 'value'; readonly value: FakeFieldValue }>;
}

export interface FakeFillRecorder {
  readonly fillCalls: readonly unknown[];
  readonly fallbackCalls: readonly unknown[];
  fill(input: unknown): Promise<void>;
  fallback(input: unknown): Promise<void>;
}

export interface FakeResolveFieldInput {
  readonly target: FakeTargetDescriptor;
  readonly candidates: readonly FakeCandidate[];
  readonly host: string;
  readonly model: FakePlannerModel;
  readonly protectedTargetRefs?: ReadonlySet<string>;
  readonly store?: FakeCandidateStore;
  readonly resolver?: FakeResolver;
  readonly fill?: FakeFillRecorder;
}

export function fakeTarget(
  ref: string,
  label: string,
  options: Partial<FakeTargetDescriptor> = {}
): FakeTargetDescriptor {
  return {
    ref,
    pageRef: 'p0',
    kind: 'input',
    label,
    displayLabel: label,
    allowedActions: ['fill'],
    context: {
      landmark: {
        kind: 'form',
        label: 'MagicBrowse resolve field test form',
      },
    },
    ...options,
  };
}

export function fakeCandidate(
  candidateRef: string,
  fieldKey: string,
  value: FakeFieldValue | undefined,
  options: Partial<FakeCandidate> = {}
): FakeCandidate {
  return {
    candidateRef,
    fieldKey,
    value,
    source: 'memory',
    type: 'text',
    applicability: {
      target: 'global',
    },
    ...options,
  };
}

export function createFakeCandidateStore(
  entries: readonly FakeCandidate[]
): FakeCandidateStore {
  const valuesByRef = new Map(entries.map((entry) => [entry.candidateRef, entry.value]));
  const readCalls: string[] = [];

  return {
    readCalls,
    entries() {
      return entries.map(({ value: _value, ...entry }) => ({ ...entry }));
    },
    read(candidateRef: string): FakeFieldValue | undefined {
      readCalls.push(candidateRef);
      return valuesByRef.get(candidateRef);
    },
  };
}

export function createFakeResolver(
  resourcesByCandidateRef: Readonly<Record<string, FakeFieldValue>>
): FakeResolver {
  const resolveCalls: FakeResolvePlan[] = [];

  return {
    resolveCalls,
    async resolve(plan: FakeResolvePlan) {
      resolveCalls.push(plan);
      const value = resourcesByCandidateRef[plan.candidateRef];
      if (value === undefined) {
        throw new Error(`Missing fake resolver value for ${plan.candidateRef}.`);
      }
      return {
        kind: 'value',
        value,
      };
    },
  };
}

export function createFakePlannerModel(
  decisions: readonly unknown[]
): FakePlannerModel {
  const requests: FakePlannerRequest[] = [];
  let nextDecisionIndex = 0;

  return {
    requests,
    async decide(request: MagicBrowseSemanticMatcherRequest): Promise<unknown> {
      requests.push(request as FakePlannerRequest);
      if (nextDecisionIndex >= decisions.length) {
        throw new Error('Fake planner model received more requests than decisions.');
      }
      const decision = decisions[nextDecisionIndex];
      nextDecisionIndex += 1;
      return decision;
    },
  };
}

export function createFakeFillRecorder(): FakeFillRecorder {
  const fillCalls: unknown[] = [];
  const fallbackCalls: unknown[] = [];

  return {
    fillCalls,
    fallbackCalls,
    async fill(input: unknown): Promise<void> {
      fillCalls.push(input);
    },
    async fallback(input: unknown): Promise<void> {
      fallbackCalls.push(input);
    },
  };
}

export function buildFakeResolveFieldPrompt(
  input: {
    readonly target: FakeTargetDescriptor;
    readonly candidates: readonly FakeCandidate[];
    readonly host: string;
  },
  options: {
    readonly includeRawValues?: boolean;
  } = {}
): string {
  const candidates = input.candidates.map((candidate) => ({
    candidateRef: candidate.candidateRef,
    fieldKey: candidate.fieldKey,
    source: candidate.source,
    type: candidate.type,
    label: candidate.label,
    semanticTags: candidate.semanticTags,
    applicability: candidate.applicability,
    ...(candidate.resolve ? { resolve: candidate.resolve } : {}),
    ...(options.includeRawValues ? { value: candidate.value } : {}),
  }));

  return JSON.stringify({
    task: 'resolveField',
    host: input.host,
    target: {
      ref: input.target.ref,
      kind: input.target.kind,
      label: input.target.label,
      inputType: input.target.inputType,
      autocomplete: input.target.autocomplete,
      context: input.target.context,
    },
    candidates,
  });
}

export function publicJsonContainsRawValue(
  value: unknown,
  rawValues: readonly FakeFieldValue[]
): boolean {
  const publicJson = JSON.stringify(value);
  return rawValues.some((rawValue) => publicJson.includes(String(rawValue)));
}

export function promptContainsRawValue(
  prompt: string,
  rawValues: readonly FakeFieldValue[]
): boolean {
  return rawValues.some((rawValue) => prompt.includes(String(rawValue)));
}
