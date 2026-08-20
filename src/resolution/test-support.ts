import type { MagicBrowseSemanticMatcherRequest } from './semantic-match.js';

export type FakeFieldValue = string | number | boolean | null;

export type FakeFieldValueType = 'text' | 'email' | 'date' | 'secret';

export type FakeFieldSource = 'memory' | 'session_memory_value' | 'resolver';

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
  readonly resolve?: FakeExternalResolvePlan;
}

export interface FakeExternalResolvePlan {
  readonly kind: 'external_lookup';
  readonly key: string;
}

export type FakeNoMatchReason =
  | 'memory_managed_target'
  | 'low_confidence'
  | 'incompatible_shape'
  | 'scope_ineligible'
  | 'unknown_candidate_ref'
  | 'invalid_model_output';

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

export interface FakeFillRecorder {
  readonly fillCalls: readonly unknown[];
  readonly fallbackCalls: readonly unknown[];
  fill(input: unknown): Promise<void>;
  fallback(input: unknown): Promise<void>;
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
        label: 'MagicBrowse memory field test form',
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

export function createFakeCandidateStore(entries: readonly FakeCandidate[]): FakeCandidateStore {
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

export function createFakePlannerModel(decisions: readonly unknown[]): FakePlannerModel {
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
