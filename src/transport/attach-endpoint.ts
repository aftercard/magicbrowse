interface BrowserVersionResponse {
  readonly webSocketDebuggerUrl?: string;
}

export type CdpEndpointProbeResult = 'match' | 'mismatch' | 'unreachable';

export async function resolveAttachEndpoint(input: string): Promise<string> {
  const normalized = input.trim();

  if (!normalized) {
    throw new Error('CDP endpoint must not be empty.');
  }

  const parsed = parseUrl(normalized);

  if (!parsed) {
    return normalized;
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    return normalized;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return normalized;
  }

  const versionUrl = buildCdpHttpEndpointUrl(normalized, '/json/version');

  if (!versionUrl) {
    throw new Error('The provided DevTools endpoint could not be normalized.');
  }

  const response = await fetch(versionUrl);

  if (!response.ok) {
    throw new Error(`DevTools version endpoint returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as BrowserVersionResponse;
  const webSocketDebuggerUrl = payload.webSocketDebuggerUrl?.trim();

  if (!webSocketDebuggerUrl) {
    throw new Error('DevTools version endpoint did not return a webSocketDebuggerUrl.');
  }

  return webSocketDebuggerUrl;
}

export function buildCdpHttpEndpointUrl(
  cdpUrl: string,
  resourcePath: '/json/version' | '/json/list' = '/json/version'
): string | null {
  const url = parseUrl(cdpUrl);

  if (!url) {
    return null;
  }

  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  url.pathname = resourcePath;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseBrowserInstanceRef(endpoint: string): string | undefined {
  const normalized = endpoint.trim();

  if (!normalized) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
    return url.pathname.split('/').filter(Boolean).at(-1) ?? normalized;
  } catch {
    return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
  }
}

export async function probeCdpEndpoint(
  endpoint: string,
  expectedBrowserInstanceRef: string | undefined
): Promise<CdpEndpointProbeResult> {
  const versionUrl = buildCdpHttpEndpointUrl(endpoint, '/json/version');

  if (!versionUrl || !expectedBrowserInstanceRef) {
    return 'unreachable';
  }

  try {
    const response = await fetch(versionUrl);

    if (!response.ok) {
      return 'unreachable';
    }

    const payload = (await response.json()) as BrowserVersionResponse;
    const liveEndpoint = payload.webSocketDebuggerUrl?.trim();

    if (!liveEndpoint) {
      return 'unreachable';
    }

    return parseBrowserInstanceRef(liveEndpoint) === expectedBrowserInstanceRef
      ? 'match'
      : 'mismatch';
  } catch {
    return 'unreachable';
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
