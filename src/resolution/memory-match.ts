import type { MagicBrowseFillableTargetDescriptor } from "../types.js";

export type MemoryTargetDescriptor = MagicBrowseFillableTargetDescriptor;

export interface MemoryDescriptorAvailability {
  readonly status?: string;
}

export interface MemoryFieldDescriptor {
  readonly fieldRef: string;
  readonly fieldName: string;
  readonly itemName?: string;
  readonly hint?: string;
  readonly matcherDescriptor: string;
  readonly isSecret?: boolean;
  readonly providerManaged?: boolean;
  readonly subjectRole?: string;
  readonly availability?: MemoryDescriptorAvailability;
  readonly projectionHints?: readonly string[];
}

export interface MemoryDescriptorMatcherRequest {
  readonly task: "memoryDescriptorMatching";
  readonly matcherModel: "fast";
  readonly host?: string;
  readonly page?: {
    readonly url?: string;
    readonly title?: string;
    readonly host?: string;
  };
  readonly taskPurpose?: Record<string, unknown>;
  readonly plannerSignals?: Record<string, unknown>;
  readonly targets: readonly MemorySafeTargetDescriptor[];
  readonly target?: MemorySafeTargetDescriptor;
  readonly descriptors: readonly MemorySafeFieldDescriptor[];
  readonly prompt: string;
}

export interface MemoryDescriptorMatcherModel {
  decide(request: MemoryDescriptorMatcherRequest): Promise<unknown>;
}

export type MemoryMatchNoMatchReason =
  | "low_confidence"
  | "incompatible_shape"
  | "scope_ineligible"
  | "matcher_unavailable";

export type MemoryMatchInvalidReason =
  | "invalid_model_output"
  | "unknown_field_ref"
  | "invalid_projection_hint";

export type MatchMemoryTargetResult =
  | {
      readonly status: "matched";
      readonly targetRef: string;
      readonly fieldRef: string;
      readonly fieldName: string;
      readonly confidence: "high" | "medium";
      readonly projectionHint?: string;
    }
  | {
      readonly status: "ambiguous";
      readonly targetRef: string;
      readonly fieldRefs: readonly string[];
    }
  | {
      readonly status: "no_match";
      readonly targetRef: string;
      readonly reason: MemoryMatchNoMatchReason;
    }
  | {
      readonly status: "invalid_model_output";
      readonly targetRef: string;
      readonly reason: MemoryMatchInvalidReason;
    };

export type MatchMemoryTargetsResult = readonly MatchMemoryTargetResult[];

export interface MatchMemoryTargetsInput {
  readonly targets: readonly MemoryTargetDescriptor[];
  readonly descriptors: readonly MemoryFieldDescriptor[];
  readonly host?: string;
  readonly page?: {
    readonly url?: string;
    readonly title?: string;
    readonly host?: string;
  };
  readonly taskPurpose?: Record<string, unknown>;
  readonly plannerSignals?: Record<string, unknown>;
  readonly model: MemoryDescriptorMatcherModel;
}

export interface MemorySafeTargetDescriptor {
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

export interface MemorySafeFieldDescriptor {
  readonly fieldRef: string;
  readonly fieldName: string;
  readonly itemName?: string;
  readonly hint?: string;
  readonly matcherDescriptor?: string;
  readonly isSecret?: boolean;
  readonly providerManaged?: boolean;
  readonly subjectRole?: string;
  readonly projectionHints?: readonly string[];
}

type RawRecord = Record<string, unknown>;

const MODEL_STATUSES = new Set(["matched", "ambiguous", "no_match"]);
const ELIGIBLE_AVAILABILITY_STATUSES = new Set([
  undefined,
  "",
  "ready",
  "available",
  "current",
]);
const MAX_TARGET_TEXT_CHARS = 160;

export async function matchMemoryTargets(
  input: MatchMemoryTargetsInput,
): Promise<MatchMemoryTargetsResult> {
  const safeTargets = input.targets.map((target) =>
    sanitizeTarget(target, {
      pageHost: input.page?.host ?? input.host,
    }),
  );
  const eligibleDescriptors = input.descriptors.filter(isDescriptorEligible);
  if (eligibleDescriptors.length === 0) {
    const reason =
      input.descriptors.length > 0 ? "scope_ineligible" : "low_confidence";
    return input.targets.map((target) => noMatch(target.ref, reason));
  }

  const safeDescriptors = eligibleDescriptors.map(sanitizeDescriptor);
  const request: MemoryDescriptorMatcherRequest = {
    task: "memoryDescriptorMatching",
    matcherModel: "fast",
    ...(input.host ? { host: input.host } : {}),
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    ...(input.taskPurpose ? { taskPurpose: input.taskPurpose } : {}),
    ...(input.plannerSignals ? { plannerSignals: input.plannerSignals } : {}),
    targets: safeTargets,
    ...(safeTargets.length === 1 ? { target: safeTargets[0] } : {}),
    descriptors: safeDescriptors,
    prompt: buildMemoryMatchPrompt({
      targets: safeTargets,
      descriptors: safeDescriptors,
      host: input.host,
      page: input.page,
      taskPurpose: input.taskPurpose,
      plannerSignals: input.plannerSignals,
    }),
  };

  let modelOutput: unknown;
  try {
    modelOutput = await input.model.decide(request);
  } catch {
    return input.targets.map((target) =>
      noMatch(target.ref, "matcher_unavailable"),
    );
  }

  return validateMemoryMatcherOutput(modelOutput, {
    targets: input.targets,
    descriptors: eligibleDescriptors,
  });
}

export function buildMemoryMatchPrompt(input: {
  readonly targets: readonly MemorySafeTargetDescriptor[];
  readonly descriptors: readonly MemorySafeFieldDescriptor[];
  readonly host?: string;
  readonly page?: MatchMemoryTargetsInput["page"];
  readonly taskPurpose?: Record<string, unknown>;
  readonly plannerSignals?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    task: "memoryDescriptorMatching",
    matcherModel: "fast",
    instructions: [
      "Match visible browser fields to allowed Memory descriptors by semantic meaning.",
      "Use only provided targetRef and fieldRef values.",
      "Use fieldName, itemName, optional non-empty hint, page context, and target labels as matching evidence.",
      "Do not infer from fieldName alone when target signals disagree.",
      "Consider required and aria-required signals, validation message text, error summary text, submit failure hints, and task purpose.",
      "Do not invent fields, descriptors, values, targets, or hints.",
      "Return no_match or low confidence when the descriptor meaning does not clearly fit.",
      "A broad, aggregate, adjacent, or merely similar descriptor must not satisfy a narrower target.",
      "Use every available target signal: label, displayLabel, text, placeholder, inputName, inputType, autocomplete, role, tagName, and context.",
      "Optional newsletter or marketing targets may be no_match when the task purpose does not require them.",
      "isSecret and providerManaged are safety metadata only; those descriptors remain eligible when their value-free field facts fit the target.",
      "Do not return no_match only because a descriptor is secret, provider-managed, or lacks a raw value; card number and card security code descriptors can match card number and CVC targets value-free.",
      "Descriptors are value-free. Raw values, value handles, policy internals, trust rules, and backend-only data are not provided.",
      "Return compact output only: do not echo field names, field keys, field types, raw values, value handles, policy internals, explanations, or unused empty fields.",
    ],
    ...(input.host ? { host: input.host } : {}),
    ...(input.page ? { page: sanitizePage(input.page) } : {}),
    ...(input.taskPurpose ? { taskPurpose: input.taskPurpose } : {}),
    ...(input.plannerSignals ? { plannerSignals: input.plannerSignals } : {}),
    targets: input.targets,
    descriptors: input.descriptors,
    expectedOutput: {
      matches:
        "Return matches[{targetRef,fieldRef,confidence,projectionHint?}], ambiguous[{targetRef,fieldRefs}], and noMatches[{targetRef,reason?}].",
    },
  });
}

function validateMemoryMatcherOutput(
  output: unknown,
  context: {
    readonly targets: readonly MemoryTargetDescriptor[];
    readonly descriptors: readonly MemoryFieldDescriptor[];
  },
): MatchMemoryTargetsResult {
  const raw = asRecord(output);
  if (!raw) {
    return context.targets.map((target) =>
      invalid(target.ref, "invalid_model_output"),
    );
  }

  const descriptorByRef = new Map(
    context.descriptors.map((descriptor) => [descriptor.fieldRef, descriptor]),
  );
  const rawEntries = readRawEntries(raw);
  if (rawEntries.length === 0) {
    return context.targets.map((target) =>
      invalid(target.ref, "invalid_model_output"),
    );
  }

  return context.targets.map((target) =>
    validateMemoryEntry(readEntryForTarget(rawEntries, target.ref), {
      target,
      descriptorByRef,
    }),
  );
}

function validateMemoryEntry(
  raw: RawRecord | undefined,
  context: {
    readonly target: MemoryTargetDescriptor;
    readonly descriptorByRef: ReadonlyMap<string, MemoryFieldDescriptor>;
  },
): MatchMemoryTargetResult {
  if (!raw) {
    return noMatch(context.target.ref, "low_confidence");
  }
  if (raw.targetRef !== context.target.ref) {
    return invalid(context.target.ref, "invalid_model_output");
  }
  if (typeof raw.status !== "string" || !MODEL_STATUSES.has(raw.status)) {
    return invalid(context.target.ref, "invalid_model_output");
  }

  if (raw.status === "no_match") {
    return noMatch(context.target.ref, readNoMatchReason(raw.reason));
  }
  if (raw.status === "ambiguous") {
    return validateAmbiguousMemoryEntry(raw, context);
  }

  if (raw.confidence === "low") {
    return noMatch(context.target.ref, "low_confidence");
  }
  if (raw.confidence !== "high" && raw.confidence !== "medium") {
    return invalid(context.target.ref, "invalid_model_output");
  }
  if (typeof raw.fieldRef !== "string" || raw.fieldRef.trim().length === 0) {
    return invalid(context.target.ref, "invalid_model_output");
  }
  const descriptor = context.descriptorByRef.get(raw.fieldRef);
  if (!descriptor) {
    return invalid(context.target.ref, "unknown_field_ref");
  }
  if (
    typeof raw.fieldName === "string" &&
    raw.fieldName !== descriptor.fieldName
  ) {
    return invalid(context.target.ref, "invalid_model_output");
  }

  const projectionHint = readProjectionHint(raw.projectionHint, descriptor);
  if (projectionHint === false) {
    return invalid(context.target.ref, "invalid_projection_hint");
  }

  return {
    status: "matched",
    targetRef: context.target.ref,
    fieldRef: descriptor.fieldRef,
    fieldName: descriptor.fieldName,
    confidence: raw.confidence,
    ...(projectionHint ? { projectionHint } : {}),
  };
}

function validateAmbiguousMemoryEntry(
  raw: RawRecord,
  context: {
    readonly target: MemoryTargetDescriptor;
    readonly descriptorByRef: ReadonlyMap<string, MemoryFieldDescriptor>;
  },
): MatchMemoryTargetResult {
  if (
    !Array.isArray(raw.fieldRefs) ||
    raw.fieldRefs.length === 0 ||
    !raw.fieldRefs.every((fieldRef) => typeof fieldRef === "string")
  ) {
    return invalid(context.target.ref, "invalid_model_output");
  }

  const fieldRefs = raw.fieldRefs as string[];
  for (const fieldRef of fieldRefs) {
    const descriptor = context.descriptorByRef.get(fieldRef);
    if (!descriptor) {
      return invalid(context.target.ref, "unknown_field_ref");
    }
  }

  return {
    status: "ambiguous",
    targetRef: context.target.ref,
    fieldRefs,
  };
}

function readRawEntries(raw: RawRecord): RawRecord[] {
  if (typeof raw.status === "string" && MODEL_STATUSES.has(raw.status)) {
    return [raw];
  }

  const matchedEntries = normalizeRawEntries(raw.matches, "matched");
  const ambiguousEntries = normalizeRawEntries(raw.ambiguous, "ambiguous");
  const noMatchEntries = normalizeRawEntries(raw.noMatches, "no_match");
  return [...matchedEntries, ...ambiguousEntries, ...noMatchEntries];
}

function normalizeRawEntries(
  value: unknown,
  compactStatus: "matched" | "ambiguous" | "no_match",
): RawRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is RawRecord => entry !== undefined)
    .map((entry) =>
      typeof entry.status === "string"
        ? entry
        : {
            ...entry,
            status: compactStatus,
          },
    );
}

function readEntryForTarget(
  entries: readonly RawRecord[],
  targetRef: string,
): RawRecord | undefined {
  if (entries.length === 1 && entries[0]?.targetRef !== targetRef) {
    return entries[0];
  }
  return entries.find((entry) => entry.targetRef === targetRef);
}

function sanitizeTarget(
  target: MemoryTargetDescriptor,
  options: { readonly pageHost?: string } = {},
): MemorySafeTargetDescriptor {
  return omitUndefined({
    ref: target.ref,
    index:
      target.index !== undefined && target.index !== target.selectorMapIndex
        ? target.index
        : undefined,
    selectorMapIndex: target.selectorMapIndex,
    pageRef: target.pageRef,
    kind: target.kind,
    tagName: target.tagName,
    role: target.role,
    label: target.label,
    displayLabel:
      target.displayLabel && target.displayLabel !== target.label
        ? target.displayLabel
        : undefined,
    text: readString(target.text, MAX_TARGET_TEXT_CHARS),
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    isReadonly: target.isReadonly === true ? true : undefined,
    popupBacked: target.popupBacked === true ? true : undefined,
    host:
      target.host && target.host !== options.pageHost ? target.host : undefined,
    context: sanitizeTargetContext(target.context, target),
  });
}

function sanitizeTargetContext(
  context: unknown,
  target: MemoryTargetDescriptor,
): unknown {
  const record = asRecord(context);
  if (!record) {
    return undefined;
  }

  const form = asRecord(record.form);
  const state = asRecord(record.state);
  const selector = asRecord(record.selector);
  const fieldset = asRecord(record.fieldset);
  const section = asRecord(record.section);
  const errorSummary = asRecord(record.errorSummary);

  return omitUndefined({
    ...(form
      ? {
          form: omitUndefined({
            tagName:
              readString(form.tagName) === "form"
                ? undefined
                : readString(form.tagName),
            id: readString(form.id),
            name: readString(form.name),
            label: readString(form.label),
          }),
        }
      : {}),
    ...(state
      ? {
          state: omitUndefined({
            readonly: state.readonly === true ? true : undefined,
            disabled: state.disabled === true ? true : undefined,
            required: state.required === true ? true : undefined,
            ariaInvalid: state.ariaInvalid === true ? true : undefined,
            ariaRequired: state.ariaRequired === true ? true : undefined,
            popupBacked: state.popupBacked === true ? true : undefined,
            validationMessage: readString(state.validationMessage),
            visibleRequiredText: readString(state.visibleRequiredText),
            submitFailureHint: readString(state.submitFailureHint),
            taskRelevance: readString(state.taskRelevance),
          }),
        }
      : {}),
    ...(selector
      ? {
          selector: omitUndefined({
            id: readString(selector.id),
            name:
              readString(selector.name) === target.inputName
                ? undefined
                : readString(selector.name),
            role: readString(selector.role),
          }),
        }
      : {}),
    ...(fieldset
      ? {
          fieldset: omitUndefined({
            label: readString(fieldset.label),
          }),
        }
      : {}),
    ...(section
      ? {
          section: omitUndefined({
            label: readString(section.label),
          }),
        }
      : {}),
    ...(errorSummary
      ? {
          errorSummary: omitUndefined({
            text: readString(errorSummary.text),
          }),
        }
      : {}),
  });
}

function sanitizeDescriptor(
  descriptor: MemoryFieldDescriptor,
): MemorySafeFieldDescriptor {
  const itemName = readString(descriptor.itemName);
  const hint = readString(descriptor.hint);
  const matcherDescriptor = readMatcherDescriptor(descriptor, itemName, hint);
  const subjectRole = readString(descriptor.subjectRole);
  const projectionHints = descriptor.projectionHints?.filter(
    (entry): entry is string => readString(entry) !== undefined,
  );

  return {
    fieldRef: descriptor.fieldRef,
    fieldName: descriptor.fieldName,
    ...(itemName ? { itemName } : {}),
    ...(hint ? { hint } : {}),
    ...(matcherDescriptor ? { matcherDescriptor } : {}),
    ...(descriptor.isSecret === true ? { isSecret: true } : {}),
    ...(descriptor.providerManaged === true ? { providerManaged: true } : {}),
    ...(subjectRole ? { subjectRole } : {}),
    ...(projectionHints && projectionHints.length > 0
      ? { projectionHints }
      : {}),
  };
}

function sanitizePage(page: NonNullable<MatchMemoryTargetsInput["page"]>) {
  return {
    ...(page.url ? { url: page.url } : {}),
    ...(page.title ? { title: page.title } : {}),
    ...(page.host ? { host: page.host } : {}),
  };
}

function isDescriptorEligible(descriptor: MemoryFieldDescriptor): boolean {
  return ELIGIBLE_AVAILABILITY_STATUSES.has(descriptor.availability?.status);
}

function readMatcherDescriptor(
  descriptor: MemoryFieldDescriptor,
  itemName: string | undefined,
  hint: string | undefined,
): string | undefined {
  const matcherDescriptor = readString(descriptor.matcherDescriptor);
  if (!matcherDescriptor || matcherDescriptor === descriptor.fieldName) {
    return undefined;
  }
  const synthesized = [itemName, descriptor.fieldName, hint]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return matcherDescriptor === synthesized ? undefined : matcherDescriptor;
}

function readProjectionHint(
  value: unknown,
  descriptor: MemoryFieldDescriptor,
): string | undefined | false {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    return false;
  }
  return descriptor.projectionHints?.includes(value) === true ? value : false;
}

function readNoMatchReason(value: unknown): MemoryMatchNoMatchReason {
  switch (value) {
    case "incompatible_shape":
    case "scope_ineligible":
      return value;
    default:
      return "low_confidence";
  }
}

function noMatch(
  targetRef: string,
  reason: MemoryMatchNoMatchReason,
): MatchMemoryTargetResult {
  return {
    status: "no_match",
    targetRef,
    reason,
  };
}

function invalid(
  targetRef: string,
  reason: MemoryMatchInvalidReason,
): MatchMemoryTargetResult {
  return {
    status: "invalid_model_output",
    targetRef,
    reason,
  };
}

function asRecord(value: unknown): RawRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as RawRecord;
}

function readString(value: unknown, maxLength?: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? truncateString(value, maxLength)
    : undefined;
}

function truncateString(value: string, maxLength?: number): string {
  if (maxLength === undefined || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined) {
        return false;
      }
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === 0
      ) {
        return false;
      }
      return true;
    }),
  ) as T;
}
