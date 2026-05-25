import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { ResolveFieldTargetDescriptor, ResolveFieldValue } from './resolve-field.js';

export type OpenDataValueProjectionHint =
  | 'phone.country_calling_code'
  | 'phone.national_number';

export type OpenDataValueProjectionBlockedReason = 'unprojectable_value';

export type OpenDataValueProjectionResult =
  | {
      readonly status: 'ready';
      readonly value: ResolveFieldValue;
      readonly valueHint?: OpenDataValueProjectionHint;
    }
  | {
      readonly status: 'blocked';
      readonly reason: OpenDataValueProjectionBlockedReason;
    };

export interface ProjectOpenDataValueForTargetInput {
  readonly fieldKey: string;
  readonly value: ResolveFieldValue;
  readonly target: ResolveFieldTargetDescriptor;
  readonly valueHint?: OpenDataValueProjectionHint;
}

type PhoneProjectionKind = 'country_calling_code' | 'national_number';

export function projectOpenDataValueForTarget(
  input: ProjectOpenDataValueForTargetInput
): OpenDataValueProjectionResult {
  const phoneProjection = phoneProjectionKindForTarget(
    input.fieldKey,
    input.target,
    input.valueHint
  );
  if (!phoneProjection) {
    return {
      status: 'ready',
      value: input.value,
    };
  }

  return projectPhoneValue(input.value, phoneProjection);
}

function phoneProjectionKindForTarget(
  fieldKey: string,
  _target: ResolveFieldTargetDescriptor,
  valueHint: OpenDataValueProjectionHint | undefined
): PhoneProjectionKind | null {
  if (fieldKey !== 'phone') {
    return null;
  }

  if (valueHint === 'phone.country_calling_code') {
    return 'country_calling_code';
  }
  if (valueHint === 'phone.national_number') {
    return 'national_number';
  }

  return null;
}

function projectPhoneValue(
  value: ResolveFieldValue,
  projection: PhoneProjectionKind
): OpenDataValueProjectionResult {
  if (value === null || value === undefined) {
    return {
      status: 'blocked',
      reason: 'unprojectable_value',
    };
  }

  const parsed = parsePhoneNumberFromString(String(value).trim());
  if (!parsed) {
    return {
      status: 'blocked',
      reason: 'unprojectable_value',
    };
  }

  if (projection === 'country_calling_code') {
    return parsed.countryCallingCode
      ? {
          status: 'ready',
          value: `+${parsed.countryCallingCode}`,
          valueHint: 'phone.country_calling_code',
        }
      : {
          status: 'blocked',
          reason: 'unprojectable_value',
        };
  }

  return parsed.nationalNumber
    ? {
        status: 'ready',
        value: parsed.nationalNumber,
        valueHint: 'phone.national_number',
      }
    : {
        status: 'blocked',
        reason: 'unprojectable_value',
      };
}
