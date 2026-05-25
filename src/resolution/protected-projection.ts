import type {
  MagicBrowseMatchGroupField,
  MagicBrowseProtectedBindingValueHint,
} from './match.js';

export type MagicBrowseProtectedDateProjectionErrorReason =
  | 'ambiguous_date_value'
  | 'incomplete_date_value'
  | 'invalid_date_value';

export type MagicBrowseProtectedProjectionErrorReason =
  | MagicBrowseProtectedDateProjectionErrorReason
  | 'missing_protected_value'
  | 'deterministic_only_resolution_failed'
  | 'unsupported_value_hint'
  | 'unsupported_protected_field_group'
  | 'invalid_expiry_value'
  | 'target_missing';

export type MagicBrowseProtectedDateProjectionResult =
  | {
      readonly kind: 'normalized';
      readonly iso: string;
      readonly year: string;
      readonly month: string;
      readonly day: string;
    }
  | {
      readonly kind: 'error';
      readonly reason: MagicBrowseProtectedDateProjectionErrorReason;
    }
  | {
      readonly kind: 'not_date_like';
    };

export type MagicBrowseProtectedProjectionResult =
  | {
      readonly kind: 'value';
      readonly value: string;
    }
  | {
      readonly kind: 'error';
      readonly reason: MagicBrowseProtectedProjectionErrorReason;
    };

export interface MagicBrowseProtectedProjectionTargetContext {
  readonly hintText?: string;
}

export interface MagicBrowseProtectedProjectionTarget {
  readonly targetRef: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly context?: MagicBrowseProtectedProjectionTargetContext;
}

export interface ProjectProtectedBindingValueInput {
  readonly field: Pick<MagicBrowseMatchGroupField, 'fieldKey' | 'targetRef' | 'valueHint'>;
  readonly protectedValues: Readonly<Record<string, string | undefined>>;
  readonly target?: MagicBrowseProtectedProjectionTarget;
}

export interface ProjectProtectedFillOperationsInput {
  readonly fields: readonly MagicBrowseMatchGroupField[];
  readonly targets: readonly MagicBrowseProtectedProjectionTarget[];
  readonly protectedValues: Readonly<Record<string, string | undefined>>;
}

export interface MagicBrowseProtectedProjectionOperation {
  readonly targetRef: string;
  readonly target: MagicBrowseProtectedProjectionTarget;
  readonly value: string;
  readonly fields: readonly MagicBrowseMatchGroupField[];
}

export type ProjectProtectedFillOperationsResult =
  | {
      readonly status: 'ready';
      readonly operations: readonly MagicBrowseProtectedProjectionOperation[];
    }
  | {
      readonly status: 'blocked';
      readonly reason: MagicBrowseProtectedProjectionErrorReason;
      readonly targetRef?: string;
      readonly fieldKey?: string;
    };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_FIRST_DATE_RE = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/;
const DAY_OR_MONTH_FIRST_DATE_RE = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/;
const PARTIAL_DATE_RE = /^(?:\d{4}[./-]\d{1,2}|\d{1,2}[./-](?:\d{2}|\d{4}))$/;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function normalizeProtectedDateValue(value: string): MagicBrowseProtectedDateProjectionResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'not_date_like',
    };
  }

  const isoMatch = trimmed.match(ISO_DATE_RE);
  if (isoMatch) {
    return buildNormalizedDateValue(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const yearFirstMatch = trimmed.match(YEAR_FIRST_DATE_RE);
  if (yearFirstMatch) {
    return buildNormalizedDateValue(
      Number(yearFirstMatch[1]),
      Number(yearFirstMatch[2]),
      Number(yearFirstMatch[3])
    );
  }

  const dayOrMonthFirstMatch = trimmed.match(DAY_OR_MONTH_FIRST_DATE_RE);
  if (dayOrMonthFirstMatch) {
    const first = Number(dayOrMonthFirstMatch[1]);
    const second = Number(dayOrMonthFirstMatch[2]);
    const year = Number(dayOrMonthFirstMatch[3]);
    const dayFirstCandidate = first >= 1 && first <= 31 && second >= 1 && second <= 12;
    const monthFirstCandidate = first >= 1 && first <= 12 && second >= 1 && second <= 31;

    if (dayFirstCandidate && monthFirstCandidate) {
      const dayFirst = buildNormalizedDateValue(year, second, first);
      const monthFirst = buildNormalizedDateValue(year, first, second);

      if (dayFirst.kind === 'normalized' && monthFirst.kind === 'normalized') {
        return dayFirst.iso === monthFirst.iso
          ? dayFirst
          : {
              kind: 'error',
              reason: 'ambiguous_date_value',
            };
      }
      if (dayFirst.kind === 'normalized') {
        return dayFirst;
      }
      if (monthFirst.kind === 'normalized') {
        return monthFirst;
      }
      return {
        kind: 'error',
        reason: 'invalid_date_value',
      };
    }

    if (dayFirstCandidate) {
      return buildNormalizedDateValue(year, second, first);
    }
    if (monthFirstCandidate) {
      return buildNormalizedDateValue(year, first, second);
    }
    return {
      kind: 'error',
      reason: 'invalid_date_value',
    };
  }

  if (PARTIAL_DATE_RE.test(trimmed)) {
    return {
      kind: 'error',
      reason: 'incomplete_date_value',
    };
  }

  const separatorCount = trimmed.split(/[./-]/).length - 1;
  if (separatorCount >= 2 && /\d/.test(trimmed)) {
    return {
      kind: 'error',
      reason: 'invalid_date_value',
    };
  }

  return {
    kind: 'not_date_like',
  };
}

export function projectProtectedBindingValue(
  input: ProjectProtectedBindingValueInput
): MagicBrowseProtectedProjectionResult {
  const valueHint = input.field.valueHint ?? 'direct';

  if (input.field.fieldKey === 'date_of_birth') {
    return projectDateOfBirth(input.protectedValues.date_of_birth, valueHint, input.target);
  }

  if (input.field.fieldKey === 'full_name') {
    return projectFullName(input.protectedValues.full_name, valueHint);
  }

  if (valueHint !== 'direct') {
    return {
      kind: 'error',
      reason: 'unsupported_value_hint',
    };
  }

  const value = directProtectedValue(input.protectedValues, input.field.fieldKey);
  return value
    ? {
        kind: 'value',
        value,
      }
    : {
        kind: 'error',
        reason: 'missing_protected_value',
      };
}

export function projectProtectedFillOperations(
  input: ProjectProtectedFillOperationsInput
): ProjectProtectedFillOperationsResult {
  const targetByRef = new Map(input.targets.map((target) => [target.targetRef, target]));
  const groupedFields = groupFieldsByTarget(input.fields);
  const operations: Array<MagicBrowseProtectedProjectionOperation & { readonly order: number }> = [];

  for (const group of groupedFields) {
    const target = targetByRef.get(group.targetRef);
    if (!target) {
      return {
        status: 'blocked',
        reason: 'target_missing',
        targetRef: group.targetRef,
        fieldKey: group.fields[0]?.fieldKey,
      };
    }

    const cardExpiry = projectCardExpiry(group.fields, input.protectedValues);
    if (cardExpiry.status === 'ready') {
      operations.push({
        targetRef: group.targetRef,
        target,
        value: cardExpiry.value,
        fields: group.fields,
        order: projectionOrder(group.fields, group.ordinal),
      });
      continue;
    }
    if (cardExpiry.status === 'blocked') {
      return {
        status: 'blocked',
        reason: cardExpiry.reason,
        targetRef: group.targetRef,
        fieldKey: cardExpiry.fieldKey,
      };
    }

    if (group.fields.length !== 1) {
      return {
        status: 'blocked',
        reason: 'unsupported_protected_field_group',
        targetRef: group.targetRef,
        fieldKey: group.fields[0]?.fieldKey,
      };
    }

    const field = group.fields[0]!;
    const projection = projectProtectedBindingValue({
      field,
      protectedValues: input.protectedValues,
      target,
    });
    if (projection.kind === 'error') {
      return {
        status: 'blocked',
        reason: projection.reason,
        targetRef: group.targetRef,
        fieldKey: field.fieldKey,
      };
    }

    operations.push({
      targetRef: group.targetRef,
      target,
      value: projection.value,
      fields: group.fields,
      order: projectionOrder(group.fields, group.ordinal),
    });
  }

  return {
    status: 'ready',
    operations: operations
      .sort((left, right) => left.order - right.order)
      .map(({ order: _order, ...operation }) => operation),
  };
}

function projectDateOfBirth(
  value: string | undefined,
  valueHint: MagicBrowseProtectedBindingValueHint,
  target: MagicBrowseProtectedProjectionTarget | undefined
): MagicBrowseProtectedProjectionResult {
  if (!value || value.trim().length === 0) {
    return {
      kind: 'error',
      reason: 'missing_protected_value',
    };
  }

  const normalized = normalizeProtectedDateValue(value);
  if (normalized.kind === 'error') {
    return normalized;
  }
  if (normalized.kind === 'not_date_like') {
    return {
      kind: 'error',
      reason: 'invalid_date_value',
    };
  }

  if (valueHint === 'direct') {
    return {
      kind: 'value',
      value: normalized.iso,
    };
  }
  if (valueHint === 'date_of_birth.day') {
    return {
      kind: 'value',
      value: normalized.day,
    };
  }
  if (valueHint === 'date_of_birth.month') {
    return {
      kind: 'value',
      value: projectMonthValue(normalized.month, target),
    };
  }
  if (valueHint === 'date_of_birth.year') {
    return {
      kind: 'value',
      value: normalized.year,
    };
  }

  return {
    kind: 'error',
    reason: 'unsupported_value_hint',
  };
}

function projectFullName(
  value: string | undefined,
  valueHint: MagicBrowseProtectedBindingValueHint
): MagicBrowseProtectedProjectionResult {
  const fullName = normalizeWhitespace(value ?? '');
  if (fullName.length === 0) {
    return {
      kind: 'error',
      reason: 'missing_protected_value',
    };
  }

  if (valueHint === 'direct') {
    return {
      kind: 'value',
      value: fullName,
    };
  }

  const parts = fullName.split(' ').filter(Boolean);
  if (valueHint === 'full_name.given') {
    return {
      kind: 'value',
      value: parts[0] ?? fullName,
    };
  }
  if (valueHint === 'full_name.family') {
    return {
      kind: 'value',
      value: parts.at(-1) ?? fullName,
    };
  }

  return {
    kind: 'error',
    reason: 'unsupported_value_hint',
  };
}

function projectCardExpiry(
  fields: readonly MagicBrowseMatchGroupField[],
  protectedValues: Readonly<Record<string, string | undefined>>
):
  | {
      readonly status: 'ready';
      readonly value: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: MagicBrowseProtectedProjectionErrorReason;
      readonly fieldKey?: string;
    }
  | {
      readonly status: 'not_expiry';
    } {
  if (fields.length !== 2) {
    return {
      status: 'not_expiry',
    };
  }

  const fieldKeys = new Set(fields.map((field) => field.fieldKey));
  if (!fieldKeys.has('exp_month') || !fieldKeys.has('exp_year')) {
    return {
      status: 'not_expiry',
    };
  }

  if (fields.some((field) => (field.valueHint ?? 'direct') !== 'direct')) {
    return {
      status: 'blocked',
      reason: 'unsupported_value_hint',
      fieldKey: fields.find((field) => (field.valueHint ?? 'direct') !== 'direct')?.fieldKey,
    };
  }

  const month = directProtectedValue(protectedValues, 'exp_month');
  const year = directProtectedValue(protectedValues, 'exp_year');
  if (!month) {
    return {
      status: 'blocked',
      reason: 'missing_protected_value',
      fieldKey: 'exp_month',
    };
  }
  if (!year) {
    return {
      status: 'blocked',
      reason: 'missing_protected_value',
      fieldKey: 'exp_year',
    };
  }

  const value = formatCardExpiry(month, year);
  return value
    ? {
        status: 'ready',
        value,
      }
    : {
        status: 'blocked',
        reason: 'invalid_expiry_value',
        fieldKey: 'exp_month',
      };
}

function formatCardExpiry(month: string, year: string): string | undefined {
  const monthNumber = Number(month.trim());
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    return undefined;
  }

  const trimmedYear = year.trim();
  if (!/^\d{2}$|^\d{4}$/.test(trimmedYear)) {
    return undefined;
  }

  const normalizedMonth = String(monthNumber).padStart(2, '0');
  const shortYear =
    trimmedYear.length > 2 ? trimmedYear.slice(-2) : trimmedYear.padStart(2, '0');
  return `${normalizedMonth}/${shortYear}`;
}

function buildNormalizedDateValue(
  year: number,
  month: number,
  day: number
): MagicBrowseProtectedDateProjectionResult {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return {
      kind: 'error',
      reason: 'invalid_date_value',
    };
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return {
      kind: 'error',
      reason: 'invalid_date_value',
    };
  }

  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  return {
    kind: 'normalized',
    iso: `${String(year)}-${paddedMonth}-${paddedDay}`,
    year: String(year),
    month: paddedMonth,
    day: paddedDay,
  };
}

function projectMonthValue(
  month: string,
  target: MagicBrowseProtectedProjectionTarget | undefined
): string {
  const style = monthProjectionStyle(target);
  if (style === 'name') {
    return MONTH_NAMES[Number(month) - 1] ?? month;
  }
  if (style === 'short') {
    return (MONTH_NAMES[Number(month) - 1] ?? month).slice(0, 3);
  }
  return month;
}

function monthProjectionStyle(
  target: MagicBrowseProtectedProjectionTarget | undefined
): 'name' | 'short' | 'numeric' {
  const context = [target?.label, target?.displayLabel, target?.context?.hintText]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (
    /\bjanuary\b|\bfebruary\b|\bmarch\b|\bapril\b|\bmay\b|\bjune\b|\bjuly\b|\baugust\b|\bseptember\b|\boctober\b|\bnovember\b|\bdecember\b/.test(
      context
    )
  ) {
    return 'name';
  }

  if (
    /\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b/.test(
      context
    )
  ) {
    return 'short';
  }

  return 'numeric';
}

function directProtectedValue(
  protectedValues: Readonly<Record<string, string | undefined>>,
  fieldKey: string
): string | undefined {
  const value = protectedValues[fieldKey];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function groupFieldsByTarget(
  fields: readonly MagicBrowseMatchGroupField[]
): Array<{
  readonly targetRef: string;
  readonly fields: readonly MagicBrowseMatchGroupField[];
  readonly ordinal: number;
}> {
  const grouped = new Map<
    string,
    {
      fields: MagicBrowseMatchGroupField[];
      ordinal: number;
    }
  >();
  fields.forEach((field, index) => {
    const existing = grouped.get(field.targetRef);
    if (existing) {
      existing.fields.push(field);
      return;
    }
    grouped.set(field.targetRef, {
      fields: [field],
      ordinal: index,
    });
  });

  return [...grouped.entries()].map(([targetRef, group]) => ({
    targetRef,
    fields: group.fields,
    ordinal: group.ordinal,
  }));
}

function projectionOrder(fields: readonly MagicBrowseMatchGroupField[], ordinal: number): number {
  const fieldOrder = Math.min(...fields.map((field) => protectedFieldOrder(field.fieldKey)));
  return fieldOrder * 1000 + ordinal;
}

function protectedFieldOrder(fieldKey: string): number {
  switch (fieldKey) {
    case 'username':
      return 10;
    case 'password':
      return 20;
    case 'full_name':
    case 'cardholder':
      return 10;
    case 'document_number':
    case 'exp_month':
    case 'exp_year':
      return 20;
    case 'date_of_birth':
    case 'pan':
      return 30;
    case 'nationality':
    case 'cvv':
      return 40;
    case 'issue_date':
      return 50;
    case 'expiry_date':
      return 60;
    case 'issuing_country':
      return 70;
    default:
      return 1000;
  }
}
