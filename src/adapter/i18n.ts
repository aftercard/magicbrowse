import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type MessageValue = {
  message: string;
  placeholders?: Record<string, { content?: string; example?: string }>;
};

type MessageCatalog = Record<string, MessageValue>;

export const supportedLocales = ['en', 'pt_BR', 'zh_TW'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const DEFAULT_LOCALE: SupportedLocale = 'en';
const __filename = fileURLToPath(import.meta.url);
const localeRoot = path.resolve(path.dirname(__filename), 'i18n/locales');
const catalogs = new Map<SupportedLocale, MessageCatalog>();

function isSupportedLocale(value: string): value is SupportedLocale {
  return (supportedLocales as readonly string[]).includes(value);
}

function normalizeLocale(raw: string | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;

  const normalized = raw
    .split('.')[0]
    ?.split('@')[0]
    ?.replace(/-/g, '_') ?? '';

  if (isSupportedLocale(normalized)) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  if (lower === 'pt' || lower.startsWith('pt_')) return 'pt_BR';
  if (lower === 'zh' || lower.startsWith('zh_')) return 'zh_TW';
  return DEFAULT_LOCALE;
}

function resolveDefaultLocale(): SupportedLocale {
  return normalizeLocale(
    process.env.MAGICBROWSE_LOCALE ||
      process.env.LC_ALL ||
      process.env.LC_MESSAGES ||
      process.env.LANG,
  );
}

function loadCatalog(locale: SupportedLocale): MessageCatalog {
  const cached = catalogs.get(locale);
  if (cached) return cached;

  const file = path.join(localeRoot, locale, 'messages.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as MessageCatalog;
  catalogs.set(locale, parsed);
  return parsed;
}

function getMessage(locale: SupportedLocale, key: string): MessageValue | undefined {
  return loadCatalog(locale)[key] ?? loadCatalog(DEFAULT_LOCALE)[key];
}

function applyPlaceholders(message: string, value: MessageValue): string {
  let result = message;
  if (!value.placeholders) {
    return result;
  }

  for (const [placeholder, { content }] of Object.entries(value.placeholders)) {
    if (!content) continue;
    result = result.replace(new RegExp(`\\$${placeholder}\\$`, 'gi'), content);
  }
  return result;
}

function applySubstitutions(message: string, substitutions?: readonly (string | number | boolean)[]): string {
  if (!substitutions) {
    return message;
  }

  let result = message;
  substitutions.forEach((current, index) => {
    result = result.replaceAll(`$${index + 1}`, String(current));
  });
  return result;
}

function removeUnfilledSubstitutions(message: string): string {
  return message.replace(/\$\d+/g, '');
}

function translate(key: string, substitutions?: readonly (string | number | boolean)[]): string {
  const locale = normalizeLocale(t.devLocale);
  const value = getMessage(locale, key);
  if (!value) {
    return substitutions && substitutions.length > 0 ? `${key}: ${substitutions.join(', ')}` : key;
  }

  const withPlaceholders = applyPlaceholders(value.message, value);
  const withSubstitutions = applySubstitutions(withPlaceholders, substitutions);
  return removeUnfilledSubstitutions(withSubstitutions);
}

export const t = Object.assign(translate, {
  devLocale: resolveDefaultLocale(),
});
