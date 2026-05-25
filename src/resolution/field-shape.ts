export interface FieldShapeTarget {
  readonly inputType?: string;
  readonly autocomplete?: string;
}

export interface FieldShapeCandidate {
  readonly fieldKey: string;
  readonly type: string;
}

const TELEPHONE_COUNTRY_CODE_FIELD_KEYS = new Set([
  'phone_country_code',
  'tel_country_code',
  'country_calling_code',
]);

function autocompleteTokens(value: string | undefined): Set<string> {
  return new Set(
    value
      ?.trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean) ?? []
  );
}

function hasTelephoneAutocomplete(tokens: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (token === 'tel' || token.startsWith('tel-')) {
      return true;
    }
  }

  return false;
}

export function isFieldShapeCompatible(
  target: FieldShapeTarget,
  candidate: FieldShapeCandidate
): boolean {
  const inputType = target.inputType?.toLowerCase();
  const autocomplete = autocompleteTokens(target.autocomplete);

  if (autocomplete.has('tel-country-code')) {
    return (
      (candidate.fieldKey === 'phone' || TELEPHONE_COUNTRY_CODE_FIELD_KEYS.has(candidate.fieldKey)) &&
      candidate.type === 'text'
    );
  }

  if (autocomplete.has('country') || autocomplete.has('country-name')) {
    return candidate.fieldKey === 'country' && candidate.type === 'text';
  }

  if (hasTelephoneAutocomplete(autocomplete)) {
    return candidate.fieldKey === 'phone' && candidate.type === 'text';
  }

  if (inputType === 'date' || autocomplete.has('bday')) {
    return candidate.type === 'date';
  }

  if (
    inputType === 'password' ||
    autocomplete.has('current-password') ||
    autocomplete.has('new-password')
  ) {
    return candidate.type === 'secret' || candidate.type === 'text';
  }

  if (inputType === 'email' || autocomplete.has('email')) {
    return candidate.type === 'email' || candidate.type === 'text';
  }

  if (inputType === 'tel') {
    return candidate.fieldKey === 'phone' && candidate.type === 'text';
  }

  return true;
}
