import { isFieldShapeCompatible } from './field-shape.js';

export type MagicBrowseSemanticMatchPurpose =
  | 'open_data'
  | 'login'
  | 'identity'
  | 'payment_card';

export type MagicBrowseSemanticConfidence = 'high' | 'medium' | 'low';

export type MagicBrowseSemanticValueType = 'text' | 'email' | 'date' | 'secret';

export type MagicBrowseSemanticCandidateSource =
  | 'memory'
  | 'session_open_value'
  | 'resolver';

export type MagicBrowseSemanticApplicability =
  | { readonly target: 'global' }
  | { readonly target: 'host'; readonly value: string };

export type MagicBrowseProtectedSemanticValueHint =
  | 'direct'
  | 'full_name.given'
  | 'full_name.family'
  | 'date_of_birth.day'
  | 'date_of_birth.month'
  | 'date_of_birth.year';

export type MagicBrowseOpenDataValueHint =
  | 'phone.country_calling_code'
  | 'phone.national_number';

export type MagicBrowseSemanticValueHint =
  | MagicBrowseProtectedSemanticValueHint
  | MagicBrowseOpenDataValueHint;

export type MagicBrowseSemanticNoMatchReason =
  | 'protected_target'
  | 'low_confidence'
  | 'incompatible_shape'
  | 'scope_ineligible'
  | 'unknown_candidate_ref'
  | 'invalid_model_output'
  | 'matcher_unavailable';

export interface MagicBrowseSemanticTargetDescriptor {
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

export interface MagicBrowseSemanticCandidateDescriptor {
  readonly candidateRef: string;
  readonly fieldKey: string;
  readonly value?: string | number | boolean | null;
  readonly source: MagicBrowseSemanticCandidateSource;
  readonly type: MagicBrowseSemanticValueType;
  readonly label?: string;
  readonly semanticTags?: readonly string[];
  readonly applicability: MagicBrowseSemanticApplicability;
  readonly resolve?: {
    readonly kind: 'external_lookup';
    readonly key: string;
  };
}

export interface MagicBrowseSemanticSchemaFieldDescriptor {
  readonly fieldKey: string;
  readonly label?: string;
  readonly type?: MagicBrowseSemanticValueType;
  readonly required?: boolean;
  readonly valueHints?: readonly MagicBrowseSemanticValueHint[];
}

export interface MagicBrowseSemanticSchemaDescriptor {
  readonly schemaRef: string;
  readonly purpose: MagicBrowseSemanticMatchPurpose;
  readonly fields: readonly MagicBrowseSemanticSchemaFieldDescriptor[];
}

export interface MagicBrowseSemanticPageContext {
  readonly url?: string;
  readonly title?: string;
  readonly host?: string;
}

export interface MagicBrowseSemanticMatcherRequest {
  readonly task: 'semanticTargetMatching';
  readonly matcherModel: 'fast';
  readonly host?: string;
  readonly page?: MagicBrowseSemanticPageContext;
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  readonly target?: MagicBrowseSemanticTargetDescriptor;
  readonly candidates?: readonly MagicBrowseSemanticCandidateDescriptor[];
  readonly schemas: readonly MagicBrowseSemanticSchemaDescriptor[];
  readonly prompt: string;
}

export interface MagicBrowseSemanticMatcherModel {
  decide(request: MagicBrowseSemanticMatcherRequest): Promise<unknown>;
}

export type MagicBrowseSemanticFieldResult =
  | {
      readonly status: 'matched';
      readonly targetRef: string;
      readonly candidateRef: string;
      readonly fieldKey: string;
      readonly valueRef: string;
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
      readonly plan: {
        readonly targetRef: string;
        readonly candidateRef: string;
        readonly fieldKey: string;
        readonly valueHint?: MagicBrowseOpenDataValueHint;
        readonly type: MagicBrowseSemanticValueType;
        readonly resolve: {
          readonly kind: 'external_lookup';
          readonly key: string;
        };
      };
    }
  | {
      readonly status: 'ambiguous';
      readonly targetRef: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'no_match';
      readonly targetRef: string;
      readonly reason: MagicBrowseSemanticNoMatchReason;
    };

export interface MagicBrowseSemanticGroupField {
  readonly fieldKey: string;
  readonly targetRef: string;
  readonly label?: string;
  readonly required?: boolean;
  readonly valueHint?: MagicBrowseProtectedSemanticValueHint;
}

export type MagicBrowseSemanticRejectedGroupFieldReason =
  | 'invalid_model_output'
  | 'unknown_target_ref'
  | 'unknown_field_key'
  | 'invalid_value_hint';

export interface MagicBrowseSemanticRejectedGroupField {
  readonly targetRef?: string;
  readonly fieldKey?: string;
  readonly label?: string;
  readonly valueHint?: string;
  readonly reason: MagicBrowseSemanticRejectedGroupFieldReason;
}

export interface MagicBrowseSemanticGroupResult {
  readonly fillRef?: string;
  readonly groupRef?: string;
  readonly pageRef: string;
  readonly scopeRef?: string;
  readonly purpose: Exclude<MagicBrowseSemanticMatchPurpose, 'open_data'>;
  readonly confidence: 'high' | 'medium';
  readonly fields: readonly MagicBrowseSemanticGroupField[];
  readonly rejectedFields?: readonly MagicBrowseSemanticRejectedGroupField[];
}

export type MagicBrowseSemanticRejectedGroupReason =
  | 'invalid_purpose'
  | 'low_confidence'
  | 'invalid_group_shape'
  | 'no_valid_fields'
  | 'conflicting_bindings';

export interface MagicBrowseSemanticRejectedGroup {
  readonly purpose?: string;
  readonly confidence?: string;
  readonly pageRef?: string;
  readonly acceptedFields: readonly MagicBrowseSemanticGroupField[];
  readonly rejectedFields: readonly MagicBrowseSemanticRejectedGroupField[];
  readonly reason: MagicBrowseSemanticRejectedGroupReason;
}

export interface MagicBrowseSemanticMatchInput {
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  readonly candidates?: readonly MagicBrowseSemanticCandidateDescriptor[];
  readonly schemas: readonly MagicBrowseSemanticSchemaDescriptor[];
  readonly host?: string;
  readonly page?: MagicBrowseSemanticPageContext;
  readonly model: MagicBrowseSemanticMatcherModel;
  readonly protectedTargetRefs?: ReadonlySet<string>;
}

export interface MagicBrowseSemanticMatchResult {
  readonly fieldResults: readonly MagicBrowseSemanticFieldResult[];
  readonly groups: readonly MagicBrowseSemanticGroupResult[];
  readonly rejectedGroups: readonly MagicBrowseSemanticRejectedGroup[];
  readonly failureReason?: MagicBrowseSemanticNoMatchReason;
}

type RawRecord = Record<string, unknown>;

const PROTECTED_GROUP_PURPOSES = new Set<MagicBrowseSemanticMatchPurpose>([
  'login',
  'identity',
  'payment_card',
]);

const FIELD_RESULT_STATUSES = new Set(['matched', 'needs_resolution', 'ambiguous', 'no_match']);

export const MAGICBROWSE_SEMANTIC_MATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['matched', 'needs_resolution', 'ambiguous', 'no_match'] },
          targetRef: { type: 'string' },
          candidateRef: { type: 'string' },
          fieldKey: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low', ''] },
          valueHint: {
            type: 'string',
            enum: ['', 'phone.country_calling_code', 'phone.national_number'],
          },
          candidates: { type: 'array', items: { type: 'string' } },
          reason: {
            type: 'string',
            enum: [
              '',
              'protected_target',
              'low_confidence',
              'incompatible_shape',
              'scope_ineligible',
              'unknown_candidate_ref',
              'invalid_model_output',
            ],
          },
        },
        required: [
          'status',
          'targetRef',
          'candidateRef',
          'fieldKey',
          'confidence',
          'candidates',
          'reason',
        ],
      },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fillRef: { type: 'string' },
          groupRef: { type: 'string' },
          pageRef: { type: 'string' },
          scopeRef: { type: 'string' },
          purpose: { type: 'string', enum: ['login', 'identity', 'payment_card'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                targetRef: { type: 'string' },
                fieldKey: { type: 'string' },
                label: { type: 'string' },
                required: { type: 'boolean' },
                valueHint: { type: 'string' },
              },
              required: ['targetRef', 'fieldKey', 'label', 'required', 'valueHint'],
            },
          },
        },
        required: [
          'fillRef',
          'groupRef',
          'pageRef',
          'scopeRef',
          'purpose',
          'confidence',
          'fields',
        ],
      },
    },
  },
  required: ['matches', 'groups'],
} as const;

export async function matchSemanticTargets(
  input: MagicBrowseSemanticMatchInput
): Promise<MagicBrowseSemanticMatchResult> {
  const safeTargets = input.targets.map(sanitizeTarget);
  const safeCandidates = (input.candidates ?? []).map(sanitizeCandidate);
  const safeSchemas = input.schemas.map(sanitizeSchema);
  const request: MagicBrowseSemanticMatcherRequest = {
    task: 'semanticTargetMatching',
    matcherModel: 'fast',
    ...(input.host ? { host: input.host } : {}),
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    targets: safeTargets,
    ...(safeTargets.length === 1 ? { target: safeTargets[0] } : {}),
    ...(safeCandidates.length > 0 ? { candidates: safeCandidates } : {}),
    schemas: safeSchemas,
    prompt: buildSemanticMatchPrompt({
      targets: safeTargets,
      candidates: safeCandidates,
      schemas: safeSchemas,
      host: input.host,
      page: input.page,
    }),
  };

  let modelOutput: unknown;
  try {
    modelOutput = await input.model.decide(request);
  } catch {
    return {
      fieldResults: input.targets.map((target) =>
        noFieldMatch(target.ref, 'matcher_unavailable')
      ),
      groups: [],
      rejectedGroups: [],
      failureReason: 'matcher_unavailable',
    };
  }

  return validateSemanticMatcherOutput(modelOutput, {
    targets: input.targets,
    candidates: input.candidates ?? [],
    schemas: input.schemas,
    protectedTargetRefs: input.protectedTargetRefs,
  });
}

export function buildSemanticMatchPrompt(input: {
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  readonly candidates?: readonly MagicBrowseSemanticCandidateDescriptor[];
  readonly schemas: readonly MagicBrowseSemanticSchemaDescriptor[];
  readonly host?: string;
  readonly page?: MagicBrowseSemanticPageContext;
}): string {
  return JSON.stringify({
    task: 'semanticTargetMatching',
    matcherModel: 'fast',
    instructions: [
      'Match visible browser fields to allowed schema fields by semantic meaning.',
      'Use only provided targetRef and candidateRef values.',
      'Do not invent fields, groups, values, or targets.',
      'Return low confidence or no match when uncertain.',
      'Protected schemas include only field names and purposes; protected values are not provided.',
      'For protected identity, do not include contact email or phone fields unless the schema explicitly allows them.',
      'Checkout country fields are open contact data unless the label clearly asks for nationality or issuing country.',
      'For open_data, prefer the most specific candidate whose field meaning exactly matches the target.',
      'A broad, aggregate, or adjacent candidate must not satisfy a narrower target unless the target asks for the same broad concept.',
      'Fields unrelated to completing the current user task should be no_match unless the task explicitly requires them.',
      'Use every available target signal: label, displayLabel, text, placeholder, inputName, inputType, autocomplete, role, tagName, and context.',
      'For open_data phone fields, include valueHint phone.country_calling_code when the target asks only for the country calling code or prefix.',
      'For open_data phone fields, include valueHint phone.national_number when the target asks for the local/national phone number without country calling code.',
      'Omit valueHint when the target asks for the full phone number.',
    ],
    ...(input.host ? { host: input.host } : {}),
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    targets: input.targets.map(sanitizeTarget),
    candidates: (input.candidates ?? []).map(sanitizeCandidate),
    schemas: input.schemas.map(sanitizeSchema),
    expectedOutput: {
      matches:
        'For open_data, return entries with targetRef, candidateRef, fieldKey, confidence, optional valueHint.',
      groups:
        'For protected forms, return groups with purpose, fields[{targetRef, fieldKey, valueHint?}], confidence.',
    },
  });
}

export function protectedSemanticSchemas(): readonly MagicBrowseSemanticSchemaDescriptor[] {
  return [
    {
      schemaRef: 'login.basic',
      purpose: 'login',
      fields: [
        { fieldKey: 'username', label: 'Username or account email', type: 'text', required: true },
        { fieldKey: 'password', label: 'Password', type: 'secret', required: true },
      ],
    },
    {
      schemaRef: 'identity.basic',
      purpose: 'identity',
      fields: [
        {
          fieldKey: 'full_name',
          label: 'Legal full name',
          type: 'text',
          required: true,
          valueHints: ['direct', 'full_name.given', 'full_name.family'],
        },
        { fieldKey: 'document_number', label: 'Identity document number', type: 'secret' },
        {
          fieldKey: 'date_of_birth',
          label: 'Date of birth',
          type: 'date',
          valueHints: [
            'direct',
            'date_of_birth.day',
            'date_of_birth.month',
            'date_of_birth.year',
          ],
        },
        { fieldKey: 'nationality', label: 'Nationality', type: 'text' },
        { fieldKey: 'issue_date', label: 'Document issue date', type: 'date' },
        { fieldKey: 'expiry_date', label: 'Document expiry date', type: 'date' },
        { fieldKey: 'issuing_country', label: 'Issuing country', type: 'text' },
      ],
    },
    {
      schemaRef: 'payment_card.provider',
      purpose: 'payment_card',
      fields: [
        { fieldKey: 'cardholder', label: 'Cardholder name', type: 'text' },
        { fieldKey: 'pan', label: 'Card number', type: 'secret', required: true },
        { fieldKey: 'exp_month', label: 'Card expiry month', type: 'text', required: true },
        { fieldKey: 'exp_year', label: 'Card expiry year', type: 'text', required: true },
        { fieldKey: 'cvv', label: 'Card security code', type: 'secret' },
      ],
    },
  ];
}

export function openDataSemanticSchema(
  candidates: readonly MagicBrowseSemanticCandidateDescriptor[]
): MagicBrowseSemanticSchemaDescriptor {
  const fieldsByKey = new Map<string, MagicBrowseSemanticSchemaFieldDescriptor>();
  for (const candidate of candidates) {
    if (!fieldsByKey.has(candidate.fieldKey)) {
      fieldsByKey.set(candidate.fieldKey, {
        fieldKey: candidate.fieldKey,
        label: candidate.label,
        type: candidate.type,
        ...(candidate.fieldKey === 'phone'
          ? {
              valueHints: [
                'phone.country_calling_code',
                'phone.national_number',
              ],
            }
          : {}),
      });
    }
  }

  return {
    schemaRef: 'open_data.available_values',
    purpose: 'open_data',
    fields: [...fieldsByKey.values()],
  };
}

function validateSemanticMatcherOutput(
  output: unknown,
  context: {
    readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
    readonly candidates: readonly MagicBrowseSemanticCandidateDescriptor[];
    readonly schemas: readonly MagicBrowseSemanticSchemaDescriptor[];
    readonly protectedTargetRefs?: ReadonlySet<string>;
  }
): MagicBrowseSemanticMatchResult {
  const targetByRef = new Map(context.targets.map((target) => [target.ref, target]));
  const candidateByRef = new Map(
    context.candidates.map((candidate) => [candidate.candidateRef, candidate])
  );
  const schemaByPurpose = new Map(context.schemas.map((schema) => [schema.purpose, schema]));
  const raw = asRecord(output);
  if (!raw) {
    return invalidSemanticResult(context.targets);
  }

  const rawFieldEntries = readRawFieldEntries(raw);
  const rawGroups = readRawGroups(raw);
  const hasProtectedSchema = context.schemas.some((schema) => isProtectedPurpose(schema.purpose));
  if (rawGroups.length > 0 && !hasProtectedSchema) {
    return invalidSemanticResult(context.targets);
  }

  const fieldResults = context.targets.map((target) =>
    validateFieldEntry(rawFieldEntries.find((entry) => entry.targetRef === target.ref), {
      target,
      candidateByRef,
      schemaByPurpose,
      protectedTargetRefs: context.protectedTargetRefs,
    })
  );

  const groups: MagicBrowseSemanticGroupResult[] = [];
  const rejectedGroups: MagicBrowseSemanticRejectedGroup[] = [];
  for (const group of rawGroups) {
    const validated = validateGroupEntry(group, {
      targetByRef,
      schemaByPurpose,
    });
    if (validated.status === 'accepted') {
      groups.push(validated.group);
    } else {
      rejectedGroups.push(validated.group);
    }
  }

  return {
    fieldResults,
    groups,
    rejectedGroups,
  };
}

function readRawFieldEntries(raw: RawRecord): RawRecord[] {
  if (typeof raw.status === 'string' && FIELD_RESULT_STATUSES.has(raw.status)) {
    return [raw];
  }

  const entries = Array.isArray(raw.matches) ? raw.matches : [];
  return entries.filter((entry): entry is RawRecord => asRecord(entry) !== undefined);
}

function readRawGroups(raw: RawRecord): RawRecord[] {
  const entries = Array.isArray(raw.groups) ? raw.groups : [];
  return entries.filter((entry): entry is RawRecord => asRecord(entry) !== undefined);
}

function validateFieldEntry(
  raw: RawRecord | undefined,
  context: {
    readonly target: MagicBrowseSemanticTargetDescriptor;
    readonly candidateByRef: ReadonlyMap<string, MagicBrowseSemanticCandidateDescriptor>;
    readonly schemaByPurpose: ReadonlyMap<
      MagicBrowseSemanticMatchPurpose,
      MagicBrowseSemanticSchemaDescriptor
    >;
    readonly protectedTargetRefs?: ReadonlySet<string>;
  }
): MagicBrowseSemanticFieldResult {
  if (context.protectedTargetRefs?.has(context.target.ref) === true) {
    return noFieldMatch(context.target.ref, 'protected_target');
  }
  if (!raw) {
    return noFieldMatch(context.target.ref, 'low_confidence');
  }
  if (raw.targetRef !== context.target.ref) {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }

  if (raw.status === 'no_match') {
    return noFieldMatch(context.target.ref, readNoMatchReason(raw.reason));
  }
  if (raw.status === 'ambiguous') {
    return validateAmbiguousField(raw, context);
  }
  if (raw.status !== 'matched' && raw.status !== 'needs_resolution') {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }

  if (raw.confidence === 'low') {
    return noFieldMatch(context.target.ref, 'low_confidence');
  }
  if (raw.confidence !== 'high' && raw.confidence !== 'medium') {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }
  if (typeof raw.candidateRef !== 'string' || typeof raw.fieldKey !== 'string') {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }

  const candidate = context.candidateByRef.get(raw.candidateRef);
  if (!candidate) {
    return noFieldMatch(context.target.ref, 'unknown_candidate_ref');
  }
  const schemaField = schemaFieldForKey(context.schemaByPurpose.get('open_data'), raw.fieldKey);
  if (!schemaField) {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }
  if (candidate.fieldKey !== raw.fieldKey) {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }
  if (!isShapeCompatible(context.target, candidate)) {
    return noFieldMatch(context.target.ref, 'incompatible_shape');
  }

  const valueHint = readOpenDataValueHint(raw.valueHint, schemaField);
  if (valueHint === false) {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }

  if (raw.status === 'needs_resolution' || candidate.value === undefined) {
    if (!candidate.resolve) {
      return noFieldMatch(context.target.ref, 'invalid_model_output');
    }
    return {
      status: 'needs_resolution',
        targetRef: context.target.ref,
        candidateRef: candidate.candidateRef,
        fieldKey: candidate.fieldKey,
        ...(valueHint ? { valueHint } : {}),
        confidence: raw.confidence,
        plan: {
          targetRef: context.target.ref,
          candidateRef: candidate.candidateRef,
          fieldKey: candidate.fieldKey,
          ...(valueHint ? { valueHint } : {}),
          type: candidate.type,
          resolve: candidate.resolve,
        },
    };
  }

  return {
    status: 'matched',
    targetRef: context.target.ref,
    candidateRef: candidate.candidateRef,
    fieldKey: candidate.fieldKey,
    valueRef: createValueRef(candidate.candidateRef),
    ...(valueHint ? { valueHint } : {}),
    confidence: raw.confidence,
  };
}

function validateAmbiguousField(
  raw: RawRecord,
  context: {
    readonly target: MagicBrowseSemanticTargetDescriptor;
    readonly candidateByRef: ReadonlyMap<string, MagicBrowseSemanticCandidateDescriptor>;
  }
): MagicBrowseSemanticFieldResult {
  if (
    !Array.isArray(raw.candidates) ||
    raw.candidates.length === 0 ||
    !raw.candidates.every((candidateRef) => typeof candidateRef === 'string')
  ) {
    return noFieldMatch(context.target.ref, 'invalid_model_output');
  }

  for (const candidateRef of raw.candidates as string[]) {
    const candidate = context.candidateByRef.get(candidateRef);
    if (!candidate) {
      return noFieldMatch(context.target.ref, 'unknown_candidate_ref');
    }
    if (!isShapeCompatible(context.target, candidate)) {
      return noFieldMatch(context.target.ref, 'incompatible_shape');
    }
  }

  return {
    status: 'ambiguous',
    targetRef: context.target.ref,
    candidates: raw.candidates as string[],
  };
}

type GroupValidationOutcome =
  | { readonly status: 'accepted'; readonly group: MagicBrowseSemanticGroupResult }
  | { readonly status: 'rejected'; readonly group: MagicBrowseSemanticRejectedGroup };

function validateGroupEntry(
  raw: RawRecord,
  context: {
    readonly targetByRef: ReadonlyMap<string, MagicBrowseSemanticTargetDescriptor>;
    readonly schemaByPurpose: ReadonlyMap<
      MagicBrowseSemanticMatchPurpose,
      MagicBrowseSemanticSchemaDescriptor
    >;
  }
): GroupValidationOutcome {
  const purpose = typeof raw.purpose === 'string' ? raw.purpose : undefined;
  const confidence = typeof raw.confidence === 'string' ? raw.confidence : undefined;
  const pageRef = readNonEmptyString(raw.pageRef);

  if (!isProtectedPurpose(raw.purpose)) {
    return rejectGroup({
      purpose,
      confidence,
      pageRef,
      reason: 'invalid_purpose',
    });
  }
  if (raw.confidence === 'low') {
    return rejectGroup({
      purpose: raw.purpose,
      confidence: raw.confidence,
      pageRef,
      reason: 'low_confidence',
    });
  }
  if (raw.confidence !== 'high' && raw.confidence !== 'medium') {
    return rejectGroup({
      purpose: raw.purpose,
      confidence,
      pageRef,
      reason: 'invalid_group_shape',
    });
  }
  const schema = context.schemaByPurpose.get(raw.purpose);
  if (!schema || !Array.isArray(raw.fields) || raw.fields.length === 0) {
    return rejectGroup({
      purpose: raw.purpose,
      confidence: raw.confidence,
      pageRef,
      reason: 'invalid_group_shape',
    });
  }

  const fields: MagicBrowseSemanticGroupField[] = [];
  const rejectedFields: MagicBrowseSemanticRejectedGroupField[] = [];
  for (const entry of raw.fields) {
    const field = validateGroupField(entry, {
      schema,
      targetByRef: context.targetByRef,
    });
    if (field.status === 'accepted') {
      fields.push(field.field);
    } else {
      rejectedFields.push(field.field);
    }
  }

  if (fields.length === 0) {
    return rejectGroup({
      purpose: raw.purpose,
      confidence: raw.confidence,
      pageRef,
      acceptedFields: fields,
      rejectedFields,
      reason: 'no_valid_fields',
    });
  }

  if (hasConflictingGroupBindings(fields)) {
    return rejectGroup({
      purpose: raw.purpose,
      confidence: raw.confidence,
      pageRef,
      acceptedFields: fields,
      rejectedFields,
      reason: 'conflicting_bindings',
    });
  }

  const firstTarget = fields
    .map((field) => context.targetByRef.get(field.targetRef))
    .find((target): target is MagicBrowseSemanticTargetDescriptor => target !== undefined);

  return {
    status: 'accepted',
    group: {
      ...(readNonEmptyString(raw.fillRef) ? { fillRef: readNonEmptyString(raw.fillRef) } : {}),
      ...(readNonEmptyString(raw.groupRef) ? { groupRef: readNonEmptyString(raw.groupRef) } : {}),
      pageRef: pageRef ?? firstTarget?.pageRef ?? 'p0',
      ...(readNonEmptyString(raw.scopeRef) ? { scopeRef: readNonEmptyString(raw.scopeRef) } : {}),
      purpose: raw.purpose,
      confidence: raw.confidence,
      fields,
      ...(rejectedFields.length > 0 ? { rejectedFields } : {}),
    },
  };
}

function validateGroupField(
  raw: unknown,
  context: {
    readonly schema: MagicBrowseSemanticSchemaDescriptor;
    readonly targetByRef: ReadonlyMap<string, MagicBrowseSemanticTargetDescriptor>;
  }
):
  | { readonly status: 'accepted'; readonly field: MagicBrowseSemanticGroupField }
  | { readonly status: 'rejected'; readonly field: MagicBrowseSemanticRejectedGroupField } {
  const record = asRecord(raw);
  if (!record || typeof record.targetRef !== 'string' || typeof record.fieldKey !== 'string') {
    return {
      status: 'rejected',
      field: {
        ...(typeof record?.targetRef === 'string' ? { targetRef: record.targetRef } : {}),
        ...(typeof record?.fieldKey === 'string' ? { fieldKey: record.fieldKey } : {}),
        ...(typeof record?.valueHint === 'string' ? { valueHint: record.valueHint } : {}),
        reason: 'invalid_model_output',
      },
    };
  }
  const target = context.targetByRef.get(record.targetRef);
  if (!target) {
    return {
      status: 'rejected',
      field: {
        targetRef: record.targetRef,
        fieldKey: record.fieldKey,
        ...(typeof record.valueHint === 'string' ? { valueHint: record.valueHint } : {}),
        reason: 'unknown_target_ref',
      },
    };
  }
  const schemaField = context.schema.fields.find((field) => field.fieldKey === record.fieldKey);
  if (!schemaField) {
    return {
      status: 'rejected',
      field: {
        targetRef: record.targetRef,
        fieldKey: record.fieldKey,
        ...(target.label ? { label: target.label } : {}),
        ...(typeof record.valueHint === 'string' ? { valueHint: record.valueHint } : {}),
        reason: 'unknown_field_key',
      },
    };
  }
  const valueHint = typeof record.valueHint === 'string' ? record.valueHint : undefined;
  if (valueHint && !schemaAllowsValueHint(schemaField, valueHint)) {
    return {
      status: 'rejected',
      field: {
        targetRef: record.targetRef,
        fieldKey: record.fieldKey,
        ...(target.label ? { label: target.label } : {}),
        valueHint,
        reason: 'invalid_value_hint',
      },
    };
  }

  return {
    status: 'accepted',
    field: {
      fieldKey: record.fieldKey,
      targetRef: record.targetRef,
      ...(readNonEmptyString(record.label)
        ? { label: readNonEmptyString(record.label) }
        : target.label
          ? { label: target.label }
          : {}),
      ...(typeof record.required === 'boolean'
        ? { required: record.required }
        : typeof schemaField.required === 'boolean'
          ? { required: schemaField.required }
          : {}),
      ...(valueHint ? { valueHint: valueHint as MagicBrowseProtectedSemanticValueHint } : {}),
    },
  };
}

function rejectGroup(input: {
  readonly purpose?: string;
  readonly confidence?: string;
  readonly pageRef?: string;
  readonly acceptedFields?: readonly MagicBrowseSemanticGroupField[];
  readonly rejectedFields?: readonly MagicBrowseSemanticRejectedGroupField[];
  readonly reason: MagicBrowseSemanticRejectedGroupReason;
}): GroupValidationOutcome {
  return {
    status: 'rejected',
    group: {
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.pageRef ? { pageRef: input.pageRef } : {}),
      acceptedFields: input.acceptedFields ?? [],
      rejectedFields: input.rejectedFields ?? [],
      reason: input.reason,
    },
  };
}

function hasConflictingGroupBindings(fields: readonly MagicBrowseSemanticGroupField[]): boolean {
  const fieldsByTarget = new Map<string, MagicBrowseSemanticGroupField[]>();
  const fieldsByKey = new Map<string, MagicBrowseSemanticGroupField[]>();

  for (const field of fields) {
    const fieldId = `${field.fieldKey}:${field.valueHint ?? 'direct'}`;
    const sameFieldAndHint = fieldsByKey.get(fieldId);
    if (sameFieldAndHint && sameFieldAndHint.length > 0) {
      return true;
    }
    fieldsByKey.set(fieldId, [field]);
    const targetFields = fieldsByTarget.get(field.targetRef) ?? [];
    targetFields.push(field);
    fieldsByTarget.set(field.targetRef, targetFields);
  }

  for (const fieldKey of new Set(fields.map((field) => field.fieldKey))) {
    const sameKey = fields.filter((field) => field.fieldKey === fieldKey);
    if (sameKey.length <= 1) {
      continue;
    }
    const hints = new Set(sameKey.map((field) => field.valueHint ?? 'direct'));
    if (
      fieldKey === 'full_name' &&
      hints.size === sameKey.length &&
      [...hints].every((hint) => hint === 'full_name.given' || hint === 'full_name.family')
    ) {
      continue;
    }
    if (
      fieldKey === 'date_of_birth' &&
      hints.size === sameKey.length &&
      [...hints].every(
        (hint) =>
          hint === 'date_of_birth.day' ||
          hint === 'date_of_birth.month' ||
          hint === 'date_of_birth.year'
      )
    ) {
      continue;
    }
    return true;
  }

  for (const targetFields of fieldsByTarget.values()) {
    if (targetFields.length <= 1) {
      continue;
    }
    const fieldKeys = new Set(targetFields.map((field) => field.fieldKey));
    if (fieldKeys.size === 2 && fieldKeys.has('exp_month') && fieldKeys.has('exp_year')) {
      continue;
    }
    return true;
  }

  return false;
}

function schemaFieldForKey(
  schema: MagicBrowseSemanticSchemaDescriptor | undefined,
  fieldKey: string
): MagicBrowseSemanticSchemaFieldDescriptor | undefined {
  return schema?.fields.find((field) => field.fieldKey === fieldKey);
}

function readOpenDataValueHint(
  value: unknown,
  field: MagicBrowseSemanticSchemaFieldDescriptor
): MagicBrowseOpenDataValueHint | undefined | false {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return false;
  }
  if (value !== 'phone.country_calling_code' && value !== 'phone.national_number') {
    return false;
  }
  if (!schemaAllowsValueHint(field, value)) {
    return false;
  }

  return value;
}

function schemaAllowsValueHint(
  field: MagicBrowseSemanticSchemaFieldDescriptor,
  valueHint: string
): boolean {
  if (valueHint === 'direct' && !field.valueHints) {
    return true;
  }
  return field.valueHints?.includes(valueHint as MagicBrowseSemanticValueHint) === true;
}

function sanitizePage(page: MagicBrowseSemanticPageContext): MagicBrowseSemanticPageContext {
  return {
    ...(page.url ? { url: page.url } : {}),
    ...(page.title ? { title: page.title } : {}),
    ...(page.host ? { host: page.host } : {}),
  };
}

function sanitizeTarget(
  target: MagicBrowseSemanticTargetDescriptor
): MagicBrowseSemanticTargetDescriptor {
  return {
    ref: target.ref,
    index: target.index,
    selectorMapIndex: target.selectorMapIndex,
    pageRef: target.pageRef,
    kind: target.kind,
    tagName: target.tagName,
    role: target.role,
    label: target.label,
    displayLabel: target.displayLabel,
    text: target.text,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    selectorRoot: target.selectorRoot,
    isReadonly: target.isReadonly,
    popupBacked: target.popupBacked,
    allowedActions: target.allowedActions,
    host: target.host,
    context: sanitizeTargetContext(target),
  };
}

function sanitizeTargetContext(target: MagicBrowseSemanticTargetDescriptor): unknown {
  const context = asRecord(target.context);
  if (!context) {
    return undefined;
  }

  const form = asRecord(context.form);
  const state = asRecord(context.state);
  const selector = asRecord(context.selector);

  return {
    ...(form
      ? {
          form: {
            tagName: readString(form.tagName),
            id: readString(form.id),
            name: readString(form.name),
            label: readString(form.label),
          },
        }
      : {}),
    ...(state
      ? {
          state: {
            readonly: typeof state.readonly === 'boolean' ? state.readonly : undefined,
            disabled: typeof state.disabled === 'boolean' ? state.disabled : undefined,
            required: typeof state.required === 'boolean' ? state.required : undefined,
            popupBacked: typeof state.popupBacked === 'boolean' ? state.popupBacked : undefined,
          },
        }
      : {}),
    ...(selector
      ? {
          selector: {
            id: readString(selector.id),
            name: readString(selector.name),
            role: readString(selector.role),
          },
        }
      : {}),
  };
}

function sanitizeCandidate(
  candidate: MagicBrowseSemanticCandidateDescriptor
): MagicBrowseSemanticCandidateDescriptor {
  return {
    candidateRef: candidate.candidateRef,
    fieldKey: candidate.fieldKey,
    source: candidate.source,
    type: candidate.type,
    label: candidate.label,
    semanticTags: candidate.semanticTags,
    applicability: candidate.applicability,
    resolve: candidate.resolve,
  };
}

function sanitizeSchema(
  schema: MagicBrowseSemanticSchemaDescriptor
): MagicBrowseSemanticSchemaDescriptor {
  return {
    schemaRef: schema.schemaRef,
    purpose: schema.purpose,
    fields: schema.fields.map((field) => ({
      fieldKey: field.fieldKey,
      label: field.label,
      type: field.type,
      required: field.required,
      valueHints: field.valueHints,
    })),
  };
}

function isShapeCompatible(
  target: MagicBrowseSemanticTargetDescriptor,
  candidate: MagicBrowseSemanticCandidateDescriptor
): boolean {
  return isFieldShapeCompatible(target, candidate);
}

function isProtectedPurpose(
  value: unknown
): value is Exclude<MagicBrowseSemanticMatchPurpose, 'open_data'> {
  return typeof value === 'string' && PROTECTED_GROUP_PURPOSES.has(value as never);
}

function readNoMatchReason(value: unknown): MagicBrowseSemanticNoMatchReason {
  switch (value) {
    case 'protected_target':
    case 'low_confidence':
    case 'incompatible_shape':
    case 'scope_ineligible':
    case 'unknown_candidate_ref':
    case 'matcher_unavailable':
      return value;
    case 'invalid_model_output':
    default:
      return 'invalid_model_output';
  }
}

function invalidSemanticResult(
  targets: readonly MagicBrowseSemanticTargetDescriptor[]
): MagicBrowseSemanticMatchResult {
  return {
    fieldResults: targets.map((target) => noFieldMatch(target.ref, 'invalid_model_output')),
    groups: [],
    rejectedGroups: [],
    failureReason: 'invalid_model_output',
  };
}

function noFieldMatch(
  targetRef: string,
  reason: MagicBrowseSemanticNoMatchReason
): MagicBrowseSemanticFieldResult {
  return {
    status: 'no_match',
    targetRef,
    reason,
  };
}

function createValueRef(candidateRef: string): string {
  return `value:${candidateRef}:${hashRef(candidateRef)}`;
}

function hashRef(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function asRecord(value: unknown): RawRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as RawRecord;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
