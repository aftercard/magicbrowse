import type { Browser, Page } from 'puppeteer-core';

import type { MagicBrowseActivePageIdentity } from '../types.js';

export interface ResolveActivePageInput {
  readonly browser: Browser;
  readonly activePageIdentity?: MagicBrowseActivePageIdentity;
}

export type ActivePageResolutionSource =
  | 'target_id'
  | 'url_title'
  | 'sole_meaningful_page'
  | 'first_non_blank_page'
  | 'new_page';

export interface ActivePageResolution {
  readonly page: Page;
  readonly source: ActivePageResolutionSource;
  readonly confident: boolean;
}

export async function resolveActivePage(input: ResolveActivePageInput): Promise<Page> {
  const resolution = await resolveActivePageWithMetadata(input, {
    createIfMissing: true,
    focusResolvedPage: true,
  });
  if (!resolution) {
    throw new Error('MagicBrowse could not resolve an active page.');
  }
  return resolution.page;
}

export async function resolveActivePageForDiagnostics(
  input: ResolveActivePageInput
): Promise<ActivePageResolution | undefined> {
  return resolveActivePageWithMetadata(input, {
    createIfMissing: false,
    focusResolvedPage: false,
  });
}

async function resolveActivePageWithMetadata(
  input: ResolveActivePageInput,
  options: { readonly createIfMissing: boolean; readonly focusResolvedPage: boolean }
): Promise<ActivePageResolution | undefined> {
  const pages = await input.browser.pages();
  const identity = input.activePageIdentity;

  if (identity?.targetId) {
    for (const page of pages) {
      if ((await readPageTargetId(page)) === identity.targetId) {
        await bringToFrontIfNeeded(page, options);
        return {
          page,
          source: 'target_id',
          confident: true,
        };
      }
    }
  }

  if (identity?.url || identity?.title) {
    for (const page of pages) {
      const title = await readPageTitle(page);
      const urlMatches = !identity.url || page.url() === identity.url;
      const titleMatches = !identity.title || title === identity.title;

      if (urlMatches && titleMatches) {
        await bringToFrontIfNeeded(page, options);
        return {
          page,
          source: 'url_title',
          confident: true,
        };
      }
    }
  }

  const meaningfulPages = pages.filter((page) => isMeaningfulPageUrl(page.url()));
  if (meaningfulPages.length === 1) {
    await bringToFrontIfNeeded(meaningfulPages[0]!, options);
    return {
      page: meaningfulPages[0]!,
      source: 'sole_meaningful_page',
      confident: true,
    };
  }

  const nonBlankPage = pages.find((page) => isNonBlankPageUrl(page.url()));
  if (nonBlankPage) {
    await bringToFrontIfNeeded(nonBlankPage, options);
    return {
      page: nonBlankPage,
      source: 'first_non_blank_page',
      confident: false,
    };
  }

  if (!options.createIfMissing) {
    return undefined;
  }

  const page = await input.browser.newPage();
  await bringToFrontIfNeeded(page, options);
  return {
    page,
    source: 'new_page',
    confident: false,
  };
}

async function bringToFrontIfNeeded(
  page: Page,
  options: { readonly focusResolvedPage: boolean }
): Promise<void> {
  if (!options.focusResolvedPage) {
    return;
  }

  await bringToFront(page);
}

export async function readPageIdentity(page: Page): Promise<MagicBrowseActivePageIdentity> {
  const targetId = await readPageTargetId(page);
  const title = await readPageTitle(page);
  const url = page.url();

  return {
    ...(targetId ? { targetId } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

export async function readPageTargetId(page: Page): Promise<string | undefined> {
  try {
    const target = asRecord(page.target?.());
    const targetId =
      stringValue(target?._targetId) ??
      stringValue(asRecord(target?._targetInfo)?.targetId) ??
      stringValue(target?.targetId);
    const idFunction = target?.id;

    if (targetId) {
      return targetId;
    }

    if (typeof idFunction === 'function') {
      const value = idFunction.call(target);
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function readPageTitle(page: Page): Promise<string | undefined> {
  try {
    const title = await page.title();
    return title.trim().length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
}

async function bringToFront(page: Page): Promise<void> {
  try {
    await page.bringToFront();
  } catch {
    // Best effort only; some targets cannot be focused.
  }
}

function isMeaningfulPageUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

function isNonBlankPageUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return Boolean(
    normalized &&
      normalized !== 'about:blank' &&
      normalized !== 'chrome://newtab/' &&
      normalized !== 'chrome://new-tab-page/' &&
      normalized !== 'chrome://newtab'
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
