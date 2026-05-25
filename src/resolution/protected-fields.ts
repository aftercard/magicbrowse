import type { MagicBrowseFillableTargetDescriptor } from '../types.js';
import type {
  MagicBrowseMatchGroupField,
  MagicBrowseMatchGroupRejectedField,
  MagicBrowseMatchGroupSubject,
} from './match.js';
import {
  matchSemanticTargets,
  protectedSemanticSchemas,
  type MagicBrowseSemanticMatcherModel,
  type MagicBrowseSemanticRejectedGroup,
} from './semantic-match.js';

export const PROTECTED_FIELD_KEYS = [
  'username',
  'password',
  'full_name',
  'document_number',
  'date_of_birth',
  'nationality',
  'issue_date',
  'expiry_date',
  'issuing_country',
  'cardholder',
  'pan',
  'exp_month',
  'exp_year',
  'cvv',
] as const;

export type MagicBrowseProtectedFieldKey = (typeof PROTECTED_FIELD_KEYS)[number];

const IDENTITY_ANCHOR_FIELD_KEYS = new Set(['full_name', 'document_number', 'date_of_birth']);

export interface MatchProtectedFillSubjectsInput {
  readonly targets: readonly MagicBrowseFillableTargetDescriptor[];
  readonly model: MagicBrowseSemanticMatcherModel;
  readonly host?: string;
  readonly page?: {
    readonly url?: string;
    readonly title?: string;
    readonly host?: string;
  };
}

export type MatchProtectedFillSubjectsRejectedGroupReason =
  | MagicBrowseSemanticRejectedGroup['reason']
  | 'insufficient_identity_fields';

export interface MatchProtectedFillSubjectsRejectedGroup {
  readonly purpose?: string;
  readonly pageRef?: string;
  readonly acceptedFields: readonly MagicBrowseMatchGroupField[];
  readonly rejectedFields: readonly MagicBrowseMatchGroupRejectedField[];
  readonly reason: MatchProtectedFillSubjectsRejectedGroupReason;
}

export interface MatchProtectedFillSubjectsDiagnostics {
  readonly rejectedGroups: readonly MatchProtectedFillSubjectsRejectedGroup[];
}

export interface MatchProtectedFillSubjectsOutput {
  readonly subjects: readonly MagicBrowseMatchGroupSubject[];
  readonly diagnostics: MatchProtectedFillSubjectsDiagnostics;
}

export async function matchProtectedFillSubjects(
  input: MatchProtectedFillSubjectsInput
): Promise<readonly MagicBrowseMatchGroupSubject[]> {
  const result = await matchProtectedFillSubjectsWithDiagnostics(input);
  return result.subjects;
}

export async function matchProtectedFillSubjectsWithDiagnostics(
  input: MatchProtectedFillSubjectsInput
): Promise<MatchProtectedFillSubjectsOutput> {
  if (input.targets.length === 0) {
    return { subjects: [], diagnostics: { rejectedGroups: [] } };
  }

  const result = await matchSemanticTargets({
    targets: input.targets,
    schemas: protectedSemanticSchemas(),
    host: input.host,
    page: input.page,
    model: input.model,
  });

  const rejectedGroups: MatchProtectedFillSubjectsRejectedGroup[] = [
    ...result.rejectedGroups.map((group) => ({
      ...(group.purpose ? { purpose: group.purpose } : {}),
      ...(group.pageRef ? { pageRef: group.pageRef } : {}),
      acceptedFields: group.acceptedFields,
      rejectedFields: group.rejectedFields,
      reason: group.reason,
    })),
  ];
  const subjects: MagicBrowseMatchGroupSubject[] = [];

  for (const group of result.groups) {
    if (
      group.purpose === 'identity' &&
      !group.fields.some((field) => IDENTITY_ANCHOR_FIELD_KEYS.has(field.fieldKey))
    ) {
      rejectedGroups.push({
        purpose: group.purpose,
        pageRef: group.pageRef,
        acceptedFields: group.fields,
        rejectedFields: group.rejectedFields ?? [],
        reason: 'insufficient_identity_fields',
      });
      continue;
    }

    subjects.push({
      fillRef: group.fillRef ?? group.groupRef ?? `protected:${group.purpose}:${subjects.length + 1}`,
      pageRef: group.pageRef,
      ...(group.scopeRef ? { scopeRef: group.scopeRef } : {}),
      purpose: group.purpose,
      fields: group.fields,
      ...(group.rejectedFields && group.rejectedFields.length > 0
        ? { rejectedFields: group.rejectedFields }
        : {}),
    });
  }

  return {
    subjects,
    diagnostics: {
      rejectedGroups,
    },
  };
}
