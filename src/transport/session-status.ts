import type { Browser } from 'puppeteer-core';

import type {
  MagicBrowseActivePageIdentity,
  MagicBrowseHumanVerificationResolvedMarker,
  MagicBrowseStatusResult,
  MagicBrowseTrustedRuntimeEvidence,
} from '../types.js';
import { redactSensitiveValue } from '../redaction.js';
import { buildCdpHttpEndpointUrl } from './attach-endpoint.js';
import { readPageIdentity, resolveActivePageForDiagnostics } from './page-resolver.js';
import type { PersistedMagicBrowseSession } from './session-store.js';

const DIAGNOSTIC_PAGE_RESOLUTION_TIMEOUT_MS = 8_000;

export const DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS = 300;

type StatusPageIdentityResolution =
  | {
      readonly status: 'resolved';
      readonly activePageIdentity: MagicBrowseActivePageIdentity;
    }
  | { readonly status: 'unresolved' | 'failed' | 'timed_out' };

export function isBrowserbaseSession(
  session: PersistedMagicBrowseSession
): session is PersistedMagicBrowseSession & {
  readonly cloudProvider: NonNullable<PersistedMagicBrowseSession['cloudProvider']>;
} {
  return session.cloudProvider?.name === 'browserbase';
}

export function summarizeSession(session: PersistedMagicBrowseSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    runId: session.runId,
    ownership: session.ownership,
    cloudProvider: session.cloudProvider,
    cdpUrl: isBrowserbaseSession(session) ? '[REDACTED_BROWSERBASE_CONNECT_URL]' : session.cdpUrl,
    pid: session.pid,
    profile: session.profile,
    activePageIdentity: session.activePageIdentity,
    headless: session.headless,
    viewport: session.viewport,
    userAgent: session.userAgent,
    proxy: session.proxy ? redactSensitiveValue(session.proxy) : undefined,
    stealth: session.stealth,
    humanVerificationResolved: session.humanVerificationResolved,
    redactionProfiles: session.redactionProfiles,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function normalizeMarkerTtlSeconds(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      'magicbrowse mark-captcha-resolved --ttl must be a positive number of seconds.'
    );
  }
  return value;
}

export function resolveTrustedHumanVerificationEvidence(input: {
  readonly marker: MagicBrowseHumanVerificationResolvedMarker | undefined;
  readonly currentPageIdentity: PersistedMagicBrowseSession['activePageIdentity'];
  readonly now: Date;
}): {
  readonly evidence?: MagicBrowseTrustedRuntimeEvidence;
  readonly clearReason?: 'consumed' | 'expired' | 'page_mismatch';
} {
  if (!input.marker) {
    return {};
  }

  if (Date.parse(input.marker.expiresAt) <= input.now.getTime()) {
    return { clearReason: 'expired' };
  }

  if (!humanVerificationMarkerMatchesPage(input.marker, input.currentPageIdentity)) {
    return { clearReason: 'page_mismatch' };
  }

  return {
    evidence: input.marker,
    clearReason: 'consumed',
  };
}

export function statusSessionMetadata(
  session: PersistedMagicBrowseSession,
  runId: string | undefined
): Pick<MagicBrowseStatusResult, 'sessionId' | 'runId' | 'ownership' | 'cloudProvider'> {
  return {
    sessionId: session.id,
    ...(runId ? { runId } : {}),
    ownership: session.ownership,
    ...(session.cloudProvider ? { cloudProvider: session.cloudProvider } : {}),
  };
}

export function buildAliveStatusResult(
  session: PersistedMagicBrowseSession,
  runId: string | undefined,
  activePageIdentity: MagicBrowseActivePageIdentity | undefined,
  options: {
    readonly currentPageUnresolved?: true;
    readonly diagnosticReason?: MagicBrowseStatusResult['diagnosticReason'];
  } = {}
): MagicBrowseStatusResult {
  return {
    ...statusSessionMetadata(session, runId),
    success: true,
    alive: true,
    outcomeType: 'browser_alive',
    ...(activePageIdentity?.targetId ? { pageRef: `tab:${activePageIdentity.targetId}` } : {}),
    ...(activePageIdentity?.url ? { url: activePageIdentity.url } : {}),
    ...(activePageIdentity?.title ? { title: activePageIdentity.title } : {}),
    ...(options.currentPageUnresolved ? { currentPageUnresolved: true } : {}),
    ...(options.diagnosticReason ? { diagnosticReason: options.diagnosticReason } : {}),
  };
}

export async function readConnectedStatusPageIdentityWithTimeout(
  browser: Browser,
  activePageIdentity: MagicBrowseActivePageIdentity | undefined
): Promise<StatusPageIdentityResolution> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const resolutionTask = Promise.resolve()
    .then(async (): Promise<StatusPageIdentityResolution> => {
      const resolution = await resolveActivePageForDiagnostics({
        browser,
        activePageIdentity,
      });

      if (!resolution?.confident) {
        return { status: 'unresolved' };
      }

      return {
        status: 'resolved',
        activePageIdentity: await readPageIdentity(resolution.page),
      };
    })
    .catch((): StatusPageIdentityResolution => ({ status: 'failed' }));
  const timeoutTask = new Promise<{ readonly status: 'timed_out' }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ status: 'timed_out' as const }),
      DIAGNOSTIC_PAGE_RESOLUTION_TIMEOUT_MS
    );
  });

  try {
    return await Promise.race([resolutionTask, timeoutTask]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    void resolutionTask.catch(() => undefined);
  }
}

export async function readPageIdentityFromCdpList(
  session: PersistedMagicBrowseSession
): Promise<MagicBrowseActivePageIdentity | undefined> {
  const listUrl = buildCdpHttpEndpointUrl(session.cdpUrl, '/json/list');

  if (!listUrl) {
    return undefined;
  }

  try {
    const response = await fetch(listUrl);

    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json();

    if (!Array.isArray(payload)) {
      return undefined;
    }

    const targets = payload.map(parseCdpPageTarget).filter((target) => target !== undefined);
    const persistedTargetId = session.activePageIdentity?.targetId;
    const byPersistedTarget = persistedTargetId
      ? targets.find((target) => target.targetId === persistedTargetId)
      : undefined;
    return byPersistedTarget ?? targets.find((target) => isMeaningfulHttpPageUrl(target.url));
  } catch {
    return undefined;
  }
}

export function isMeaningfulHttpPageUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? '';
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

function humanVerificationMarkerMatchesPage(
  marker: MagicBrowseHumanVerificationResolvedMarker,
  currentPageIdentity: PersistedMagicBrowseSession['activePageIdentity']
): boolean {
  if (!currentPageIdentity) {
    return false;
  }

  if (
    marker.pageIdentity.targetId &&
    currentPageIdentity.targetId &&
    marker.pageIdentity.targetId === currentPageIdentity.targetId
  ) {
    return true;
  }

  const markerUrl = normalizeComparableUrl(marker.pageIdentity.url);
  const currentUrl = normalizeComparableUrl(currentPageIdentity.url);
  return Boolean(markerUrl && currentUrl && markerUrl === currentUrl);
}

function normalizeComparableUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function parseCdpPageTarget(value: unknown): MagicBrowseActivePageIdentity | undefined {
  const record = asRecord(value);

  if (!record || stringValue(record.type) !== 'page') {
    return undefined;
  }

  const targetId = stringValue(record.id) ?? stringValue(record.targetId);
  const url = stringValue(record.url);
  const title = stringValue(record.title);

  if (!targetId && !url && !title) {
    return undefined;
  }

  return {
    ...(targetId ? { targetId } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
