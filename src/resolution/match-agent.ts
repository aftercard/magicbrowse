import type {
  ResolveFieldCandidate,
  ResolveFieldPlannerModel,
  ResolveFieldPlannerRequest,
  ResolveFieldTargetDescriptor,
} from './resolve-field.js';
import { openDataSemanticSchema } from './semantic-match.js';

export interface ResolveFieldMatcherInput {
  readonly target: ResolveFieldTargetDescriptor;
  readonly candidates: readonly ResolveFieldCandidate[];
  readonly host: string;
  readonly model: ResolveFieldPlannerModel;
}

export async function requestResolveFieldDecision(
  input: ResolveFieldMatcherInput
): Promise<unknown> {
  const target = sanitizeTarget(input.target);
  const candidates = input.candidates.map((candidate) => sanitizeCandidate(candidate));
  const request: ResolveFieldPlannerRequest = {
    task: 'semanticTargetMatching',
    matcherModel: 'fast',
    target,
    targets: [target],
    candidates,
    schemas: [openDataSemanticSchema(candidates)],
    host: input.host,
    prompt: buildResolveFieldPrompt(input),
  };

  return input.model.decide(request);
}

export function buildResolveFieldPrompt(
  input: Omit<ResolveFieldMatcherInput, 'model'>,
  options: { readonly includeRawValues?: boolean } = {}
): string {
  return JSON.stringify({
    task: 'resolveField',
    host: input.host,
    target: sanitizeTarget(input.target),
    candidates: input.candidates.map((candidate) =>
      sanitizeCandidate(candidate, { includeRawValue: options.includeRawValues === true })
    ),
  });
}

function sanitizeTarget(target: ResolveFieldTargetDescriptor): ResolveFieldTargetDescriptor {
  return {
    ref: target.ref,
    pageRef: target.pageRef,
    kind: target.kind,
    label: target.label,
    displayLabel: target.displayLabel,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    allowedActions: target.allowedActions,
    host: target.host,
    context: target.context,
  };
}

function sanitizeCandidate(
  candidate: ResolveFieldCandidate,
  options: { readonly includeRawValue?: boolean } = {}
): ResolveFieldCandidate {
  return {
    candidateRef: candidate.candidateRef,
    fieldKey: candidate.fieldKey,
    source: candidate.source,
    type: candidate.type,
    label: candidate.label,
    semanticTags: candidate.semanticTags,
    applicability: candidate.applicability,
    resolve: candidate.resolve,
    ...(options.includeRawValue === true ? { value: candidate.value } : {}),
  };
}
