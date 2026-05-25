import { createHash } from 'node:crypto';

const REDACTED = '[REDACTED]';
export const REDACTED_IMAGE_DATA_URL = '[REDACTED_IMAGE_DATA_URL]';
const TRUNCATION_LIMIT = 500_000;
const MAX_DEPTH = 20;
const TRANSIENT_IMAGE_DATA_URL_PATTERN =
  /\bdata:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g;

const SENSITIVE_KEY_PARTS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'signingkey',
  'authorization',
  'cookie',
]);

type TextReplacement = string | ((match: string, ...args: string[]) => string);

export interface ProtectedExactValueRule {
  readonly kind: 'exact' | 'digits';
  readonly digest: string;
  readonly length: number;
}

export interface ProtectedExactValueProfile {
  readonly version: 1;
  readonly algorithm: 'sha256';
  readonly rules: Record<string, ProtectedExactValueRule>;
}

export type ProtectedRedactionProfiles = Record<string, ProtectedExactValueProfile>;

export interface RedactSensitiveOptions {
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
}

const INLINE_REDACTIONS: ReadonlyArray<[RegExp, TextReplacement]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, `Bearer ${REDACTED}`],
  [/\bAuthorization\s*:(?!\s*Bearer\b)[^\r\n]+/gi, `Authorization: ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [
    /\b(password|passwd|pwd|secret|token|api[_-]?key|signing[_-]?key|cookie|access[_-]?token|refresh[_-]?token|client[_-]?secret)(\s*[:=]\s*)([^\s,;&]+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  ],
  [
    /([?&](?:password|passwd|pwd|secret|token|api[_-]?key|apikey|signing[_-]?key|access_token|refresh_token|client_secret)=)([^&#\s]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  ],
];

export function redactSensitiveText(value: string, options: RedactSensitiveOptions = {}): string {
  const truncated =
    value.length > TRUNCATION_LIMIT ? `${value.slice(0, TRUNCATION_LIMIT)}\n[truncated]` : value;

  let current = redactTransientImageDataUrls(truncated);
  for (const [pattern, replacement] of INLINE_REDACTIONS) {
    current =
      typeof replacement === 'string'
        ? current.replace(pattern, replacement)
        : current.replace(pattern, replacement as Parameters<string['replace']>[1]);
  }
  return redactProtectedExactText(current, options.protectedRedactionProfiles);
}

export function redactSensitiveValue(
  value: unknown,
  options: RedactSensitiveOptions = {}
): unknown {
  return redactValue(value, new WeakSet<object>(), 0, undefined, options);
}

export function redactTransientImageDataUrls(value: string): string {
  return value.replace(TRANSIENT_IMAGE_DATA_URL_PATTERN, REDACTED_IMAGE_DATA_URL);
}

export function buildProtectedExactValueProfile(
  values: Readonly<Record<string, string | undefined>>
): ProtectedExactValueProfile {
  const exactValues = new Set<string>();
  const digitValues = new Set<string>();

  for (const value of Object.values(values)) {
    addExactValue(exactValues, value);
  }

  addNameDerivedValues(exactValues, values.full_name);
  addDateDerivedValues(exactValues, values.date_of_birth);
  addPanDerivedValues(exactValues, digitValues, values.pan);
  addExpiryDerivedValues(exactValues, values.exp_month, values.exp_year);

  const rules: Record<string, ProtectedExactValueRule> = {};
  let index = 0;
  for (const value of exactValues) {
    rules[`exact-${index++}`] = {
      kind: 'exact',
      digest: digestProtectedValue(value),
      length: value.length,
    };
  }
  for (const value of digitValues) {
    rules[`digits-${index++}`] = {
      kind: 'digits',
      digest: digestProtectedValue(value),
      length: value.length,
    };
  }

  return {
    version: 1,
    algorithm: 'sha256',
    rules,
  };
}

export function normalizeProtectedRedactionProfiles(
  value: unknown
): ProtectedRedactionProfiles | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const profiles: ProtectedRedactionProfiles = {};
  for (const [profileRef, profile] of Object.entries(value)) {
    const normalized = normalizeProtectedExactValueProfile(profile);
    if (normalized) {
      profiles[profileRef] = normalized;
    }
  }

  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

export function mergeProtectedRedactionProfiles(
  left: ProtectedRedactionProfiles | undefined,
  right: ProtectedRedactionProfiles | undefined
): ProtectedRedactionProfiles | undefined {
  if (!left && !right) {
    return undefined;
  }

  return {
    ...(left ?? {}),
    ...(right ?? {}),
  };
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  key: string | undefined,
  options: RedactSensitiveOptions
): unknown {
  if (key && isSensitiveKey(key)) {
    return REDACTED;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value, options);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'undefined') {
    return '[undefined]';
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth > MAX_DEPTH) {
    return '[MaxDepth]';
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1, undefined, options));
  }

  const out: Record<string, unknown> = {};
  for (const [currentKey, currentValue] of Object.entries(value)) {
    out[currentKey] = redactValue(currentValue, seen, depth + 1, currentKey, options);
  }
  return out;
}

function normalizeProtectedExactValueProfile(value: unknown): ProtectedExactValueProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<ProtectedExactValueProfile>;
  if (record.version !== 1 || record.algorithm !== 'sha256' || !isRecord(record.rules)) {
    return undefined;
  }

  const rules: Record<string, ProtectedExactValueRule> = {};
  for (const [ruleRef, rule] of Object.entries(record.rules)) {
    if (!isRecord(rule)) {
      continue;
    }
    if (
      (rule.kind === 'exact' || rule.kind === 'digits') &&
      typeof rule.digest === 'string' &&
      /^[a-f0-9]{64}$/i.test(rule.digest) &&
      typeof rule.length === 'number' &&
      Number.isInteger(rule.length) &&
      rule.length > 0
    ) {
      rules[ruleRef] = {
        kind: rule.kind,
        digest: rule.digest.toLowerCase(),
        length: rule.length,
      };
    }
  }

  return Object.keys(rules).length > 0
    ? {
        version: 1,
        algorithm: 'sha256',
        rules,
      }
    : undefined;
}

function redactProtectedExactText(
  value: string,
  profiles: ProtectedRedactionProfiles | undefined
): string {
  const rules = profiles
    ? Object.values(profiles)
        .flatMap((profile) => Object.values(profile.rules))
        .filter((rule) => rule.length > 0)
    : [];
  if (rules.length === 0 || value.length === 0) {
    return value;
  }

  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  for (const rule of rules.sort((left, right) => right.length - left.length)) {
    if (rule.kind === 'exact') {
      ranges.push(...findExactDigestRanges(value, rule));
    } else {
      ranges.push(...findDigitDigestRanges(value, rule));
    }
  }

  return replaceRanges(value, ranges);
}

function findExactDigestRanges(
  value: string,
  rule: ProtectedExactValueRule
): Array<{ readonly start: number; readonly end: number }> {
  if (rule.length > value.length) {
    return [];
  }

  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  for (let index = 0; index <= value.length - rule.length; index += 1) {
    const candidate = value.slice(index, index + rule.length);
    if (digestProtectedValue(candidate) === rule.digest) {
      ranges.push({ start: index, end: index + rule.length });
    }
  }
  return ranges;
}

function findDigitDigestRanges(
  value: string,
  rule: ProtectedExactValueRule
): Array<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ readonly start: number; readonly end: number }> = [];
  const digitRunPattern = /[\d\s./-]{4,}/g;
  let match: RegExpExecArray | null;
  while ((match = digitRunPattern.exec(value)) !== null) {
    const raw = match[0] ?? '';
    const digits = [...raw]
      .map((char, offset) => ({ char, offset }))
      .filter(({ char }) => /\d/.test(char));
    if (digits.length < rule.length) {
      continue;
    }

    for (let index = 0; index <= digits.length - rule.length; index += 1) {
      const window = digits.slice(index, index + rule.length);
      const candidate = window.map(({ char }) => char).join('');
      if (digestProtectedValue(candidate) !== rule.digest) {
        continue;
      }
      const first = window[0]!;
      const last = window.at(-1)!;
      ranges.push({
        start: match.index + first.offset,
        end: match.index + last.offset + 1,
      });
    }
  }
  return ranges;
}

function replaceRanges(
  value: string,
  ranges: Array<{ readonly start: number; readonly end: number }>
): string {
  if (ranges.length === 0) {
    return value;
  }

  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ readonly start: number; readonly end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, range.end),
      };
      continue;
    }
    merged.push(range);
  }

  let output = '';
  let cursor = 0;
  for (const range of merged) {
    output += value.slice(cursor, range.start);
    output += REDACTED;
    cursor = range.end;
  }
  output += value.slice(cursor);
  return output;
}

function addNameDerivedValues(values: Set<string>, fullName: string | undefined): void {
  const normalized = normalizeWhitespace(fullName ?? '');
  if (!normalized) {
    return;
  }

  const parts = normalized.split(' ').filter(Boolean);
  addExactValue(values, parts[0]);
  addExactValue(values, parts.at(-1));
}

function addDateDerivedValues(values: Set<string>, rawDate: string | undefined): void {
  const normalized = normalizeDate(rawDate);
  if (normalized) {
    addExactValue(values, normalized);
  }
}

function addPanDerivedValues(
  exactValues: Set<string>,
  digitValues: Set<string>,
  rawPan: string | undefined
): void {
  addExactValue(exactValues, rawPan);
  const digits = rawPan?.replace(/\D/g, '') ?? '';
  if (digits.length >= 12) {
    digitValues.add(digits);
  }
}

function addExpiryDerivedValues(
  values: Set<string>,
  rawMonth: string | undefined,
  rawYear: string | undefined
): void {
  const monthNumber = Number(rawMonth?.trim());
  const year = rawYear?.trim();
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12 || !year) {
    return;
  }
  if (!/^\d{2}$|^\d{4}$/.test(year)) {
    return;
  }

  const month = String(monthNumber).padStart(2, '0');
  const shortYear = year.length === 4 ? year.slice(-2) : year.padStart(2, '0');
  const longYear = year.length === 4 ? year : `20${year.padStart(2, '0')}`;
  addExactValue(values, `${month}/${shortYear}`);
  addExactValue(values, `${month}/${longYear}`);
}

function addExactValue(values: Set<string>, value: string | undefined): void {
  const normalized = normalizeWhitespace(value ?? '');
  if (normalized.length >= 3) {
    values.add(normalized);
  }
}

function normalizeDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const dayFirst = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    if (day > 12) {
      return validIsoDate(Number(dayFirst[3]), month, day);
    }
  }

  return undefined;
}

function validIsoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function digestProtectedValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_KEY_PARTS.has(normalized) ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('cookie') ||
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'cookie'
  );
}
