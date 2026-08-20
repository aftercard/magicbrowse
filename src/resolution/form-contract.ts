import type {
  MagicBrowseSemanticPageContext,
  MagicBrowseSemanticTargetDescriptor,
  MagicBrowseTargetOptionGroup,
  MagicBrowseTargetOptionGroupMember,
} from './semantic-match.js';

export type MagicBrowseFormFieldRelevance =
  | 'task_required'
  | 'task_optional'
  /**
   * A control that configures what is being bought — a quantity, a tier, a
   * plan, a shipping option — whose value is chosen by operating the page.
   *
   * Task-relevant, and not the user's data. Without this category the only
   * task-relevant labels are the two field ones, so a quantity chooser could
   * only be called a field, and every field the fill loop cannot satisfy from
   * Memory becomes a question put to the user. That is how a checkout came to
   * ask someone to type `1` into a field labelled `1`, `3` into `3` and `5`
   * into `5`, all three marked required and therefore unsatisfiable.
   */
  | 'task_control'
  | 'unrelated'
  | 'marketing'
  | 'provider_managed'
  | 'final_commitment'
  | 'ambiguous';

export type MagicBrowseFormFieldSensitivity = 'public' | 'personal' | 'secret' | 'payment';

export type MagicBrowseFormSubjectMode = 'single' | 'multiple' | 'unknown';

export interface MagicBrowseFormControlOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface MagicBrowseFormControl {
  readonly kind: 'select' | 'radio' | 'checkbox' | 'toggle';
  readonly options?: readonly MagicBrowseFormControlOption[];
  /** Consent-like state is current-run only unless a future policy explicitly permits storage. */
  readonly persistable: boolean;
}

export interface MagicBrowseFormFieldIntent {
  readonly targetRef: string;
  readonly fieldKey: string;
  readonly label: string;
  readonly semanticHint: string;
  readonly inputType?: string;
  readonly control?: MagicBrowseFormControl;
  readonly sensitivity: MagicBrowseFormFieldSensitivity;
  readonly required: boolean;
  readonly relevance: 'task_required' | 'task_optional';
  readonly subjectRole?: string;
}

export interface MagicBrowseFormContract {
  readonly id: string;
  readonly fingerprint: string;
  readonly purpose: string;
  readonly confidence: 'high' | 'medium';
  readonly subjectMode: MagicBrowseFormSubjectMode;
  readonly fields: readonly MagicBrowseFormFieldIntent[];
  readonly saveSuggestion: {
    readonly displayName: string;
  };
}

export interface MagicBrowseFormContractClassification {
  readonly targetRef: string;
  readonly relevance: MagicBrowseFormFieldRelevance;
  readonly reason?: string;
}

export interface MagicBrowseFormContractCompilerRequest {
  readonly task: 'formContractCompilation';
  readonly matcherModel: 'xfast';
  readonly page?: MagicBrowseSemanticPageContext;
  readonly purpose?: string;
  readonly taskGoal?: string;
  readonly subjectHints?: readonly string[];
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  /**
   * The page as rendered, when it can be shown without exposing anything.
   *
   * A choice a page draws as a row of buttons is obvious on sight and often
   * invisible in the DOM: markup expresses the relationship only when it wants
   * to, and a chooser built from plain `<div>`s leaves nothing to group by.
   *
   * Present only before any protected value reaches the page — the screenshot
   * API refuses once one has, so a filled card can never arrive here. Callers
   * pass what they were given; absence is normal and never an error.
   */
  readonly pageImage?: MagicBrowseFormContractPageImage;
  readonly prompt: string;
}

export interface MagicBrowseFormContractPageImage {
  /** JPEG bytes, base64 encoded. */
  readonly base64: string;
  readonly description?: string;
}

export interface MagicBrowseFormContractCompilerModel {
  decide(request: MagicBrowseFormContractCompilerRequest): Promise<unknown>;
}

export interface CompileMagicBrowseFormContractInput {
  readonly fingerprint: string;
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  readonly model: MagicBrowseFormContractCompilerModel;
  readonly page?: MagicBrowseSemanticPageContext;
  readonly purpose?: string;
  readonly taskGoal?: string;
  readonly subjectHints?: readonly string[];
  /** Passed through to the matcher when the caller could capture one; see
   * MagicBrowseFormContractCompilerRequest.pageImage. */
  readonly pageImage?: MagicBrowseFormContractPageImage;
}

export type CompileMagicBrowseFormContractResult =
  | {
      readonly success: true;
      readonly contract: MagicBrowseFormContract;
      readonly classifications: readonly MagicBrowseFormContractClassification[];
    }
  | {
      readonly success: false;
      readonly reason:
        | 'no_targets'
        | 'compiler_unavailable'
        | 'invalid_model_output'
        | 'low_confidence'
        | 'no_task_relevant_fields';
      /** Underlying error text for diagnosability; never contains field values. */
      readonly detail?: string;
      /**
       * Classifications the model did produce, present when the page held no
       * fillable field. A page whose only control commits the purchase is the
       * ordinary case here, and the caller still needs to know which control
       * that is — discarding the verdict would force it to guess.
       */
      readonly classifications?: readonly MagicBrowseFormContractClassification[];
    };

type RawRecord = Record<string, unknown>;

const RELEVANCE = new Set<MagicBrowseFormFieldRelevance>([
  'task_required',
  'task_optional',
  'task_control',
  'unrelated',
  'marketing',
  'provider_managed',
  'final_commitment',
  'ambiguous',
]);
const SENSITIVITY = new Set<MagicBrowseFormFieldSensitivity>([
  'public',
  'personal',
  'secret',
  'payment',
]);
const SUBJECT_MODES = new Set<MagicBrowseFormSubjectMode>(['single', 'multiple', 'unknown']);
const RELAY_INPUT_TYPES = new Set([
  'text',
  'email',
  'tel',
  'number',
  'date',
  'password',
  'multiline',
]);
const STRONG_OPEN_COMBOBOX_RELAY_TYPES = new Set(['email', 'tel', 'password']);
const ACCEPTED_RELEVANCE = new Set<MagicBrowseFormFieldRelevance>([
  'task_required',
  'task_optional',
]);
const MAX_TEXT_LENGTH = 240;
const MAX_FORM_TARGETS = 64;
const MAX_CONTROL_OPTIONS = 128;

const FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fieldKey: { type: 'string' },
    label: { type: 'string' },
    semanticHint: { type: 'string' },
    inputType: { type: 'string' },
    relayInputType: {
      type: 'string',
      enum: ['text', 'email', 'tel', 'number', 'date', 'password', 'multiline'],
    },
    sensitivity: {
      type: 'string',
      enum: ['public', 'personal', 'secret', 'payment'],
    },
    relevance: {
      type: 'string',
      enum: [
        'task_required',
        'task_optional',
        'task_control',
        'unrelated',
        'marketing',
        'provider_managed',
        'final_commitment',
        'ambiguous',
      ],
    },
    subjectRole: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['fieldKey', 'label', 'semanticHint', 'sensitivity', 'relevance'],
} as const;

const FORM_CONTRACT_COMMON_PROPERTIES = {
  purpose: { type: 'string' },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  subjectMode: { type: 'string', enum: ['single', 'multiple', 'unknown'] },
  saveSuggestion: {
    type: 'object',
    additionalProperties: false,
    properties: {
      displayName: { type: 'string' },
    },
    required: ['displayName'],
  },
} as const;

/**
 * Backward-compatible static schema for callers that do not have the target
 * set at schema-construction time. Product runtime uses the target-keyed
 * schema below so strict output enforces complete target coverage.
 */
export const MAGICBROWSE_FORM_CONTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contract: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...FORM_CONTRACT_COMMON_PROPERTIES,
        fields: {
          type: 'array',
          items: {
            ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA,
            properties: {
              targetRef: { type: 'string' },
              ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA.properties,
            },
            required: ['targetRef', ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA.required],
          },
        },
      },
      required: ['purpose', 'confidence', 'subjectMode', 'saveSuggestion', 'fields'],
    },
  },
  required: ['contract'],
} as const;

export function magicBrowseFormContractJsonSchema(
  targets: readonly Pick<MagicBrowseSemanticTargetDescriptor, 'ref'>[]
): Record<string, unknown> {
  // Array form, not one required object slot per target: the assistive gateway
  // rejects response schemas larger than ~13KB regardless of model (observed
  // 2026-08-09: 18 slots OK at 12.6KB, 21 slots 502 at 14.6KB), and the slot
  // form grows ~670 bytes per target. The array form stays near-constant in
  // size; targetRef is constrained to the real refs, and exactly-once coverage
  // is enforced by validateContractOutput instead of by the schema.
  const refs = targets.map((target) => target.ref);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      contract: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...FORM_CONTRACT_COMMON_PROPERTIES,
          fields: {
            type: 'array',
            items: {
              ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA,
              properties: {
                targetRef: refs.length > 0 ? { type: 'string', enum: refs } : { type: 'string' },
                ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA.properties,
              },
              required: ['targetRef', ...FORM_CONTRACT_CLASSIFICATION_JSON_SCHEMA.required],
            },
          },
        },
        required: ['purpose', 'confidence', 'subjectMode', 'saveSuggestion', 'fields'],
      },
    },
    required: ['contract'],
  };
}

export async function compileMagicBrowseFormContract(
  input: CompileMagicBrowseFormContractInput
): Promise<CompileMagicBrowseFormContractResult> {
  if (input.targets.length === 0) {
    return { success: false, reason: 'no_targets' };
  }
  // Cerebras strict structured output does not support the JSON Schema
  // maxItems keyword. Keep the same bound at the trusted client boundary and
  // send a provider-portable schema to xfast.
  if (input.targets.length > MAX_FORM_TARGETS) {
    return { success: false, reason: 'invalid_model_output' };
  }

  const optionGroups = optionGroupsByRef(input.targets);
  const targets = input.targets.map((target) =>
    sanitizeTarget(target, optionGroups.get(target.ref))
  );
  const request: MagicBrowseFormContractCompilerRequest = {
    task: 'formContractCompilation',
    matcherModel: 'xfast',
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    ...(cleanText(input.purpose) ? { purpose: cleanText(input.purpose) } : {}),
    ...(cleanText(input.taskGoal) ? { taskGoal: cleanText(input.taskGoal) } : {}),
    ...(cleanStringArray(input.subjectHints).length > 0
      ? { subjectHints: cleanStringArray(input.subjectHints) }
      : {}),
    targets,
    ...(input.pageImage?.base64 ? { pageImage: input.pageImage } : {}),
    prompt: buildMagicBrowseFormContractPrompt({
      targets,
      page: input.page,
      purpose: input.purpose,
      taskGoal: input.taskGoal,
      subjectHints: input.subjectHints,
    }),
  };

  let output: unknown;
  try {
    output = await input.model.decide(request);
  } catch (error) {
    // The matcher gateway error is operational metadata (HTTP status, model
    // refusal, schema rejection) — losing it makes a red run unclassifiable.
    return {
      success: false,
      reason: 'compiler_unavailable',
      detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }

  return validateContractOutput(output, input.fingerprint, input.targets);
}

export function buildMagicBrowseFormContractPrompt(input: {
  readonly targets: readonly MagicBrowseSemanticTargetDescriptor[];
  readonly page?: MagicBrowseSemanticPageContext;
  readonly purpose?: string;
  readonly taskGoal?: string;
  readonly subjectHints?: readonly string[];
}): string {
  return JSON.stringify({
    task: 'formContractCompilation',
    matcherModel: 'xfast',
    instructions: [
      'Classify every observed target exactly once and compile one coherent task form.',
      'Use only provided targetRef values and value-free visible target metadata.',
      'Include task-required and task-optional user-fillable fields in the form contract.',
      'Treat one checkout as a cross-surface form: merchant-level controls in the active modal and embedded payment-provider controls can both belong to the same task, even when they repeat a label such as Email.',
      'Use context.state.withinEmbeddedFrame to distinguish embedded-provider controls from merchant-page controls. A provider billing or Link email does not satisfy a separate merchant checkout email; classify each owner-required control independently.',
      'In checkout, payment, booking, or donation flows, treat a merchant-page contact email near the active payment commitment as task_required unless visible metadata explicitly identifies it as optional, marketing, newsletter, or receipt opt-in. Native required attributes may be absent when the merchant validates in application state.',
      'A user-fillable target with context.state.withinActiveModal is part of the active interaction layer; judge it against the task and final commitment instead of discarding it merely because it is outside a native form or provider iframe.',
      'Include task-required payment credential inputs such as card number, expiration date, and security code; their protected values are supplied later by a provider-managed payment method and the inputs themselves are not unrelated provider widgets.',
      'For a task-relevant user-fillable target, context.state.required or context.state.ariaRequired means task_required even when the field otherwise looks optional.',
      'Exclude unrelated forms, search, newsletters, marketing opt-ins, provider-managed widgets, and final commitment controls.',
      "Use task_control for a control that configures what is being bought — quantity, tier, plan, billing period, shipping option — whose value is chosen by operating the page rather than supplied by the user. It is task-relevant and it is not the user's data, so it is never a field.",
      'A bare number, a price, or a plan name labelling one of several mutually exclusive choices is task_control, not a field to fill. optionGroup, when present, lists the sibling choices and which one the page already has selected: classify each member of the group the same way.',
      'Never classify a task_control target as task_required or task_optional. Asking the user to supply a value that is already an option on the page is always wrong, and marking every option of one choice required cannot be satisfied.',
      'Do not infer or output field values, Memory values, handles, credentials, secrets, selectors, or hidden metadata.',
      'fieldKey must be a stable semantic key, label must be user-facing, and semanticHint must briefly explain the field meaning.',
      'For an included text-like or unusual custom input, set relayInputType to the safest normalized grouped-request control: text, email, tel, number, date, password, or multiline.',
      'Do not use relayInputType to turn a closed choice into free text. Browser-observed radio, checkbox, toggle, native select, readonly picker, and option-bearing choice evidence remains authoritative.',
      'An editable input combobox with no observed closed options can still be an open autocomplete field. Use a strong relayInputType such as email, tel, or password only when its value-free label/name/placeholder semantics support that type.',
      'fieldKey must be unique per target. When several controls project one concept, include the target role, for example date_of_birth_day, date_of_birth_month, and date_of_birth_year.',
      'Use ambiguous when protected-field meaning is uncertain; do not guess.',
      'Return low confidence when the coherent form purpose cannot be established.',
      'saveSuggestion.displayName is an editable value-free label for saving the coherent fields as one Memory item.',
    ],
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    ...(cleanText(input.purpose) ? { purpose: cleanText(input.purpose) } : {}),
    ...(cleanText(input.taskGoal) ? { taskGoal: cleanText(input.taskGoal) } : {}),
    ...(cleanStringArray(input.subjectHints).length > 0
      ? { subjectHints: cleanStringArray(input.subjectHints) }
      : {}),
    targets: input.targets.map((target) =>
      sanitizeTarget(target, optionGroupsByRef(input.targets).get(target.ref))
    ),
    expectedOutput: {
      contract:
        'Return purpose, confidence, subjectMode, saveSuggestion, and a fields array holding exactly one classification per target.',
      fields:
        'Each entry carries a targetRef taken verbatim from validTargetRefs. Classify every listed target exactly once: no target may be omitted, repeated, or invented.',
      validTargetRefs: input.targets.map((target) => target.ref),
    },
  });
}

function validateContractOutput(
  output: unknown,
  fingerprint: string,
  targets: readonly MagicBrowseSemanticTargetDescriptor[]
): CompileMagicBrowseFormContractResult {
  const root = asRecord(output);
  const contract = asRecord(root.contract);
  const confidence = cleanText(contract.confidence);
  if (confidence === 'low') {
    return { success: false, reason: 'low_confidence' };
  }
  if (confidence !== 'high' && confidence !== 'medium') {
    return { success: false, reason: 'invalid_model_output' };
  }

  const purpose = cleanText(contract.purpose);
  const subjectMode = cleanText(contract.subjectMode);
  const displayName = cleanText(asRecord(contract.saveSuggestion).displayName);
  if (!purpose || !displayName || !subjectMode || !SUBJECT_MODES.has(subjectMode as never)) {
    return { success: false, reason: 'invalid_model_output' };
  }

  const targetRefs = new Set(targets.map((target) => target.ref));
  const seen = new Set<string>();
  const fields: MagicBrowseFormFieldIntent[] = [];
  const classifications: MagicBrowseFormContractClassification[] = [];
  const rawFields = Array.isArray(contract.fields) ? contract.fields : [];
  // The array wire form cannot enforce coverage in the schema; every target
  // must still be classified exactly once (duplicates are rejected below).
  if (rawFields.length !== targets.length) {
    return { success: false, reason: 'invalid_model_output' };
  }

  for (const raw of rawFields) {
    const field = asRecord(raw);
    const targetRef = cleanText(field.targetRef);
    const relevance = cleanText(field.relevance);
    if (
      !targetRef ||
      !targetRefs.has(targetRef) ||
      seen.has(targetRef) ||
      !relevance ||
      !RELEVANCE.has(relevance as never)
    ) {
      return { success: false, reason: 'invalid_model_output' };
    }
    seen.add(targetRef);
    const target = targets.find((entry) => entry.ref === targetRef)!;
    if (!ACCEPTED_RELEVANCE.has(relevance as MagicBrowseFormFieldRelevance)) {
      classifications.push({
        targetRef,
        relevance: relevance as MagicBrowseFormFieldRelevance,
        ...(cleanText(field.reason) ? { reason: cleanText(field.reason) } : {}),
      });
      continue;
    }

    const fieldKey = cleanText(field.fieldKey);
    const label = cleanText(field.label);
    const semanticHint = cleanText(field.semanticHint);
    const sensitivity = cleanText(field.sensitivity);
    const rawRelayInputType = cleanText(field.relayInputType);
    if (
      !fieldKey ||
      !label ||
      !semanticHint ||
      !sensitivity ||
      !SENSITIVITY.has(sensitivity as never) ||
      (rawRelayInputType !== undefined && !RELAY_INPUT_TYPES.has(rawRelayInputType))
    ) {
      return { success: false, reason: 'invalid_model_output' };
    }
    const observedControl = trustedFormControl(target);
    const contractRelevance = trustedTargetRequired(target)
      ? 'task_required'
      : isGenericUntrustedToggle(target, observedControl)
        ? 'task_optional'
        : (relevance as 'task_required' | 'task_optional');
    classifications.push({
      targetRef,
      relevance: contractRelevance,
      ...(cleanText(field.reason) ? { reason: cleanText(field.reason) } : {}),
    });
    const openComboboxRelay = normalizedOpenComboboxRelayType(target, field, observedControl);
    const control = openComboboxRelay ? undefined : observedControl;
    const trustedInputType = normalizedRelayInputType(target, field, control, openComboboxRelay);
    fields.push({
      targetRef,
      fieldKey,
      label,
      semanticHint,
      ...(trustedInputType ? { inputType: trustedInputType } : {}),
      ...(control ? { control } : {}),
      sensitivity: sensitivity as MagicBrowseFormFieldSensitivity,
      required: contractRelevance === 'task_required',
      relevance: contractRelevance,
      ...(subjectMode === 'multiple' && cleanText(field.subjectRole)
        ? { subjectRole: cleanText(field.subjectRole) }
        : {}),
    });
  }

  if (seen.size !== targetRefs.size) {
    return { success: false, reason: 'invalid_model_output' };
  }
  if (fields.length === 0) {
    return { success: false, reason: 'no_task_relevant_fields', classifications };
  }

  return {
    success: true,
    contract: {
      id: `form_${stableContractToken(fingerprint)}`,
      fingerprint,
      purpose,
      confidence,
      subjectMode: subjectMode as MagicBrowseFormSubjectMode,
      fields,
      saveSuggestion: { displayName },
    },
    classifications,
  };
}

function isGenericUntrustedToggle(
  target: MagicBrowseSemanticTargetDescriptor,
  control: MagicBrowseFormControl | undefined
): boolean {
  if (control?.kind !== 'checkbox' && control?.kind !== 'toggle') {
    return false;
  }
  const label = cleanText(target.label) ?? cleanText(target.displayLabel);
  return Boolean(label && /^(?:tick|check|select)\s+(?:the\s+)?(?:box|checkbox)$/i.test(label));
}

function normalizedRelayInputType(
  target: MagicBrowseSemanticTargetDescriptor,
  field: RawRecord,
  control: MagicBrowseFormControl | undefined,
  openComboboxRelay?: string
): string | undefined {
  if (openComboboxRelay) {
    return openComboboxRelay;
  }
  if (control) {
    return control.kind;
  }

  const tagName = cleanText(target.tagName)?.toLowerCase();
  if (tagName === 'textarea') {
    return 'multiline';
  }

  const observed = cleanText(target.inputType)?.toLowerCase();
  const normalized = cleanText(field.relayInputType)?.toLowerCase();
  if (normalized && RELAY_INPUT_TYPES.has(normalized)) {
    // `text` and missing input types carry little UI meaning. Let the existing
    // value-free form compiler refine only their relay representation. Strong
    // native control types and browser-observed choice controls stay trusted.
    if (!observed || observed === 'text' || observed === 'search') {
      return normalized;
    }
  }

  return observed ?? cleanText(field.inputType);
}

function normalizedOpenComboboxRelayType(
  target: MagicBrowseSemanticTargetDescriptor,
  field: RawRecord,
  control: MagicBrowseFormControl | undefined
): string | undefined {
  const normalized = cleanText(field.relayInputType)?.toLowerCase();
  if (
    control?.kind !== 'select' ||
    !normalized ||
    !STRONG_OPEN_COMBOBOX_RELAY_TYPES.has(normalized) ||
    cleanText(target.tagName)?.toLowerCase() !== 'input' ||
    cleanText(target.role)?.toLowerCase() !== 'combobox' ||
    target.isReadonly === true ||
    (control.options?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const actions = new Set(cleanStringArray(target.allowedActions));
  if (!actions.has('fill') && !actions.has('type')) {
    return undefined;
  }
  // Field meaning is the model's call. The structural checks above (editable
  // input combobox, not readonly, no observed closed options) are the only
  // browser-observed authority here; the relay type itself is already bounded
  // by RELAY_INPUT_TYPES at validation.
  return normalized;
}

function trustedTargetRequired(target: MagicBrowseSemanticTargetDescriptor): boolean {
  const state = asRecord(asRecord(target.context).state);
  return (
    state.required === true ||
    state.ariaRequired === true ||
    state.ariaInvalid === true ||
    Boolean(cleanText(state.validationMessage)) ||
    Boolean(cleanText(state.submitFailureHint))
  );
}

/**
 * Find the mutually exclusive choices a page expresses as separate elements.
 *
 * Radios and option buttons sharing a control name are one question, not
 * several: buymeacoffee renders a coffee count as `1`, `3`, `5`, and sent
 * separately those describe nothing a matcher can reason about. It classified
 * each as a required detail the user had to supply, producing a request that
 * asked someone to type `1` into a field named `1` — and marked all three
 * required, which cannot be satisfied at all.
 *
 * Membership is read from the DOM, never guessed. What the group is for stays
 * with the matcher.
 */
function optionGroupsByRef(
  targets: readonly MagicBrowseSemanticTargetDescriptor[]
): Map<string, MagicBrowseTargetOptionGroup> {
  const membersByKey = new Map<string, MagicBrowseTargetOptionGroupMember[]>();

  for (const target of targets) {
    const key = cleanText(target.inputName);
    const controlKind = cleanControlKind(target.controlKind);
    if (!key || (controlKind !== 'radio' && controlKind !== 'checkbox')) {
      continue;
    }
    const members = membersByKey.get(key) ?? [];
    members.push({
      ref: target.ref,
      ...(cleanText(target.label ?? target.displayLabel)
        ? { label: cleanText(target.label ?? target.displayLabel) }
        : {}),
      ...(target.checked === true ? { selected: true } : {}),
    });
    membersByKey.set(key, members);
  }

  const groupsByRef = new Map<string, MagicBrowseTargetOptionGroup>();
  for (const [key, options] of membersByKey) {
    // A lone control is not a choice between anything.
    if (options.length < 2) {
      continue;
    }
    const group: MagicBrowseTargetOptionGroup = { key, options };
    for (const option of options) {
      groupsByRef.set(option.ref, group);
    }
  }

  return groupsByRef;
}

function sanitizeTarget(
  target: MagicBrowseSemanticTargetDescriptor,
  optionGroup?: MagicBrowseTargetOptionGroup
): MagicBrowseSemanticTargetDescriptor {
  return {
    ref: target.ref,
    ...(optionGroup ? { optionGroup } : {}),
    ...(target.index !== undefined ? { index: target.index } : {}),
    ...(target.selectorMapIndex !== undefined ? { selectorMapIndex: target.selectorMapIndex } : {}),
    ...(cleanText(target.pageRef) ? { pageRef: cleanText(target.pageRef) } : {}),
    ...(cleanText(target.kind) ? { kind: cleanText(target.kind) } : {}),
    ...(cleanText(target.tagName) ? { tagName: cleanText(target.tagName) } : {}),
    ...(cleanText(target.role) ? { role: cleanText(target.role) } : {}),
    ...(cleanText(target.label) ? { label: cleanText(target.label) } : {}),
    ...(cleanText(target.displayLabel) ? { displayLabel: cleanText(target.displayLabel) } : {}),
    ...(cleanText(target.text) ? { text: cleanText(target.text) } : {}),
    ...(cleanText(target.placeholder) ? { placeholder: cleanText(target.placeholder) } : {}),
    ...(cleanText(target.inputName) ? { inputName: cleanText(target.inputName) } : {}),
    ...(cleanText(target.inputType) ? { inputType: cleanText(target.inputType) } : {}),
    ...(cleanText(target.autocomplete) ? { autocomplete: cleanText(target.autocomplete) } : {}),
    ...(target.isReadonly === true ? { isReadonly: true } : {}),
    ...(target.popupBacked === true ? { popupBacked: true } : {}),
    ...(cleanControlKind(target.controlKind)
      ? { controlKind: cleanControlKind(target.controlKind) }
      : {}),
    ...(cleanStringArray(target.allowedActions).length > 0
      ? { allowedActions: cleanStringArray(target.allowedActions) }
      : {}),
    ...(cleanText(target.host) ? { host: cleanText(target.host) } : {}),
    ...(sanitizeFormTargetContext(target.context)
      ? { context: sanitizeFormTargetContext(target.context) }
      : {}),
  };
}

function trustedFormControl(
  target: MagicBrowseSemanticTargetDescriptor
): MagicBrowseFormControl | undefined {
  const kind =
    cleanControlKind(target.controlKind) ??
    cleanControlKind(target.inputType) ??
    (target.kind === 'select' || target.kind === 'select-like' ? 'select' : undefined);
  if (!kind) {
    return undefined;
  }
  const options =
    kind === 'select' || kind === 'radio' ? sanitizedControlOptions(target.options) : [];
  return {
    kind,
    ...(options.length > 0 ? { options } : {}),
    persistable: kind !== 'checkbox' && kind !== 'toggle',
  };
}

function cleanControlKind(value: unknown): MagicBrowseFormControl['kind'] | undefined {
  return value === 'select' || value === 'radio' || value === 'checkbox' || value === 'toggle'
    ? value
    : undefined;
}

function sanitizedControlOptions(value: unknown): MagicBrowseFormControlOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  return value.slice(0, MAX_CONTROL_OPTIONS).flatMap((entry) => {
    const option = asRecord(entry);
    const optionValue = cleanText(option.value);
    const label = cleanText(option.text) ?? cleanText(option.label);
    if (!optionValue || !label) {
      return [];
    }
    const key = JSON.stringify([optionValue, label]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        value: optionValue,
        label,
        ...(option.disabled === true ? { disabled: true } : {}),
      },
    ];
  });
}

function sanitizeFormTargetContext(value: unknown): RawRecord | undefined {
  const context = asRecord(value);
  const form = asRecord(context.form);
  const fieldset = asRecord(context.fieldset);
  const section = asRecord(context.section);
  const state = asRecord(context.state);
  const errorSummary = asRecord(context.errorSummary);
  const sanitized: RawRecord = {
    ...(Object.keys(form).length > 0
      ? {
          form: compactRecord({
            tagName: cleanText(form.tagName),
            label: cleanText(form.label),
          }),
        }
      : {}),
    ...(Object.keys(fieldset).length > 0
      ? { fieldset: compactRecord({ label: cleanText(fieldset.label) }) }
      : {}),
    ...(Object.keys(section).length > 0
      ? { section: compactRecord({ label: cleanText(section.label) }) }
      : {}),
    ...(Object.keys(state).length > 0
      ? {
          state: compactRecord({
            required: cleanBoolean(state.required),
            ariaRequired: cleanBoolean(state.ariaRequired),
            ariaInvalid: cleanBoolean(state.ariaInvalid),
            taskRelevance: cleanText(state.taskRelevance),
            visibleRequiredText: cleanText(state.visibleRequiredText),
            validationMessage: cleanText(state.validationMessage),
            submitFailureHint: cleanText(state.submitFailureHint),
            withinActiveModal: cleanBoolean(state.withinActiveModal),
            withinEmbeddedFrame: cleanBoolean(state.withinEmbeddedFrame),
          }),
        }
      : {}),
    ...(Object.keys(errorSummary).length > 0
      ? { errorSummary: compactRecord({ text: cleanText(errorSummary.text) }) }
      : {}),
  };
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function compactRecord(record: RawRecord): RawRecord {
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => entry !== undefined));
}

function cleanBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function sanitizePage(page: MagicBrowseSemanticPageContext): MagicBrowseSemanticPageContext {
  return {
    ...(cleanText(page.url) ? { url: cleanText(page.url) } : {}),
    ...(cleanText(page.title) ? { title: cleanText(page.title) } : {}),
    ...(cleanText(page.host) ? { host: cleanText(page.host) } : {}),
  };
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (cleanText(entry) ? [cleanText(entry)!] : []))
    : [];
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRecord) : {};
}

function stableContractToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
