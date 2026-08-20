import puppeteer from 'puppeteer-core';
import type { Browser, ConnectOptions, ConnectionTransport, Page } from 'puppeteer-core';
import { CdpBrowser } from 'puppeteer-core/internal/cdp/Browser.js';
import { Connection } from 'puppeteer-core/internal/cdp/Connection.js';
import { NodeWebSocketTransport } from 'puppeteer-core/internal/node/NodeWebSocketTransport.js';

import type {
  MagicBrowseActOptions,
  MagicBrowseActResult,
  MagicBrowseActivePageIdentity,
  MagicBrowseAttachOptions,
  MagicBrowseClickOptions,
  MagicBrowseCloseOptions,
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseDeterministicActionResult,
  MagicBrowseDeterministicActionVerb,
  MagicBrowseFillOptions,
  MagicBrowseLaunchOptions,
  MagicBrowseMarkCaptchaResolvedOptions,
  MagicBrowseMarkCaptchaResolvedResult,
  MagicBrowseManagedSession,
  MagicBrowseObserveOptions,
  MagicBrowseObserveResult,
  MagicBrowsePressOptions,
  MagicBrowseProxyConfig,
  MagicBrowseScreenshotOptions,
  MagicBrowseScreenshotResult,
  MagicBrowseSelectOptions,
  MagicBrowseSubmitFormTargetOptions,
  MagicBrowseSubmitFormTargetResult,
  MagicBrowseStatusResult,
  MagicBrowseTypeOptions,
  MagicBrowseHumanVerificationResolvedMarker,
} from '../types.js';
import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import {
  redactSensitiveText,
  redactSensitiveValue,
  type ExactValueRedactionProfiles,
} from '../redaction.js';
import {
  buildMagicBrowseDeterministicActionBlockedResult,
  executeMagicBrowseClickAction,
  executeMagicBrowseInputAction,
  executeMagicBrowsePressAction,
  executeMagicBrowseSelectAction,
} from '../resolution/deterministic-actions.js';
import { submitFormTarget as executeSubmitFormTarget } from '../resolution/submit-target.js';
import { targetDescriptorSignature } from '../resolution/target-observation-lease.js';
import type { TargetObservationLease } from '../resolution/target-observation-lease.js';
import { executeMagicBrowseAct } from '../runtime/execute-act.js';
import {
  attachNativeBrowserDialogGuard,
  type NativeBrowserDialogGuard,
} from '../runtime/native-dialogs.js';
import { executeMagicBrowseObserve } from '../runtime/execute-observe.js';
import {
  DEFAULT_AGENTIC_ACT_TIMEOUT_MS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  BrowserActionDeadlineError,
  disconnectBrowserOnce,
  isBrowserActionDeadlineError,
  normalizeBrowserActionTimeoutMs,
  runWithBrowserActionDeadline,
} from '../runtime/browser-action-deadline.js';
import BrowserPage from '../vendor/browser/page.js';
import { INITIAL_BROWSER_TAB_ID } from '../browser/browser-context.js';
import {
  createFileAgentSessionStateStore,
  type AgentSessionStateStore,
} from './agent-session-store.js';
import { probeCdpEndpoint, resolveAttachEndpoint } from './attach-endpoint.js';
import {
  createDetachedChromeBrowserLauncher,
  normalizeProxySetting,
  type OwnedBrowserLauncher,
} from './owned-browser-launcher.js';
import { readPageIdentity, readPageTargetId, resolveActivePage } from './page-resolver.js';
import {
  createFileMagicBrowseSessionStore,
  createPersistedMagicBrowseSession,
  type MagicBrowseSessionStore,
  type PersistedMagicBrowseSession,
  persistedSessionRevision,
  touchPersistedMagicBrowseSession,
} from './session-store.js';
import {
  createFileMagicBrowseRunStore,
  type MagicBrowseRunEventInput,
  type MagicBrowseRunRecorder,
  type MagicBrowseRunStore,
  type MagicBrowseRunUpdateInput,
} from './run-store.js';
import {
  buildAliveStatusResult,
  DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS,
  isBrowserbaseSession,
  isMeaningfulHttpPageUrl,
  normalizeMarkerTtlSeconds,
  readConnectedStatusPageIdentityWithTimeout,
  readPageIdentityFromCdpList,
  resolveTrustedHumanVerificationEvidence,
  statusSessionMetadata,
  summarizeSession,
} from './session-status.js';
import {
  getDefaultMagicBrowseStealthPuppeteerClient,
  type MagicBrowsePuppeteerClient,
} from './stealth-client.js';
import {
  createBrowserbaseClient,
  type BrowserbaseClient,
  type BrowserbaseSession,
} from './browserbase-client.js';

export interface MagicBrowseSessionManagerOptions {
  readonly store?: MagicBrowseSessionStore;
  readonly launcher?: OwnedBrowserLauncher;
  readonly runStore?: MagicBrowseRunStore;
  readonly agentStateStore?: AgentSessionStateStore;
  readonly puppeteer?: MagicBrowsePuppeteerClient;
  readonly connectLocalCdpWithoutInitialTargetWait?: MagicBrowseLocalCdpFallbackConnector;
  readonly browserbase?: BrowserbaseClient;
  readonly createSessionId?: () => string;
  readonly createActId?: () => string;
  readonly createObserveId?: () => string;
  /** Default aggregate deadline for act, observe, and deterministic actions. */
  readonly browserActionTimeoutMs?: number;
}

const plainPuppeteer = puppeteer as unknown as MagicBrowsePuppeteerClient;
const LOCAL_BROWSER_CONNECT_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_BROWSER_CONNECT_TIMEOUT_MS = 8_000;
const LOCAL_CDP_FALLBACK_PROTOCOL_TIMEOUT_MS = 3_000;
const LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_TIMEOUT_MS = 2_000;
const LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_POLL_MS = 50;
const LOCAL_CDP_FALLBACK_STRATEGY = 'without_initial_target_wait' as const;
const LOCAL_CDP_FALLBACK_REASON = 'public_connect_timeout' as const;
const OWNED_BROWSER_PUPPETEER_CLOSE_TIMEOUT_MS = 2_000;
const OWNED_BROWSER_CLOSE_CONNECT_TIMEOUT_MS = 2_000;
const BROWSER_OPERATION_CLEANUP_TIMEOUT_MS = 2_000;
export { DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS };

class SessionAuthorityConflictError extends BrowserActionDeadlineError {
  constructor(actionName: string) {
    super('action_cancelled', actionName);
    this.name = 'SessionAuthorityConflictError';
  }
}

type BrowserConnectWithTimeoutResult =
  | { readonly status: 'connected'; readonly browser: Browser }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timed_out' };

type MutablePersistedMagicBrowseSession = {
  -readonly [Key in keyof PersistedMagicBrowseSession]: PersistedMagicBrowseSession[Key];
};

export interface MagicBrowseLocalCdpFallbackConnectInput {
  readonly cdpUrl: string;
  readonly defaultViewport: ConnectOptions['defaultViewport'];
  readonly protocolTimeoutMs: number;
}

export type MagicBrowseLocalCdpFallbackConnector = (
  input: MagicBrowseLocalCdpFallbackConnectInput
) => Promise<Browser>;

export class MagicBrowseSessionManager {
  private readonly store: MagicBrowseSessionStore;
  private readonly launcher: OwnedBrowserLauncher;
  private readonly runStore: MagicBrowseRunStore;
  private readonly agentStateStore: AgentSessionStateStore;
  private readonly puppeteer?: MagicBrowsePuppeteerClient;
  private readonly connectLocalCdpWithoutInitialTargetWait: MagicBrowseLocalCdpFallbackConnector;
  private readonly browserbase?: BrowserbaseClient;
  private readonly createSessionId: () => string;
  private readonly createActId: () => string;
  private readonly createObserveId: () => string;
  private readonly browserActionTimeoutMs: number;
  /**
   * Kept separately from the resolved default so `act` can tell "the caller
   * chose 60s" from "nobody chose anything". Only the latter gets the longer
   * agentic budget; an explicit choice stays authoritative.
   */
  private readonly configuredBrowserActionTimeoutMs?: number;

  constructor(options: MagicBrowseSessionManagerOptions = {}) {
    this.store = options.store ?? createFileMagicBrowseSessionStore();
    this.launcher = options.launcher ?? createDetachedChromeBrowserLauncher();
    this.runStore = options.runStore ?? createFileMagicBrowseRunStore();
    this.agentStateStore = options.agentStateStore ?? createFileAgentSessionStateStore();
    this.puppeteer = options.puppeteer;
    this.connectLocalCdpWithoutInitialTargetWait =
      options.connectLocalCdpWithoutInitialTargetWait ?? connectLocalCdpWithoutInitialTargetWait;
    this.browserbase = options.browserbase;
    this.createSessionId = options.createSessionId ?? createDefaultSessionId;
    this.createActId = options.createActId ?? createDefaultActId;
    this.createObserveId = options.createObserveId ?? createDefaultObserveId;
    this.browserActionTimeoutMs = normalizeBrowserActionTimeoutMs(
      options.browserActionTimeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS
    );
    this.configuredBrowserActionTimeoutMs =
      options.browserActionTimeoutMs === undefined
        ? undefined
        : normalizeBrowserActionTimeoutMs(options.browserActionTimeoutMs);
  }

  async launch(options: MagicBrowseLaunchOptions = {}): Promise<MagicBrowseManagedSession> {
    if (options.cloud) {
      return this.launchCloud(options);
    }

    await this.closeCurrentSession({ ignoreMissing: true });

    const id = this.createSessionId();
    const proxy = normalizeProxySetting(options.proxy);
    const runRecorder = await this.runStore.createSessionRun({
      sessionId: id,
      ownership: 'owned',
      instruction: options.url ? `launch ${options.url}` : 'launch',
    });
    await runRecorder.append({
      type: 'session.launch.start',
      data: {
        sessionId: id,
        runId: runRecorder.runId,
        url: options.url,
        headless: options.headless,
        profile: options.profile,
        userDataDir: options.userDataDir,
        viewport: options.viewport,
        userAgent: options.userAgent,
        proxy: proxy ? redactSensitiveValue(proxy) : undefined,
        stealth: options.stealth,
      },
    });
    let launched: Awaited<ReturnType<OwnedBrowserLauncher['launch']>> | undefined;
    try {
      launched = await this.launcher.launch({
        sessionId: id,
        executablePath: options.executablePath,
        headless: options.headless,
        args: options.chromeArgs,
        viewport: options.viewport,
        userAgent: options.userAgent,
        proxy,
        profile: options.profile,
        userDataDir: options.userDataDir,
      });

      let session = createPersistedMagicBrowseSession({
        id,
        runId: runRecorder.runId,
        ownership: 'owned',
        cdpUrl: launched.cdpUrl,
        pid: launched.pid,
        profile: launched.profile,
        headless: options.headless,
        viewport: options.viewport,
        userAgent: options.userAgent,
        proxy,
        stealth: options.stealth,
      });
      await runRecorder.append({
        type: 'session.launch.browser_ready',
        data: summarizeSession(session),
      });

      if (options.url) {
        const browser = await this.connect(session, { runRecorder });
        try {
          await runRecorder.append({
            type: 'session.launch.navigate.start',
            data: { url: options.url },
          });
          const pages = await browser.pages();
          const page = pages[0] ?? (await browser.newPage());
          await authenticateProxyIfNeeded(page, proxy);
          try {
            await page.bringToFront();
          } catch {
            // Best effort only; launch can still navigate an unfocused page.
          }
          await page.goto(options.url, { waitUntil: 'domcontentloaded' });
          session = touchPersistedMagicBrowseSession(session, {
            activePageIdentity: await readPageIdentity(page),
          });
          await runRecorder.append({
            type: 'session.launch.navigate.complete',
            data: {
              activePageIdentity: session.activePageIdentity,
            },
          });
        } finally {
          await disconnectBrowser(browser);
        }
      }

      await this.store.saveCurrentSession(session);
      await runRecorder.update({
        activePageIdentity: session.activePageIdentity,
      });
      await runRecorder.append({
        type: 'session.launch.complete',
        data: summarizeSession(session),
      });
      return this.toManagedSession(session);
    } catch (error) {
      await runRecorder.append({
        type: 'session.launch.error',
        level: 'error',
        message: errorToMessage(error),
      });
      await runRecorder.update({ status: 'failed' });
      if (launched) {
        await this.launcher
          .close({ cdpUrl: launched.cdpUrl, pid: launched.pid })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await runRecorder.flush();
    }
  }

  private async launchCloud(options: MagicBrowseLaunchOptions): Promise<MagicBrowseManagedSession> {
    await this.closeCurrentSession({ ignoreMissing: true });

    const id = this.createSessionId();
    const browserbase = this.resolveBrowserbaseClient();
    const runRecorder = await this.runStore.createSessionRun({
      sessionId: id,
      ownership: 'owned',
      instruction: options.url ? `launch --cloud ${options.url}` : 'launch --cloud',
    });
    await runRecorder.append({
      type: 'session.launch.start',
      data: {
        sessionId: id,
        runId: runRecorder.runId,
        cloud: true,
        provider: 'browserbase',
        url: options.url,
        viewport: options.viewport,
        userAgent: options.userAgent,
        stealth: options.stealth,
      },
    });

    let browserbaseSession: (BrowserbaseSession & { readonly connectUrl: string }) | undefined;
    try {
      browserbaseSession = await browserbase.createSession();
      let session = createPersistedMagicBrowseSession({
        id,
        runId: runRecorder.runId,
        ownership: 'owned',
        cdpUrl: browserbaseSession.connectUrl,
        cloudProvider: cloudProviderFromBrowserbaseSession(browserbaseSession),
        viewport: options.viewport,
        userAgent: options.userAgent,
        stealth: options.stealth,
      });
      await runRecorder.append({
        type: 'session.launch.browser_ready',
        data: summarizeSession(session),
      });

      if (options.url) {
        const browser = await this.connect(session, { runRecorder });
        try {
          await runRecorder.append({
            type: 'session.launch.navigate.start',
            data: { url: options.url },
          });
          const pages = await browser.pages();
          const page = pages[0] ?? (await browser.newPage());
          try {
            await page.bringToFront();
          } catch {
            // Best effort only; launch can still navigate an unfocused page.
          }
          await page.goto(options.url, { waitUntil: 'domcontentloaded' });
          session = touchPersistedMagicBrowseSession(session, {
            activePageIdentity: await readPageIdentity(page),
          });
          await runRecorder.append({
            type: 'session.launch.navigate.complete',
            data: {
              activePageIdentity: session.activePageIdentity,
            },
          });
        } finally {
          await disconnectBrowser(browser);
        }
      }

      await this.store.saveCurrentSession(session);
      await runRecorder.update({
        activePageIdentity: session.activePageIdentity,
      });
      await runRecorder.append({
        type: 'session.launch.complete',
        data: summarizeSession(session),
      });
      return this.toManagedSession(session);
    } catch (error) {
      await runRecorder.append({
        type: 'session.launch.error',
        level: 'error',
        message: errorToMessage(error),
      });
      await runRecorder.update({ status: 'failed' });
      if (browserbaseSession) {
        await browserbase
          .releaseSession({
            sessionId: browserbaseSession.id,
            projectId: browserbaseSession.projectId,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await runRecorder.flush();
    }
  }

  async attach(options: MagicBrowseAttachOptions): Promise<MagicBrowseManagedSession> {
    if (options.cloud || options.cloudSessionId) {
      return this.attachCloud(options);
    }

    const endpoint =
      options.cdpUrl ?? options.endpoint ?? options.browserWSEndpoint ?? options.browserURL;

    if (!endpoint) {
      throw new Error('magicbrowse attach requires a CDP HTTP URL or browser websocket endpoint.');
    }

    const cdpUrl = await resolveAttachEndpoint(endpoint);
    const current = await this.store.loadCurrentSession();
    if (current?.cdpUrl === cdpUrl) {
      const probe = await probeCdpEndpoint(current.cdpUrl, current.browserInstanceRef);
      if (probe === 'match') {
        const runRecorder = await this.ensureSessionRun(current);
        await runRecorder.append({
          type: 'session.attach.reused',
          data: {
            sessionId: current.id,
            runId: runRecorder.runId,
            cdpUrl,
            activePageIdentity: current.activePageIdentity,
          },
        });
        await runRecorder.flush();
        return this.toManagedSession(current);
      }
    }

    const sessionId = this.createSessionId();
    const runRecorder = await this.runStore.createSessionRun({
      sessionId,
      ownership: 'attached',
      cdpUrl,
      instruction: `attach ${cdpUrl}`,
    });
    await runRecorder.append({
      type: 'session.attach.start',
      data: {
        sessionId,
        runId: runRecorder.runId,
        cdpUrl,
      },
    });
    let session = createPersistedMagicBrowseSession({
      id: sessionId,
      runId: runRecorder.runId,
      ownership: 'attached',
      cdpUrl,
      stealth: options.stealth,
    });

    let browser: Browser | undefined;
    try {
      browser = await this.connect(session, { runRecorder });
      const page = await resolveActivePage({ browser });
      session = touchPersistedMagicBrowseSession(session, {
        activePageIdentity: await readPageIdentity(page),
      });
      await runRecorder.append({
        type: 'session.attach.page_resolved',
        data: {
          activePageIdentity: session.activePageIdentity,
        },
      });
      if (current) {
        await this.closeCurrentSession({
          sessionId: current.id,
          ignoreMissing: true,
        });
      }
      await this.store.saveCurrentSession(session);
      await runRecorder.update({
        activePageIdentity: session.activePageIdentity,
      });
      await runRecorder.append({
        type: 'session.attach.complete',
        data: summarizeSession(session),
      });
      return this.toManagedSession(session);
    } catch (error) {
      await runRecorder.append({
        type: 'session.attach.error',
        level: 'error',
        message: errorToMessage(error),
      });
      await runRecorder.update({ status: 'failed' });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  private async attachCloud(options: MagicBrowseAttachOptions): Promise<MagicBrowseManagedSession> {
    const cloudSessionId = options.cloudSessionId?.trim();
    if (!cloudSessionId) {
      throw new Error('magicbrowse attach cloud requires a Browserbase session id.');
    }

    const browserbase = this.resolveBrowserbaseClient();
    const browserbaseSession = await browserbase.getSession(cloudSessionId);
    assertBrowserbaseSessionCanConnect(browserbaseSession, cloudSessionId);
    const connectUrl = requireBrowserbaseConnectUrl(browserbaseSession, cloudSessionId);

    const current = await this.store.loadCurrentSession();
    if (
      current?.cloudProvider?.name === 'browserbase' &&
      current.cloudProvider.sessionId === browserbaseSession.id
    ) {
      const runRecorder = await this.ensureSessionRun(current);
      await runRecorder.append({
        type: 'session.attach.reused',
        data: {
          sessionId: current.id,
          runId: runRecorder.runId,
          cloudProvider: current.cloudProvider,
          activePageIdentity: current.activePageIdentity,
        },
      });
      await runRecorder.flush();
      return this.toManagedSession(current);
    }

    await this.closeCurrentSession({ ignoreMissing: true });
    const sessionId = this.createSessionId();
    const cloudProvider = cloudProviderFromBrowserbaseSession(browserbaseSession);
    const runRecorder = await this.runStore.createSessionRun({
      sessionId,
      ownership: 'attached',
      cloudProvider,
      instruction: `attach cloud ${cloudProvider.sessionId}`,
    });
    await runRecorder.append({
      type: 'session.attach.start',
      data: {
        sessionId,
        runId: runRecorder.runId,
        cloudProvider,
      },
    });
    let session = createPersistedMagicBrowseSession({
      id: sessionId,
      runId: runRecorder.runId,
      ownership: 'attached',
      cdpUrl: connectUrl,
      cloudProvider,
      stealth: options.stealth,
    });

    let browser: Browser | undefined;
    try {
      browser = await this.connect(session, { runRecorder });
      const page = await resolveActivePage({ browser });
      session = touchPersistedMagicBrowseSession(session, {
        activePageIdentity: await readPageIdentity(page),
      });
      await runRecorder.append({
        type: 'session.attach.page_resolved',
        data: {
          activePageIdentity: session.activePageIdentity,
        },
      });
      await this.store.saveCurrentSession(session);
      await runRecorder.update({
        activePageIdentity: session.activePageIdentity,
      });
      await runRecorder.append({
        type: 'session.attach.complete',
        data: summarizeSession(session),
      });
      return this.toManagedSession(session);
    } catch (error) {
      await runRecorder.append({
        type: 'session.attach.error',
        level: 'error',
        message: errorToMessage(error),
      });
      await runRecorder.update({ status: 'failed' });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  async act(options: MagicBrowseActOptions): Promise<MagicBrowseActResult> {
    const session = await this.requireCurrentSession('act', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
    const actId = this.createActId();
    await runRecorder.append({
      type: 'act.start',
      actId,
      data: {
        sessionId: session.id,
        runId: runRecorder.runId,
        goal: options.goal,
        url: options.url,
        maxSteps: options.maxSteps,
        useVision: options.useVision === true,
        activePageIdentity: session.activePageIdentity,
      },
    });
    let browser: Browser | undefined;
    let markerClearReason: 'consumed' | 'expired' | 'page_mismatch' | undefined;
    let latestResolvedPageIdentity = session.activePageIdentity;
    const disconnectCurrentBrowser = createDisconnectCurrentBrowser(() => browser);
    // An act is many steps, each with a model round trip, so it gets the
    // agentic budget rather than the single-action one. An explicit choice —
    // per call, or on the manager — still wins.
    const actionTimeoutMs = normalizeBrowserActionTimeoutMs(
      options.timeoutMs ?? this.configuredBrowserActionTimeoutMs ?? DEFAULT_AGENTIC_ACT_TIMEOUT_MS
    );
    let bufferedRunRecorder: BufferedRunRecorder | undefined;

    try {
      const prepared = await runWithBrowserActionDeadline(
        async (signal) =>
          withAbortedBrowserDisconnect(signal, disconnectCurrentBrowser, async () => {
            bufferedRunRecorder = createBufferedRunRecorder(runRecorder, signal);
            const operationRunRecorder = bufferedRunRecorder.recorder;
            browser = await this.connect(session, {
              runRecorder: operationRunRecorder,
              actId,
            }).catch((error: unknown) => {
              throw createDeadSessionError(error);
            });
            throwIfBrowserActionAborted(signal);
            const page = await resolveActivePage({
              browser,
              activePageIdentity: session.activePageIdentity,
            });
            throwIfBrowserActionAborted(signal);
            await authenticateProxyIfNeeded(page, session.proxy);
            throwIfBrowserActionAborted(signal);
            latestResolvedPageIdentity = await readPageIdentity(page);
            throwIfBrowserActionAborted(signal);
            const safeResolvedPageIdentity = safePageIdentityForPersistence(
              latestResolvedPageIdentity,
              session.redactionProfiles
            );
            await operationRunRecorder.append({
              type: 'act.page_resolved',
              actId,
              data: {
                before: session.activePageIdentity,
                resolved: safeResolvedPageIdentity,
              },
            });
            const markerResolution = resolveTrustedHumanVerificationEvidence({
              marker: session.humanVerificationResolved,
              currentPageIdentity: latestResolvedPageIdentity,
              now: new Date(),
            });
            markerClearReason = markerResolution.clearReason;
            if (markerResolution.clearReason) {
              await operationRunRecorder.append({
                type: 'human_verification.marker.resolved',
                level: markerResolution.evidence ? 'info' : 'debug',
                actId,
                data: {
                  verificationKind: 'captcha',
                  clearReason: markerResolution.clearReason,
                  markerPageIdentity: session.humanVerificationResolved?.pageIdentity,
                  currentPageIdentity: safeResolvedPageIdentity,
                  expiresAt: session.humanVerificationResolved?.expiresAt,
                },
              });
            }
            const loadedAgentState = await this.agentStateStore.loadAgentState(session.id);
            throwIfBrowserActionAborted(signal);
            if (loadedAgentState.warning) {
              await operationRunRecorder.append({
                type: 'agent.state.load.warning',
                level: 'warn',
                actId,
                message: loadedAgentState.warning,
              });
            } else if (loadedAgentState.state) {
              await operationRunRecorder.append({
                type: 'agent.state.loaded',
                level: 'debug',
                actId,
                data: {
                  taskCount: loadedAgentState.state.tasks.length,
                  messageCount: loadedAgentState.state.messageManager.messages.length,
                },
              });
            }
            throwIfBrowserActionAborted(signal);
            const executed = await executeMagicBrowseAct({
              browser,
              page,
              displayHighlights: session.ownership === 'attached' || session.headless === false,
              options: { ...options, timeoutMs: actionTimeoutMs, signal },
              browserActionTimeoutMs: actionTimeoutMs,
              runRecorder: operationRunRecorder,
              actId,
              initialAgentState: loadedAgentState.state,
              redactionProfiles: session.redactionProfiles,
              trustedRuntimeEvidence: markerResolution.evidence
                ? [markerResolution.evidence]
                : undefined,
            });
            throwIfBrowserActionAborted(signal);
            const result = safeActResult(executed.result, session.redactionProfiles);
            if (
              (result.status === 'timed_out' || result.status === 'cancelled') &&
              result.mutationState === 'unknown'
            ) {
              throw new BrowserActionDeadlineError(
                result.status === 'timed_out' ? 'action_timeout' : 'action_cancelled',
                'act',
                result.status === 'timed_out' ? actionTimeoutMs : undefined
              );
            }
            const activePageIdentity = safePageIdentityForPersistence(
              executed.activePageIdentity,
              session.redactionProfiles
            );
            const updatedSession = touchPersistedMagicBrowseSession(session, {
              runId: runRecorder.runId,
              activePageIdentity,
              humanVerificationResolved: markerClearReason ? null : undefined,
            });
            await this.saveSessionIfCurrent(session, updatedSession);
            throwIfBrowserActionAborted(signal);
            const agentStateSaved = await this.agentStateStore.saveAgentStateIfNewer(
              session.id,
              executed.agentState,
              persistedSessionRevision(updatedSession)
            );
            if (!agentStateSaved) {
              throw new SessionAuthorityConflictError('agent_state_commit');
            }
            throwIfBrowserActionAborted(signal);
            return {
              result,
              activePageIdentity,
            };
          }),
        {
          actionName: 'act',
          timeoutMs: actionTimeoutMs,
          signal: options.signal,
          cancel: disconnectCurrentBrowser,
        }
      );

      await bufferedRunRecorder?.recorder.update({
        instruction: options.goal,
        activePageIdentity: prepared.activePageIdentity,
        lastActStatus: prepared.result.status,
        lastFinalUrl: prepared.result.finalUrl,
      });
      await bufferedRunRecorder?.recorder.append({
        type: 'act.complete',
        actId,
        data: {
          status: prepared.result.status,
          finalUrl: prepared.result.finalUrl,
          finalMessage: prepared.result.finalMessage,
          handoff: prepared.result.handoff,
          blockedReason: prepared.result.blockedReason,
          dialog: prepared.result.dialog,
          stepCount: prepared.result.steps.length,
          activePageIdentity: prepared.activePageIdentity,
        },
      });
      if (bufferedRunRecorder) {
        await settleCleanup(bufferedRunRecorder.commit());
      }
      return prepared.result;
    } catch (error) {
      bufferedRunRecorder?.discard();
      if (isBrowserActionDeadlineError(error)) {
        if (!(error instanceof SessionAuthorityConflictError)) {
          await this.fenceTimedOutOperation(session, runRecorder.runId);
        }
        const result = deadlineActResult(error);
        await settleCleanup(
          runRecorder.append({
            type: 'act.timeout',
            level: 'warn',
            actId,
            data: {
              status: result.status,
              retryable: result.retryable,
              mutationState: result.mutationState,
              recovery: result.recovery,
            },
          })
        );
        await settleCleanup(runRecorder.update({ lastActStatus: result.status }));
        return result;
      }
      if (markerClearReason) {
        await this.store.saveCurrentSessionIfRevision(
          touchPersistedMagicBrowseSession(session, {
            runId: runRecorder.runId,
            activePageIdentity: safePageIdentityForPersistence(
              latestResolvedPageIdentity ?? {},
              session.redactionProfiles
            ),
            humanVerificationResolved: null,
          }),
          persistedSessionRevision(session)
        );
      }
      await runRecorder.append({
        type: 'act.error',
        level: 'error',
        actId,
        message: redactSensitiveText(errorToMessage(error), {
          redactionProfiles: session.redactionProfiles,
        }),
      });
      await runRecorder.update({ lastActStatus: 'error' });
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      if (browser) {
        await disconnectCurrentBrowser();
        await settleCleanup(
          runRecorder.append({
            type: 'act.browser_disconnected',
            actId,
          })
        );
      } else {
        await settleCleanup(
          runRecorder.append({
            type: 'act.browser_not_connected',
            level: 'warn',
            actId,
          })
        );
      }
      await settleCleanup(runRecorder.flush());
    }
  }

  async observe(options: MagicBrowseObserveOptions = {}): Promise<MagicBrowseObserveResult> {
    const loadedSession = await this.requireCurrentSession('observe', options.sessionId);
    let session = loadedSession;
    let runRecorder: MagicBrowseRunRecorder | undefined;
    const observeId = this.createObserveId();
    let browser: Browser | undefined;
    const disconnectCurrentBrowser = createDisconnectCurrentBrowser(() => browser);
    const timeoutMs = normalizeBrowserActionTimeoutMs(
      options.timeoutMs ?? this.browserActionTimeoutMs
    );
    let bufferedRunRecorder: BufferedRunRecorder | undefined;

    try {
      const prepared = await runWithBrowserActionDeadline(
        async (signal) =>
          withAbortedBrowserDisconnect(signal, disconnectCurrentBrowser, async () => {
            session = await this.persistOperationRedactionProfiles(
              loadedSession,
              options.redactionProfiles
            );
            throwIfBrowserActionAborted(signal);
            const operationBaseRunRecorder = await this.ensureSessionRun(session);
            runRecorder = operationBaseRunRecorder;
            throwIfBrowserActionAborted(signal);
            if (options.redactionProfiles) {
              await operationBaseRunRecorder.update({
                redactionProfiles: options.redactionProfiles,
              });
              throwIfBrowserActionAborted(signal);
            }
            await operationBaseRunRecorder.append({
              type: 'observe.start',
              actId: observeId,
              data: {
                sessionId: session.id,
                runId: operationBaseRunRecorder.runId,
                activePageIdentity: session.activePageIdentity,
              },
            });
            throwIfBrowserActionAborted(signal);
            bufferedRunRecorder = createBufferedRunRecorder(operationBaseRunRecorder, signal);
            const operationRunRecorder = bufferedRunRecorder.recorder;
            browser = await this.connect(session, {
              runRecorder: operationRunRecorder,
              actId: observeId,
            }).catch((error: unknown) => {
              throw createDeadSessionError(error);
            });
            throwIfBrowserActionAborted(signal);
            const page = await resolveActivePage({
              browser,
              activePageIdentity: session.activePageIdentity,
            });
            throwIfBrowserActionAborted(signal);
            await authenticateProxyIfNeeded(page, session.proxy);
            throwIfBrowserActionAborted(signal);
            const currentPageIdentity = await readPageIdentity(page);
            const resolvedPageIdentity = safePageIdentityForPersistence(
              currentPageIdentity,
              session.redactionProfiles
            );
            const markerResolution = resolveTrustedHumanVerificationEvidence({
              marker: session.humanVerificationResolved,
              currentPageIdentity,
              now: new Date(),
            });
            throwIfBrowserActionAborted(signal);
            await operationRunRecorder.append({
              type: 'observe.page_resolved',
              actId: observeId,
              data: {
                before: session.activePageIdentity,
                resolved: resolvedPageIdentity,
              },
            });
            throwIfBrowserActionAborted(signal);
            const observed = await executeMagicBrowseObserve({
              browser,
              page,
              displayHighlights: session.ownership === 'attached' || session.headless === false,
              includeOrchestration: options.includeOrchestration,
              ...(typeof options.viewportExpansion === 'number'
                ? { viewportExpansion: options.viewportExpansion }
                : {}),
              runRecorder: operationRunRecorder,
              observeId,
              redactionProfiles: session.redactionProfiles,
            });
            throwIfBrowserActionAborted(signal);
            const activePageIdentity = safePageIdentityForPersistence(
              observed.activePageIdentity,
              session.redactionProfiles
            );
            const updatedSession = touchPersistedMagicBrowseSession(session, {
              runId: operationBaseRunRecorder.runId,
              activePageIdentity,
              observationLeases: mergeObservationLeases(
                session.observationLeases,
                observed.observationLeases
              ),
              humanVerificationResolved: markerResolution.clearReason ? null : undefined,
            });
            await this.saveSessionIfCurrent(session, updatedSession);
            throwIfBrowserActionAborted(signal);
            return {
              result: markerResolution.evidence
                ? {
                    ...observed.result,
                    trustedRuntimeEvidence: [markerResolution.evidence],
                  }
                : observed.result,
              activePageIdentity,
            };
          }),
        {
          actionName: 'observe',
          timeoutMs,
          signal: options.signal,
          cancel: disconnectCurrentBrowser,
        }
      );

      await bufferedRunRecorder?.recorder.update({
        activePageIdentity: prepared.activePageIdentity,
      });
      await bufferedRunRecorder?.recorder.append({
        type: 'observe.complete',
        actId: observeId,
        data: {
          plannerViewLength: prepared.result.plannerView.length,
          activePageIdentity: prepared.activePageIdentity,
        },
      });
      if (bufferedRunRecorder) {
        await settleCleanup(bufferedRunRecorder.commit());
      }
      return prepared.result;
    } catch (error) {
      bufferedRunRecorder?.discard();
      if (isBrowserActionDeadlineError(error)) {
        if (!(error instanceof SessionAuthorityConflictError)) {
          await this.fenceTimedOutOperation(session, runRecorder?.runId ?? session.runId);
        }
        if (runRecorder) {
          await settleCleanup(
            runRecorder.append({
              type: 'observe.timeout',
              level: 'warn',
              actId: observeId,
              data: {
                code: error.code,
                retryable: true,
                mutationState: error.mutationState,
                recovery: error.recovery,
              },
            })
          );
        }
        throw error;
      }
      if (runRecorder) {
        await settleCleanup(
          runRecorder.append({
            type: 'observe.error',
            level: 'error',
            actId: observeId,
            message: redactSensitiveText(errorToMessage(error), {
              redactionProfiles: session.redactionProfiles,
            }),
          })
        );
      }
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      await disconnectCurrentBrowser();
      if (runRecorder) {
        if (browser) {
          await settleCleanup(
            runRecorder.append({
              type: 'observe.browser_disconnected',
              actId: observeId,
            })
          );
        } else {
          await settleCleanup(
            runRecorder.append({
              type: 'observe.browser_not_connected',
              level: 'warn',
              actId: observeId,
            })
          );
        }
        await settleCleanup(runRecorder.flush());
      }
    }
  }

  async click(options: MagicBrowseClickOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'click',
      sessionId: options.sessionId,
      viewportExpansion: options.viewportExpansion,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      targetRef: options.target.ref,
      descriptorSignature: targetDescriptorSignature(options.target, 'click'),
      failureReason: 'click_failed',
      run: ({ browserPage, nativeDialog, page, runRecorder, session, observationLease }) =>
        executeMagicBrowseClickAction({
          sessionId: session.id,
          target: options.target,
          page: browserPage,
          runRecorder,
          redactionProfiles: session.redactionProfiles,
          readPageIdentity: async () => readPageIdentity(page),
          nativeDialog,
          observationLease,
          ...(options.progressEvidence ? { progressEvidence: true } : {}),
        }),
    });
  }

  async type(options: MagicBrowseTypeOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'type',
      sessionId: options.sessionId,
      viewportExpansion: options.viewportExpansion,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      redactionProfiles: options.redactionProfiles,
      targetRef: options.target.ref,
      descriptorSignature: targetDescriptorSignature(options.target, 'type'),
      failureReason: 'input_failed',
      run: ({ browserPage, nativeDialog, page, runRecorder, session, observationLease }) =>
        executeMagicBrowseInputAction({
          action: 'type',
          sessionId: session.id,
          target: options.target,
          text: options.text,
          page: browserPage,
          runRecorder,
          redactionProfiles: session.redactionProfiles,
          readPageIdentity: async () => readPageIdentity(page),
          nativeDialog,
          observationLease,
        }),
    });
  }

  async fill(options: MagicBrowseFillOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'fill',
      sessionId: options.sessionId,
      viewportExpansion: options.viewportExpansion,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      redactionProfiles: options.redactionProfiles,
      targetRef: options.target.ref,
      descriptorSignature: targetDescriptorSignature(options.target, 'fill'),
      failureReason: 'input_failed',
      run: ({ browserPage, nativeDialog, page, runRecorder, session, observationLease }) =>
        executeMagicBrowseInputAction({
          action: 'fill',
          sessionId: session.id,
          target: options.target,
          text: options.value,
          page: browserPage,
          runRecorder,
          redactionProfiles: session.redactionProfiles,
          readPageIdentity: async () => readPageIdentity(page),
          nativeDialog,
          observationLease,
        }),
    });
  }

  async select(options: MagicBrowseSelectOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'select',
      sessionId: options.sessionId,
      viewportExpansion: options.viewportExpansion,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      redactionProfiles: options.redactionProfiles,
      targetRef: options.target.ref,
      descriptorSignature: targetDescriptorSignature(options.target, 'select'),
      failureReason: 'select_failed',
      run: ({ browserPage, nativeDialog, page, runRecorder, session, observationLease }) =>
        executeMagicBrowseSelectAction({
          sessionId: session.id,
          target: options.target,
          optionText: options.optionText,
          page: browserPage,
          runRecorder,
          redactionProfiles: session.redactionProfiles,
          readPageIdentity: async () => readPageIdentity(page),
          nativeDialog,
          observationLease,
        }),
    });
  }

  async press(options: MagicBrowsePressOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'press',
      sessionId: options.sessionId,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      failureReason: 'press_failed',
      run: ({ browserPage, nativeDialog, page, runRecorder, session }) =>
        executeMagicBrowsePressAction({
          sessionId: session.id,
          keys: options.keys,
          page: browserPage,
          runRecorder,
          redactionProfiles: session.redactionProfiles,
          readPageIdentity: async () => readPageIdentity(page),
          nativeDialog,
        }),
    });
  }

  async screenshot(
    options: MagicBrowseScreenshotOptions = {}
  ): Promise<MagicBrowseScreenshotResult> {
    const session = await this.requireCurrentSession('screenshot', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
    const outputPath = options.path ?? `/tmp/magicbrowse-screenshot-${Date.now()}.png`;
    let browser: Browser | undefined;

    try {
      browser = await this.connect(session, { runRecorder }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      await page.screenshot({ path: outputPath });
      const activePageIdentity = safePageIdentityForPersistence(
        await readPageIdentity(page),
        session.redactionProfiles
      );
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({ activePageIdentity });
      await runRecorder.append({
        type: 'screenshot.complete',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          path: outputPath,
          activePageIdentity,
        },
      });
      return {
        status: 'captured',
        path: outputPath,
        ...(activePageIdentity.targetId ? { pageRef: `tab:${activePageIdentity.targetId}` } : {}),
        ...(activePageIdentity.url ? { url: activePageIdentity.url } : {}),
        ...(activePageIdentity.title ? { title: activePageIdentity.title } : {}),
      };
    } catch (error) {
      await runRecorder.append({
        type: 'screenshot.error',
        level: 'error',
        message: errorToMessage(error),
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          path: outputPath,
        },
      });
      return {
        status: 'blocked',
        reason: 'screenshot_failed',
        summary: redactSensitiveText(error instanceof Error ? error.message : String(error), {
          redactionProfiles: session.redactionProfiles,
        }),
      };
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  async submitFormTarget(
    options: MagicBrowseSubmitFormTargetOptions
  ): Promise<MagicBrowseSubmitFormTargetResult> {
    const session = await this.requireCurrentSession('submitFormTarget', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
    let browser: Browser | undefined;
    let nativeDialog: NativeBrowserDialogGuard | undefined;

    try {
      browser = await this.connect(session, { runRecorder }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      const browserPage = new BrowserPage(
        page,
        {
          displayHighlights: session.ownership === 'attached' || session.headless === false,
          minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
        },
        INITIAL_BROWSER_TAB_ID
      );
      nativeDialog = attachNativeBrowserDialogGuard(page, {
        runRecorder,
        redactionProfiles: session.redactionProfiles,
      });
      const result = await executeSubmitFormTarget({
        ...options,
        sessionId: session.id,
        page: browserPage,
        runRecorder,
        pageRef: options.target.pageRef,
        readPageIdentity: async () => readPageIdentity(page),
        nativeDialog,
      });
      const activePageIdentity = safePageIdentityForPersistence(
        await readPageIdentity(page),
        session.redactionProfiles
      );
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: updatedSession.activePageIdentity,
      });
      return safePageMetadataResult(result, session.redactionProfiles);
    } catch (error) {
      await runRecorder.append({
        type: 'submit_target.error',
        level: 'error',
        message: 'Submit target click failed before completion.',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          targetRef: options.target.ref,
          status: 'blocked',
          reason: 'submit_failed',
        },
      });
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      nativeDialog?.detach();
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  async markCaptchaResolved(
    options: MagicBrowseMarkCaptchaResolvedOptions = {}
  ): Promise<MagicBrowseMarkCaptchaResolvedResult> {
    const session = await this.requireCurrentSession('mark-captcha-resolved', options.sessionId);
    const ttlSeconds = normalizeMarkerTtlSeconds(options.ttlSeconds);
    const runRecorder = await this.ensureSessionRun(session);
    await runRecorder.append({
      type: 'human_verification.mark.start',
      data: {
        sessionId: session.id,
        runId: runRecorder.runId,
        verificationKind: 'captcha',
        ttlSeconds,
      },
    });
    let browser: Browser | undefined;

    try {
      browser = await this.connect(session, { runRecorder }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      const pageIdentity = safePageIdentityForPersistence(
        await readPageIdentity(page),
        session.redactionProfiles
      );
      const resolvedAt = new Date();
      const marker: MagicBrowseHumanVerificationResolvedMarker = {
        kind: 'humanVerificationResolved',
        verificationKind: 'captcha',
        pageIdentity,
        resolvedAt: resolvedAt.toISOString(),
        expiresAt: new Date(resolvedAt.getTime() + ttlSeconds * 1000).toISOString(),
        source: 'orchestrator',
      };
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: pageIdentity,
        humanVerificationResolved: marker,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: pageIdentity,
      });
      await runRecorder.append({
        type: 'human_verification.mark.complete',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          marker,
        },
      });
      return {
        status: 'marked',
        sessionId: session.id,
        ...(runRecorder.runId ? { runId: runRecorder.runId } : {}),
        marker,
      };
    } catch (error) {
      await runRecorder.append({
        type: 'human_verification.mark.error',
        level: 'error',
        message: redactSensitiveText(errorToMessage(error), {
          redactionProfiles: session.redactionProfiles,
        }),
      });
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
        await runRecorder.append({
          type: 'human_verification.mark.browser_disconnected',
        });
      }
      await runRecorder.flush();
    }
  }

  async close(options: MagicBrowseCloseOptions = {}): Promise<void> {
    await this.closeCurrentSession({
      sessionId: options.sessionId,
      ignoreMissing: false,
    });
  }

  async currentSession(): Promise<MagicBrowseManagedSession | undefined> {
    const session = await this.store.loadCurrentSession();
    return session ? this.toManagedSession(session) : undefined;
  }

  async status(): Promise<MagicBrowseStatusResult> {
    const session = await this.store.loadCurrentSession();

    if (!session) {
      return {
        success: true,
        alive: false,
        outcomeType: 'browser_not_running',
      };
    }

    const runRecorder = await this.ensureSessionRun(session);
    await runRecorder.append({
      type: 'status.start',
      data: statusSessionMetadata(session, runRecorder.runId),
    });

    let browser: Browser | undefined;
    try {
      if (isBrowserbaseSession(session)) {
        const cloudSession = await this.resolveBrowserbaseClient()
          .getSession(session.cloudProvider.sessionId)
          .catch(() => undefined);
        if (!cloudSession || !browserbaseStatusCanConnect(cloudSession.status)) {
          return await this.finishStatus(runRecorder, session, {
            ...statusSessionMetadata(session, runRecorder.runId),
            success: true,
            alive: false,
            outcomeType: 'browser_not_running',
          });
        }

        const browserConnectResult = await this.connectForDiagnostics(session);
        if (browserConnectResult.status !== 'connected') {
          return await this.finishStatus(runRecorder, session, {
            ...statusSessionMetadata(session, runRecorder.runId),
            success: true,
            alive: true,
            outcomeType: 'browser_alive',
            currentPageUnresolved: true,
            diagnosticReason:
              browserConnectResult.status === 'timed_out'
                ? 'browser_connect_timeout'
                : 'browser_connect_failed',
          });
        }
        browser = browserConnectResult.browser;

        return await this.finishConnectedStatus(runRecorder, session, browser);
      }

      const probe = await probeCdpEndpoint(session.cdpUrl, session.browserInstanceRef);
      if (probe === 'unreachable') {
        return await this.finishStatus(runRecorder, session, {
          ...statusSessionMetadata(session, runRecorder.runId),
          success: true,
          alive: false,
          outcomeType: 'browser_not_running',
        });
      }

      if (probe === 'mismatch') {
        return await this.finishStatus(runRecorder, session, {
          ...statusSessionMetadata(session, runRecorder.runId),
          success: true,
          alive: false,
          outcomeType: 'browser_mismatch',
        });
      }

      const fallbackPageIdentity = await readPageIdentityFromCdpList(session);
      return await this.finishStatus(
        runRecorder,
        session,
        buildAliveStatusResult(session, runRecorder.runId, fallbackPageIdentity, {
          currentPageUnresolved: fallbackPageIdentity ? undefined : true,
        })
      );
    } catch {
      return await this.finishStatus(runRecorder, session, {
        ...statusSessionMetadata(session, runRecorder.runId),
        success: true,
        alive: false,
        outcomeType: 'browser_not_running',
      });
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  private async finishConnectedStatus(
    runRecorder: MagicBrowseRunRecorder,
    session: PersistedMagicBrowseSession,
    browser: Browser
  ): Promise<MagicBrowseStatusResult> {
    const pageIdentityResolution = await readConnectedStatusPageIdentityWithTimeout(
      browser,
      session.activePageIdentity
    );

    if (pageIdentityResolution.status === 'resolved') {
      return await this.finishStatus(
        runRecorder,
        session,
        buildAliveStatusResult(
          session,
          runRecorder.runId,
          pageIdentityResolution.activePageIdentity
        )
      );
    }

    if (pageIdentityResolution.status === 'timed_out') {
      const fallbackPageIdentity = isBrowserbaseSession(session)
        ? undefined
        : await readPageIdentityFromCdpList(session);
      return await this.finishStatus(
        runRecorder,
        session,
        buildAliveStatusResult(session, runRecorder.runId, fallbackPageIdentity, {
          currentPageUnresolved: fallbackPageIdentity ? undefined : true,
          diagnosticReason: 'page_resolution_timeout',
        })
      );
    }

    return await this.finishStatus(runRecorder, session, {
      ...statusSessionMetadata(session, runRecorder.runId),
      success: true,
      alive: true,
      outcomeType: 'browser_alive',
      currentPageUnresolved: true,
    });
  }

  /**
   * Navigate the current session's active page to a URL without any LLM
   * involvement (same primitive execute-act uses for its entry URL). Lets
   * orchestration layers (replay) reuse a live browser across flows instead
   * of paying a fresh launch per flow. Throws when no session exists.
   */
  async navigateCurrentSession(url: string, sessionId?: string): Promise<void> {
    const session = await this.loadCurrentSessionForDeterministicAction(sessionId);
    if (!session) {
      throw new Error('navigateCurrentSession requires an existing session');
    }
    const runRecorder = await this.ensureSessionRun(session);
    let browser: Browser | undefined;
    try {
      browser = await this.connect(session, { runRecorder });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const activePageIdentity = safePageIdentityForPersistence(
        await readPageIdentity(page),
        session.redactionProfiles
      );
      await this.store.saveCurrentSession(
        touchPersistedMagicBrowseSession(session, {
          runId: runRecorder.runId,
          activePageIdentity,
        })
      );
      await runRecorder.update({ activePageIdentity });
      await runRecorder.append({
        type: 'session.navigate',
        level: 'info',
        message: redactSensitiveText(url, {
          redactionProfiles: session.redactionProfiles,
        }),
      });
    } catch (error) {
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  /**
   * Append a custom event to the current session's run record. Used by
   * orchestration layers (replay) to leave telemetry markers alongside the
   * events the runtime already records; a no-op when no session exists.
   */
  async recordSessionRunEvent(event: {
    readonly type: string;
    readonly message?: string;
    readonly data?: unknown;
  }): Promise<void> {
    const session = await this.loadCurrentSessionForDeterministicAction(undefined);
    if (!session) {
      return;
    }
    const runRecorder = await this.ensureSessionRun(session);
    await runRecorder.append({
      type: event.type,
      level: 'info',
      ...(event.message
        ? {
            message: redactSensitiveText(event.message, {
              redactionProfiles: session.redactionProfiles,
            }),
          }
        : {}),
      ...(event.data !== undefined
        ? {
            data: redactSensitiveValue(event.data, {
              redactionProfiles: session.redactionProfiles,
            }),
          }
        : {}),
    });
    await runRecorder.flush();
  }

  private async executeDeterministicCurrentSession(input: {
    readonly action: MagicBrowseDeterministicActionVerb;
    readonly sessionId?: string;
    readonly viewportExpansion?: number;
    readonly redactionProfiles?: ExactValueRedactionProfiles;
    readonly targetRef?: string;
    readonly descriptorSignature?: string;
    readonly failureReason: MagicBrowseDeterministicActionBlockedReason;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly run: (context: {
      readonly session: PersistedMagicBrowseSession;
      readonly runRecorder: MagicBrowseRunRecorder;
      readonly page: Page;
      readonly browserPage: BrowserPage;
      readonly nativeDialog: Pick<
        NativeBrowserDialogGuard,
        'lastDialog' | 'blockingDialog' | 'settle'
      >;
      readonly observationLease?: TargetObservationLease;
    }) => Promise<MagicBrowseDeterministicActionResult>;
  }): Promise<MagicBrowseDeterministicActionResult> {
    const loadedSession = await this.loadCurrentSessionForDeterministicAction(input.sessionId);
    if (!loadedSession) {
      return buildMagicBrowseDeterministicActionBlockedResult({
        action: input.action,
        reason: 'missing_session',
        targetRef: input.targetRef,
      });
    }

    let session = loadedSession;
    let runRecorder: MagicBrowseRunRecorder | undefined;
    let browser: Browser | undefined;
    let nativeDialog: NativeBrowserDialogGuard | undefined;
    const disconnectCurrentBrowser = createDisconnectCurrentBrowser(() => browser);
    const timeoutMs = normalizeBrowserActionTimeoutMs(
      input.timeoutMs ?? this.browserActionTimeoutMs
    );
    let bufferedRunRecorder: BufferedRunRecorder | undefined;

    try {
      const prepared = await runWithBrowserActionDeadline(
        async (signal) =>
          withAbortedBrowserDisconnect(signal, disconnectCurrentBrowser, async () => {
            session = await this.persistOperationRedactionProfiles(
              loadedSession,
              input.redactionProfiles
            );
            const claimed = await this.claimObservationLease(session, {
              action: input.action,
              targetRef: input.targetRef,
              descriptorSignature: input.descriptorSignature,
            });
            session = claimed.session;
            throwIfBrowserActionAborted(signal);
            const operationBaseRunRecorder = await this.ensureSessionRun(session);
            runRecorder = operationBaseRunRecorder;
            throwIfBrowserActionAborted(signal);
            bufferedRunRecorder = createBufferedRunRecorder(operationBaseRunRecorder, signal);
            const operationRunRecorder = bufferedRunRecorder.recorder;
            if (input.redactionProfiles) {
              await operationRunRecorder.update({
                redactionProfiles: input.redactionProfiles,
              });
              throwIfBrowserActionAborted(signal);
            }
            browser = await this.connect(session, {
              runRecorder: operationRunRecorder,
            }).catch((error: unknown) => {
              throw createDeadSessionError(error);
            });
            throwIfBrowserActionAborted(signal);
            const page = await resolveActivePage({
              browser,
              activePageIdentity: session.activePageIdentity,
            });
            throwIfBrowserActionAborted(signal);
            await authenticateProxyIfNeeded(page, session.proxy);
            throwIfBrowserActionAborted(signal);
            const browserPage = new BrowserPage(
              page,
              {
                displayHighlights: session.ownership === 'attached' || session.headless === false,
                minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
                ...(typeof input.viewportExpansion === 'number'
                  ? { viewportExpansion: input.viewportExpansion }
                  : {}),
              },
              INITIAL_BROWSER_TAB_ID
            );
            nativeDialog = attachNativeBrowserDialogGuard(page, {
              runRecorder: operationRunRecorder,
              redactionProfiles: session.redactionProfiles,
              omitMessage: isProtectedDeterministicWrite(input.action),
            });
            throwIfBrowserActionAborted(signal);
            const result = await input.run({
              session,
              runRecorder: operationRunRecorder,
              page,
              browserPage,
              nativeDialog,
              observationLease: claimed.lease,
            });
            throwIfBrowserActionAborted(signal);
            const livePageIdentity = await readPageIdentity(page);
            throwIfBrowserActionAborted(signal);
            const activePageIdentity = isProtectedDeterministicWrite(input.action)
              ? protectedWritePageIdentity(livePageIdentity, session.redactionProfiles)
              : safePageIdentityForPersistence(livePageIdentity, session.redactionProfiles);
            const updatedSession = touchPersistedMagicBrowseSession(session, {
              runId: operationBaseRunRecorder.runId,
              activePageIdentity,
            });
            await this.saveSessionIfCurrent(session, updatedSession);
            throwIfBrowserActionAborted(signal);
            return {
              result: safePageMetadataResult(result, session.redactionProfiles),
              activePageIdentity,
            };
          }),
        {
          actionName: input.action,
          timeoutMs,
          signal: input.signal,
          cancel: disconnectCurrentBrowser,
        }
      );

      await bufferedRunRecorder?.recorder.update({
        activePageIdentity: prepared.activePageIdentity,
      });
      if (bufferedRunRecorder) {
        await settleCleanup(bufferedRunRecorder.commit());
      }
      return prepared.result;
    } catch (error) {
      bufferedRunRecorder?.discard();
      if (isBrowserActionDeadlineError(error)) {
        if (!(error instanceof SessionAuthorityConflictError)) {
          await this.fenceTimedOutOperation(session, runRecorder?.runId ?? session.runId);
        }
        const result = deadlineBlockedActionResult(input, error);
        if (runRecorder) {
          await settleCleanup(
            runRecorder.append({
              type: 'deterministic_action.timeout',
              level: 'warn',
              data: {
                sessionId: session.id,
                runId: runRecorder.runId,
                action: result.action,
                status: result.status,
                targetRef: result.targetRef,
                reason: result.reason,
                retryable: result.retryable,
                mutationState: result.mutationState,
                recovery: result.recovery,
              },
            })
          );
        }
        return result;
      }
      if (nativeDialog) {
        await settleCleanup(nativeDialog.settle());
      }
      const dialog = nativeDialog?.blockingDialog();
      const browserDisconnected = isBrowserDisconnectedError(error);
      const result = buildMagicBrowseDeterministicActionBlockedResult({
        action: input.action,
        reason: dialog
          ? 'browser_dialog_open'
          : browserDisconnected
            ? 'browser_disconnected'
            : input.failureReason,
        targetRef: input.targetRef,
        ...(dialog ? { dialog } : {}),
        ...(browserDisconnected
          ? {
              retryable: true,
              mutationState: 'unknown',
              recovery: 'fresh_observe_required',
            }
          : {}),
      });
      if (runRecorder) {
        await settleCleanup(
          runRecorder.append({
            type: 'deterministic_action.blocked',
            level: 'warn',
            data: {
              sessionId: session.id,
              runId: runRecorder.runId,
              action: result.action,
              status: result.status,
              targetRef: result.targetRef,
              reason: result.reason,
              dialog: result.dialog,
              summary: result.summary,
            },
          })
        );
      }
      return result;
    } finally {
      nativeDialog?.detach();
      await disconnectCurrentBrowser();
      if (runRecorder) {
        await settleCleanup(runRecorder.flush());
      }
    }
  }

  private async invalidateSessionPageAuthority(
    session: PersistedMagicBrowseSession,
    runId?: string
  ): Promise<boolean> {
    return this.store.invalidateCurrentSessionPageAuthorityThroughRevision(
      session.id,
      persistedSessionRevision(session) + 1,
      runId
    );
  }

  private async fenceTimedOutOperation(
    session: PersistedMagicBrowseSession,
    runId?: string
  ): Promise<void> {
    const maxRevision = persistedSessionRevision(session) + 1;
    await settleCleanup(
      Promise.all([
        this.invalidateSessionPageAuthority(session, runId),
        this.agentStateStore.clearAgentStateThroughRevision(session.id, maxRevision),
      ])
    );
  }

  private async saveSessionIfCurrent(
    current: PersistedMagicBrowseSession,
    updated: PersistedMagicBrowseSession
  ): Promise<void> {
    const saved = await this.store.saveCurrentSessionIfRevision(
      updated,
      persistedSessionRevision(current)
    );
    if (!saved) {
      throw new SessionAuthorityConflictError('session_authority_commit');
    }
  }

  private async claimObservationLease(
    session: PersistedMagicBrowseSession,
    input: {
      readonly action: MagicBrowseDeterministicActionVerb;
      readonly targetRef?: string;
      readonly descriptorSignature?: string;
    }
  ): Promise<{
    readonly session: PersistedMagicBrowseSession;
    readonly lease?: TargetObservationLease;
  }> {
    if (!input.descriptorSignature || !['click', 'fill', 'type', 'select'].includes(input.action)) {
      return { session };
    }
    const index = (session.observationLeases ?? []).findIndex(
      (lease) =>
        lease.action === input.action &&
        lease.descriptorSignature === input.descriptorSignature &&
        (!input.targetRef || lease.targetRef === input.targetRef)
    );
    if (index < 0) return { session };
    const lease = session.observationLeases?.[index];
    if (!lease) return { session };
    if (lease.consumed) return { session, lease };
    const leases = [...(session.observationLeases ?? [])];
    leases[index] = { ...lease, consumed: true };
    const updated = touchPersistedMagicBrowseSession(session, { observationLeases: leases });
    await this.saveSessionIfCurrent(session, updated);
    return { session: updated, lease };
  }

  private async loadCurrentSessionForDeterministicAction(
    sessionId: string | undefined
  ): Promise<PersistedMagicBrowseSession | undefined> {
    const session = await this.store.loadCurrentSession();
    if (!session) {
      return undefined;
    }
    if (sessionId && session.id !== sessionId) {
      return undefined;
    }
    return session;
  }

  private async persistOperationRedactionProfiles(
    session: PersistedMagicBrowseSession,
    redactionProfiles: ExactValueRedactionProfiles | undefined
  ): Promise<PersistedMagicBrowseSession> {
    if (!redactionProfiles || Object.keys(redactionProfiles).length === 0) {
      return session;
    }

    const profiledSession = touchPersistedMagicBrowseSession(session, {
      redactionProfiles,
    });
    const mergedProfiles = profiledSession.redactionProfiles;
    const activePageIdentity = profiledSession.activePageIdentity
      ? safePageIdentityForPersistence(profiledSession.activePageIdentity, mergedProfiles)
      : undefined;
    const markerPageIdentity = profiledSession.humanVerificationResolved
      ? safePageIdentityForPersistence(
          profiledSession.humanVerificationResolved.pageIdentity,
          mergedProfiles
        )
      : undefined;
    const {
      activePageIdentity: _activePageIdentity,
      humanVerificationResolved: _marker,
      ...base
    } = profiledSession;
    const updatedSession: PersistedMagicBrowseSession = {
      ...base,
      ...(activePageIdentity && hasPersistablePageIdentity(activePageIdentity)
        ? { activePageIdentity }
        : {}),
      ...(profiledSession.humanVerificationResolved &&
      markerPageIdentity &&
      hasPersistablePageIdentity(markerPageIdentity)
        ? {
            humanVerificationResolved: {
              ...profiledSession.humanVerificationResolved,
              pageIdentity: markerPageIdentity,
            },
          }
        : {}),
    };
    const saved = await this.store.saveCurrentSessionIfRevision(
      updatedSession,
      persistedSessionRevision(session)
    );
    if (!saved) {
      throw new SessionAuthorityConflictError('redaction_profile_commit');
    }
    return updatedSession;
  }

  private async closeCurrentSession(input: {
    readonly sessionId?: string;
    readonly ignoreMissing: boolean;
  }): Promise<void> {
    const session = await this.store.loadCurrentSession();

    if (!session) {
      if (input.ignoreMissing) {
        return;
      }
      throw new Error('magicbrowse close requires an active current session.');
    }

    if (input.sessionId && session.id !== input.sessionId) {
      throw new Error(`magicbrowse close could not find current session ${input.sessionId}.`);
    }

    const runRecorder = await this.ensureSessionRun(session);
    try {
      await runRecorder.append({
        type: 'session.close.start',
        data: summarizeSession(session),
      });
      if (isBrowserbaseSession(session)) {
        await this.resolveBrowserbaseClient().releaseSession({
          sessionId: session.cloudProvider.sessionId,
          projectId: session.cloudProvider.projectId,
        });
        await runRecorder.append({
          type: 'session.close.cloud_released',
          data: {
            sessionId: session.id,
            runId: runRecorder.runId,
            cloudProvider: session.cloudProvider,
          },
        });
        await runRecorder.update({
          status: 'closed',
          closedAt: new Date().toISOString(),
        });
      } else if (session.ownership === 'owned') {
        const browserConnectResult = await this.connectForOwnedClose(session);
        if (browserConnectResult.status === 'connected') {
          const browser = browserConnectResult.browser;
          const closeResult = await closeBrowserWithTimeout(
            browser,
            OWNED_BROWSER_PUPPETEER_CLOSE_TIMEOUT_MS
          );
          if (closeResult === 'closed') {
            await runRecorder.append({
              type: 'session.close.browser_closed',
              data: { sessionId: session.id },
            });
          } else {
            // The process-level close below is authoritative for owned browsers.
            await runRecorder.append({
              type:
                closeResult === 'timed_out'
                  ? 'session.close.browser_close_timeout'
                  : 'session.close.browser_close_failed',
              level: 'warn',
              data: { sessionId: session.id },
            });
            await disconnectBrowser(browser);
          }
        } else if (browserConnectResult.status === 'timed_out') {
          await runRecorder.append({
            type: 'session.close.browser_connect_timeout',
            level: 'warn',
            data: { sessionId: session.id },
          });
        } else {
          await runRecorder.append({
            type: 'session.close.browser_connect_failed',
            level: 'warn',
            data: { sessionId: session.id },
          });
        }
        await this.launcher.close({ cdpUrl: session.cdpUrl, pid: session.pid });
        // The per-session Chrome profile is dead weight once the browser is
        // gone; without this every launch leaves its user-data directory behind.
        await this.launcher.discardSessionProfile(session.id);
        await runRecorder.append({
          type: 'session.close.complete',
          data: { sessionId: session.id, runId: runRecorder.runId },
        });
        await runRecorder.update({
          status: 'closed',
          closedAt: new Date().toISOString(),
        });
      } else {
        await runRecorder.append({
          type: 'session.close.detach',
          data: summarizeSession(session),
        });
        await runRecorder.update({
          status: 'closed',
          closedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      await runRecorder.append({
        type: 'session.close.error',
        level: 'error',
        message: errorToMessage(error),
        data: { sessionId: session.id, runId: runRecorder.runId },
      });
      await runRecorder.update({ status: 'failed' });
      throw safeOperationError(error, session.redactionProfiles);
    } finally {
      await runRecorder.flush();
      await this.store.clearCurrentSession(session.id);
      await this.agentStateStore.clearAgentState(session.id);
    }
  }

  private async requireCurrentSession(
    command: string,
    sessionId: string | undefined
  ): Promise<PersistedMagicBrowseSession> {
    const session = await this.store.loadCurrentSession();

    if (!session) {
      throw new Error(
        `magicbrowse ${command} requires an active current session. Run magicbrowse launch [url] or magicbrowse attach <endpoint> first.`
      );
    }

    if (sessionId && session.id !== sessionId) {
      throw new Error(`magicbrowse ${command} could not find current session ${sessionId}.`);
    }

    return session;
  }

  private async connect(
    session: PersistedMagicBrowseSession,
    options: {
      readonly runRecorder?: MagicBrowseRunRecorder;
      readonly actId?: string;
    } = {}
  ): Promise<Browser> {
    if (isBrowserbaseSession(session)) {
      await assertBrowserbaseSessionStillConnectable(session, this.resolveBrowserbaseClient());
      const client = this.resolveClient(session.stealth);
      return client.connect(
        this.buildConnectOptions(session, {
          browserWSEndpoint: session.cdpUrl,
        })
      );
    }
    await assertSessionEndpointStillMatches(session);

    if (shouldPreferLocalCdpFallbackConnect(session)) {
      try {
        return await this.connectLocalCdpFallbackAndRecord(session, options, {
          eventType: 'browser_connect.initial_targets_recovery_reused',
          preference: session.localCdpConnectPreference,
        });
      } catch (error) {
        await options.runRecorder?.append({
          type: 'browser_connect.initial_targets_recovery_reuse_failed',
          level: 'warn',
          actId: options.actId,
          message: errorToMessage(error),
          data: {
            sessionId: session.id,
            reason: session.localCdpConnectPreference.reason,
            fallbackStrategy: session.localCdpConnectPreference.strategy,
            recoveredAt: session.localCdpConnectPreference.recoveredAt,
          },
        });
        await this.updateLocalCdpConnectPreference(session, null);
      }
    }

    const connectResult = await this.connectPublicBrowserWithTimeout(
      session,
      LOCAL_BROWSER_CONNECT_TIMEOUT_MS
    );

    if (connectResult.status === 'connected') {
      return connectResult.browser;
    }

    if (connectResult.status === 'failed') {
      throw connectResult.error;
    }

    const recoveredAt = new Date().toISOString();
    const preference = {
      strategy: LOCAL_CDP_FALLBACK_STRATEGY,
      reason: LOCAL_CDP_FALLBACK_REASON,
      recoveredAt,
    };
    const browser = await this.connectLocalCdpFallbackAndRecord(session, options, {
      eventType: 'browser_connect.initial_targets_recovered',
      preference,
      publicConnectTimeoutMs: LOCAL_BROWSER_CONNECT_TIMEOUT_MS,
    });
    await this.updateLocalCdpConnectPreference(session, preference);
    return browser;
  }

  private async connectLocalCdpFallbackAndRecord(
    session: PersistedMagicBrowseSession,
    options: {
      readonly runRecorder?: MagicBrowseRunRecorder;
      readonly actId?: string;
    },
    event: {
      readonly eventType:
        | 'browser_connect.initial_targets_recovered'
        | 'browser_connect.initial_targets_recovery_reused';
      readonly preference: NonNullable<PersistedMagicBrowseSession['localCdpConnectPreference']>;
      readonly publicConnectTimeoutMs?: number;
    }
  ): Promise<Browser> {
    const browser = await this.connectLocalCdpWithoutInitialTargetWait({
      cdpUrl: session.cdpUrl,
      defaultViewport: connectDefaultViewport(session),
      protocolTimeoutMs: LOCAL_CDP_FALLBACK_PROTOCOL_TIMEOUT_MS,
    });
    const activePageIdentity = await waitForRecoverablePageIdentity(
      browser,
      session.activePageIdentity
    );
    await options.runRecorder?.append({
      type: event.eventType,
      level: event.eventType === 'browser_connect.initial_targets_recovered' ? 'warn' : 'info',
      actId: options.actId,
      data: {
        sessionId: session.id,
        reason: event.preference.reason,
        fallbackStrategy: event.preference.strategy,
        recoveredAt: event.preference.recoveredAt,
        ...(event.publicConnectTimeoutMs !== undefined
          ? {
              timeoutMs: event.publicConnectTimeoutMs,
              publicConnectTimeoutMs: event.publicConnectTimeoutMs,
            }
          : {}),
        ...(activePageIdentity ? { activePageIdentity } : {}),
      },
    });
    return browser;
  }

  private async updateLocalCdpConnectPreference(
    session: PersistedMagicBrowseSession,
    preference: PersistedMagicBrowseSession['localCdpConnectPreference'] | null
  ): Promise<PersistedMagicBrowseSession> {
    let updatedSession = touchPersistedMagicBrowseSession(session, {
      localCdpConnectPreference: preference,
    });
    updatedSession = {
      ...updatedSession,
      ...(session.revision !== undefined ? { revision: session.revision } : {}),
    };
    if (session.revision === undefined) {
      const { revision: _revision, ...withoutRevision } = updatedSession;
      updatedSession = withoutRevision;
    }
    const mutableSession = session as MutablePersistedMagicBrowseSession;
    Object.assign(mutableSession, updatedSession);
    if (!updatedSession.localCdpConnectPreference) {
      delete mutableSession.localCdpConnectPreference;
    }
    return updatedSession;
  }

  private async connectPublicBrowserWithTimeout(
    session: PersistedMagicBrowseSession,
    timeoutMs: number
  ): Promise<BrowserConnectWithTimeoutResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let transport: ConnectionTransport | undefined;
    const client = this.resolveClient(session.stealth);
    const connectTask = Promise.resolve()
      .then(async () => {
        if (this.puppeteer) {
          return await client.connect(
            this.buildConnectOptions(session, {
              browserWSEndpoint: session.cdpUrl,
            })
          );
        }

        transport = await NodeWebSocketTransport.create(session.cdpUrl);
        return await client.connect(this.buildConnectOptions(session, { transport }));
      })
      .then(
        (browser) => ({ status: 'connected' as const, browser }),
        (error: unknown) => ({ status: 'failed' as const, error })
      );
    const timeoutTask = new Promise<{ readonly status: 'timed_out' }>((resolve) => {
      timeout = setTimeout(() => {
        transport?.close();
        resolve({ status: 'timed_out' as const });
      }, timeoutMs);
    });

    const result = await Promise.race([connectTask, timeoutTask]);

    try {
      return result;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (result.status !== 'connected') {
        void connectTask.then(
          async (lateResult) => {
            if (lateResult.status === 'connected') {
              await disconnectBrowser(lateResult.browser);
            }
          },
          () => undefined
        );
      }
    }
  }

  private async connectForDiagnostics(
    session: PersistedMagicBrowseSession
  ): Promise<BrowserConnectWithTimeoutResult> {
    return this.connectWithTimeout(session, DIAGNOSTIC_BROWSER_CONNECT_TIMEOUT_MS);
  }

  private async connectForOwnedClose(
    session: PersistedMagicBrowseSession
  ): Promise<BrowserConnectWithTimeoutResult> {
    return this.connectWithTimeout(session, OWNED_BROWSER_CLOSE_CONNECT_TIMEOUT_MS);
  }

  private async connectWithTimeout(
    session: PersistedMagicBrowseSession,
    timeoutMs: number
  ): Promise<BrowserConnectWithTimeoutResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let transport: ConnectionTransport | undefined;
    const connectTask = Promise.resolve()
      .then(async () => {
        if (this.puppeteer) {
          if (isBrowserbaseSession(session)) {
            await assertBrowserbaseSessionStillConnectable(
              session,
              this.resolveBrowserbaseClient()
            );
          } else {
            await assertSessionEndpointStillMatches(session);
          }
          const client = this.resolveClient(session.stealth);
          return await client.connect(
            this.buildConnectOptions(session, {
              browserWSEndpoint: session.cdpUrl,
            })
          );
        }

        if (isBrowserbaseSession(session)) {
          await assertBrowserbaseSessionStillConnectable(session, this.resolveBrowserbaseClient());
        } else {
          await assertSessionEndpointStillMatches(session);
        }

        const client = this.resolveClient(session.stealth);
        transport = await NodeWebSocketTransport.create(session.cdpUrl);
        return await client.connect(this.buildConnectOptions(session, { transport }));
      })
      .then(
        (browser) => ({ status: 'connected' as const, browser }),
        (error: unknown) => ({ status: 'failed' as const, error })
      );
    const timeoutTask = new Promise<{ readonly status: 'timed_out' }>((resolve) => {
      timeout = setTimeout(() => {
        transport?.close();
        resolve({ status: 'timed_out' as const });
      }, timeoutMs);
    });

    const result = await Promise.race([connectTask, timeoutTask]);

    try {
      return result;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (result.status !== 'connected') {
        void connectTask.then(
          async (lateResult) => {
            if (lateResult.status === 'connected') {
              await disconnectBrowser(lateResult.browser);
            }
          },
          () => undefined
        );
      }
    }
  }

  private buildConnectOptions(
    session: PersistedMagicBrowseSession,
    endpoint: { readonly browserWSEndpoint: string } | { readonly transport: ConnectionTransport }
  ): ConnectOptions {
    return {
      ...endpoint,
      defaultViewport: session.viewport
        ? { width: session.viewport.width, height: session.viewport.height }
        : null,
    };
  }

  private resolveClient(stealth: boolean | undefined): MagicBrowsePuppeteerClient {
    if (this.puppeteer) {
      return this.puppeteer;
    }

    return stealth === false ? plainPuppeteer : getDefaultMagicBrowseStealthPuppeteerClient();
  }

  private resolveBrowserbaseClient(): BrowserbaseClient {
    return this.browserbase ?? createBrowserbaseClient();
  }

  private toManagedSession(session: PersistedMagicBrowseSession): MagicBrowseManagedSession {
    return {
      id: session.id,
      sessionId: session.id,
      ...(session.runId ? { runId: session.runId } : {}),
      ownership: session.ownership,
      cdpUrl: session.cdpUrl,
      ...(session.cloudProvider ? { cloudProvider: session.cloudProvider } : {}),
      ...(typeof session.pid === 'number' ? { pid: session.pid } : {}),
      ...(session.profile ? { profile: session.profile } : {}),
      ...(session.activePageIdentity ? { activePageIdentity: session.activePageIdentity } : {}),
      ...(session.humanVerificationResolved
        ? { humanVerificationResolved: session.humanVerificationResolved }
        : {}),
      ...(session.redactionProfiles ? { redactionProfiles: session.redactionProfiles } : {}),
      observe: (options = {}) => this.observe({ ...options, sessionId: session.id }),
      act: (options) => this.act({ ...options, sessionId: session.id }),
      markCaptchaResolved: (options = {}) =>
        this.markCaptchaResolved({ ...options, sessionId: session.id }),
      screenshot: (options = {}) => this.screenshot({ ...options, sessionId: session.id }),
      click: (options) => this.click({ ...options, sessionId: session.id }),
      type: (options) => this.type({ ...options, sessionId: session.id }),
      fill: (options) => this.fill({ ...options, sessionId: session.id }),
      select: (options) => this.select({ ...options, sessionId: session.id }),
      press: (options) => this.press({ ...options, sessionId: session.id }),
      submitFormTarget: (options) => this.submitFormTarget({ ...options, sessionId: session.id }),
      close: () => this.close({ sessionId: session.id }),
    };
  }

  private async ensureSessionRun(
    session: PersistedMagicBrowseSession
  ): Promise<MagicBrowseRunRecorder> {
    const runRecorder = await this.runStore.getOrCreateSessionRun({
      sessionId: session.id,
      runId: session.runId,
      ownership: session.ownership,
      cloudProvider: session.cloudProvider,
      cdpUrl: isBrowserbaseSession(session) ? undefined : session.cdpUrl,
      pid: session.pid,
      profile: session.profile,
      activePageIdentity: session.activePageIdentity,
      redactionProfiles: session.redactionProfiles,
    });
    if (session.redactionProfiles && Object.keys(session.redactionProfiles).length > 0) {
      await runRecorder.update({
        redactionProfiles: session.redactionProfiles,
      });
    }
    return runRecorder;
  }

  private async finishStatus(
    runRecorder: MagicBrowseRunRecorder,
    session: PersistedMagicBrowseSession,
    result: MagicBrowseStatusResult
  ): Promise<MagicBrowseStatusResult> {
    const safeResult = safeStatusPageMetadata(result, session.redactionProfiles);
    const redactedResult = {
      ...(redactSensitiveValue(safeResult, {
        redactionProfiles: session.redactionProfiles,
      }) as MagicBrowseStatusResult),
      ...preservedMachineIdentityFields(safeResult),
    } as MagicBrowseStatusResult;
    await runRecorder.append({
      type: 'status.complete',
      data: redactedResult,
    });
    return redactedResult;
  }
}

function mergeObservationLeases(
  existing: PersistedMagicBrowseSession['observationLeases'],
  observed: PersistedMagicBrowseSession['observationLeases']
): NonNullable<PersistedMagicBrowseSession['observationLeases']> {
  const retained = [...(existing ?? [])].filter((lease) => !lease.consumed);
  const keys = new Set(
    retained.map(
      (lease) =>
        `${lease.pageRef}:${lease.documentRef}:${lease.action}:${lease.descriptorSignature}`
    )
  );
  for (const lease of observed ?? []) {
    const key = `${lease.pageRef}:${lease.documentRef}:${lease.action}:${lease.descriptorSignature}`;
    if (!keys.has(key)) {
      retained.push(lease);
      keys.add(key);
    }
  }
  return retained.slice(0, 1024);
}

function isProtectedDeterministicWrite(action: MagicBrowseDeterministicActionVerb): boolean {
  return action === 'fill' || action === 'type' || action === 'select';
}

function safePageIdentityForPersistence(
  identity: MagicBrowseActivePageIdentity,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseActivePageIdentity {
  if (!redactionProfiles || Object.keys(redactionProfiles).length === 0) {
    return identity;
  }

  const safeUrl = identity.url
    ? safePageUrlForPersistence(identity.url, redactionProfiles)
    : undefined;
  return {
    ...(identity.targetId ? { targetId: identity.targetId } : {}),
    ...(identity.documentRef ? { documentRef: identity.documentRef } : {}),
    ...(safeUrl ? { url: safeUrl } : {}),
  };
}

function hasPersistablePageIdentity(identity: MagicBrowseActivePageIdentity): boolean {
  return Boolean(identity.targetId || identity.documentRef || identity.url);
}

function safeStatusPageMetadata(
  result: MagicBrowseStatusResult,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseStatusResult {
  return safePageMetadataResult(result, redactionProfiles);
}

// Machine identifiers are never user content. Redacting them corrupts the
// equality checks callers run on them — a short protected value once rewrote
// the digits inside `sessionId`, so a caller's liveness check compared a
// mangled id and declared a healthy browser unavailable.
const MACHINE_IDENTITY_RESULT_FIELDS = ['sessionId', 'runId', 'pageRef'] as const;

function preservedMachineIdentityFields(result: object): Record<string, string> {
  const preserved: Record<string, string> = {};
  for (const key of MACHINE_IDENTITY_RESULT_FIELDS) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      preserved[key] = value;
    }
  }
  return preserved;
}

function safePageMetadataResult<T extends { readonly url?: string; readonly title?: string }>(
  result: T,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): T {
  if (!redactionProfiles || Object.keys(redactionProfiles).length === 0) {
    return result;
  }

  const { url, title: _title, ...rest } = result;
  const redacted = redactSensitiveValue(rest, { redactionProfiles }) as T;
  const safeUrl = url ? safePageUrlForPersistence(url, redactionProfiles) : undefined;
  return {
    ...redacted,
    ...preservedMachineIdentityFields(result),
    ...(safeUrl ? { url: safeUrl } : {}),
  };
}

function safeActResult(
  result: MagicBrowseActResult,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseActResult {
  if (!redactionProfiles || Object.keys(redactionProfiles).length === 0) {
    return result;
  }

  const redacted = redactSensitiveValue(result, {
    redactionProfiles,
  }) as MagicBrowseActResult;
  return {
    ...redacted,
    finalUrl: safePageUrlForPersistence(result.finalUrl, redactionProfiles) ?? '',
  };
}

function protectedWritePageIdentity(
  identity: MagicBrowseActivePageIdentity,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseActivePageIdentity {
  if (redactionProfiles && Object.keys(redactionProfiles).length > 0) {
    return safePageIdentityForPersistence(identity, redactionProfiles);
  }

  return {
    ...(identity.targetId ? { targetId: identity.targetId } : {}),
    ...(identity.documentRef ? { documentRef: identity.documentRef } : {}),
  };
}

function safePageUrlForPersistence(
  value: string,
  redactionProfiles: ExactValueRedactionProfiles
): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    if (pathMayContainProtectedValue(parsed.pathname, redactionProfiles)) {
      return undefined;
    }

    const safeUrl = `${parsed.origin}${parsed.pathname}`;
    return redactSensitiveText(safeUrl, { redactionProfiles }) === safeUrl ? safeUrl : undefined;
  } catch {
    return undefined;
  }
}

function pathMayContainProtectedValue(
  pathname: string,
  redactionProfiles: ExactValueRedactionProfiles
): boolean {
  let candidate = pathname;
  for (let depth = 0; depth < 5; depth += 1) {
    if (redactSensitiveText(candidate, { redactionProfiles }) !== candidate) {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) {
      return false;
    }
    candidate = decoded;
  }
  return true;
}

function safeOperationError(
  error: unknown,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): unknown {
  if (!redactionProfiles || Object.keys(redactionProfiles).length === 0) {
    return error;
  }
  return new Error(
    redactSensitiveText(errorToMessage(error), {
      redactionProfiles,
    })
  );
}

function cloudProviderFromBrowserbaseSession(
  session: BrowserbaseSession
): NonNullable<PersistedMagicBrowseSession['cloudProvider']> {
  return {
    name: 'browserbase',
    sessionId: session.id,
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.region ? { region: session.region } : {}),
  };
}

async function assertBrowserbaseSessionStillConnectable(
  session: PersistedMagicBrowseSession & {
    readonly cloudProvider: NonNullable<PersistedMagicBrowseSession['cloudProvider']>;
  },
  browserbase: BrowserbaseClient
): Promise<void> {
  const cloudSession = await browserbase.getSession(session.cloudProvider.sessionId);
  assertBrowserbaseSessionCanConnect(cloudSession, session.cloudProvider.sessionId);
}

function assertBrowserbaseSessionCanConnect(
  session: Pick<BrowserbaseSession, 'status'>,
  sessionId: string
): void {
  if (browserbaseStatusCanConnect(session.status)) {
    return;
  }
  throw new Error(`Browserbase session ${sessionId} is not connectable: ${session.status}.`);
}

function requireBrowserbaseConnectUrl(session: BrowserbaseSession, sessionId: string): string {
  if (session.connectUrl) {
    return session.connectUrl;
  }
  throw new Error(`Browserbase session ${sessionId} did not return a connectUrl.`);
}

function browserbaseStatusCanConnect(status: BrowserbaseSession['status']): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

async function assertSessionEndpointStillMatches(
  session: PersistedMagicBrowseSession
): Promise<void> {
  const probe = await probeCdpEndpoint(session.cdpUrl, session.browserInstanceRef);

  if (probe === 'match') {
    return;
  }

  if (probe === 'mismatch') {
    throw new Error(
      `CDP endpoint belongs to a different browser instance than persisted session ${session.id}.`
    );
  }

  throw new Error(`CDP endpoint is unreachable for persisted session ${session.id}.`);
}

function deadlineBlockedActionResult(
  input: {
    readonly action: MagicBrowseDeterministicActionVerb;
    readonly targetRef?: string;
  },
  error: BrowserActionDeadlineError
): MagicBrowseDeterministicActionResult {
  return buildMagicBrowseDeterministicActionBlockedResult({
    action: input.action,
    reason: error.code,
    targetRef: input.targetRef,
    retryable: true,
    mutationState: 'unknown',
    recovery: 'fresh_observe_required',
  });
}

function deadlineActResult(error: BrowserActionDeadlineError): MagicBrowseActResult {
  return {
    status: error.code === 'action_timeout' ? 'timed_out' : 'cancelled',
    steps: [],
    finalUrl: '',
    finalMessage: error.code,
    retryable: true,
    mutationState: 'unknown',
    recovery: 'fresh_observe_required',
  };
}

function throwIfBrowserActionAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new BrowserActionDeadlineError('action_cancelled', 'browser_action');
}

async function withAbortedBrowserDisconnect<T>(
  signal: AbortSignal,
  disconnect: () => Promise<void>,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } finally {
    if (signal.aborted) {
      await disconnect();
    }
  }
}

interface BufferedRunRecorder {
  readonly recorder: MagicBrowseRunRecorder;
  commit(): Promise<void>;
  discard(): void;
}

type BufferedRunMutation =
  | { readonly kind: 'append'; readonly event: MagicBrowseRunEventInput }
  | { readonly kind: 'update'; readonly input: MagicBrowseRunUpdateInput };

function createBufferedRunRecorder(
  runRecorder: MagicBrowseRunRecorder,
  signal: AbortSignal
): BufferedRunRecorder {
  const mutations: BufferedRunMutation[] = [];
  let accepting = !signal.aborted;
  const discard = () => {
    accepting = false;
    mutations.length = 0;
  };
  signal.addEventListener('abort', discard, { once: true });

  const recorder: MagicBrowseRunRecorder = {
    runId: runRecorder.runId,
    sessionId: runRecorder.sessionId,
    append: async (event) => {
      if (accepting && !signal.aborted) {
        mutations.push({ kind: 'append', event });
      }
    },
    update: async (input) => {
      if (accepting && !signal.aborted) {
        mutations.push({ kind: 'update', input });
      }
    },
    createDebugSink: (actId) => ({
      write: (line) => {
        if (accepting && !signal.aborted) {
          mutations.push({
            kind: 'append',
            event: {
              type: 'debug.line',
              level: 'debug',
              message: line,
              ...(actId ? { actId } : {}),
            },
          });
        }
      },
    }),
    flush: async () => undefined,
  };

  return {
    recorder,
    discard,
    async commit() {
      if (!accepting || signal.aborted) {
        discard();
        return;
      }
      accepting = false;
      signal.removeEventListener('abort', discard);
      const pending = mutations.splice(0);
      for (const mutation of pending) {
        if (mutation.kind === 'append') {
          await runRecorder.append(mutation.event);
        } else {
          await runRecorder.update(mutation.input);
        }
      }
    },
  };
}

function createDisconnectCurrentBrowser(
  readBrowser: () => Browser | undefined
): () => Promise<void> {
  let disconnectedBrowser: Browser | undefined;
  let disconnectTask: Promise<void> | undefined;
  return async () => {
    const browser = readBrowser();
    if (!browser) {
      return;
    }
    if (browser !== disconnectedBrowser) {
      disconnectedBrowser = browser;
      disconnectTask = disconnectBrowser(browser);
    }
    await disconnectTask;
  };
}

function isBrowserDisconnectedError(error: unknown): boolean {
  return /browser.*disconnect|target closed|session closed|connection closed/i.test(
    errorToMessage(error)
  );
}

async function settleCleanup(
  task: Promise<unknown>,
  timeoutMs = BROWSER_OPERATION_CLEANUP_TIMEOUT_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settledTask = Promise.resolve(task).then(
    () => undefined,
    () => undefined
  );
  const timeoutTask = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([settledTask, timeoutTask]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    void settledTask.catch(() => undefined);
  }
}

export function createMagicBrowseSessionManager(
  options: MagicBrowseSessionManagerOptions = {}
): MagicBrowseSessionManager {
  return new MagicBrowseSessionManager(options);
}

async function disconnectBrowser(browser: Browser): Promise<void> {
  await settleCleanup(disconnectBrowserOnce(browser));
}

async function connectLocalCdpWithoutInitialTargetWait(
  input: MagicBrowseLocalCdpFallbackConnectInput
): Promise<Browser> {
  let transport: NodeWebSocketTransport | undefined;
  let connection: Connection | undefined;

  try {
    transport = await NodeWebSocketTransport.create(input.cdpUrl);
    connection = new Connection(input.cdpUrl, transport, 0, input.protocolTimeoutMs);
    const version = await connection.send('Browser.getVersion');
    const product = version.product.toLowerCase().includes('firefox') ? 'firefox' : 'chrome';
    const { browserContextIds } = await connection.send('Target.getBrowserContexts');

    return (await CdpBrowser._create(
      product,
      connection,
      browserContextIds,
      false,
      input.defaultViewport,
      undefined,
      undefined,
      async () => {
        await connection?.send('Browser.close').catch(() => undefined);
      },
      undefined,
      undefined,
      false
    )) as unknown as Browser;
  } catch (error) {
    connection?.dispose();
    transport?.close();
    throw error;
  }
}

function connectDefaultViewport(
  session: PersistedMagicBrowseSession
): ConnectOptions['defaultViewport'] {
  return session.viewport
    ? { width: session.viewport.width, height: session.viewport.height }
    : null;
}

function shouldPreferLocalCdpFallbackConnect(
  session: PersistedMagicBrowseSession
): session is PersistedMagicBrowseSession & {
  readonly localCdpConnectPreference: NonNullable<
    PersistedMagicBrowseSession['localCdpConnectPreference']
  >;
} {
  return session.localCdpConnectPreference?.strategy === LOCAL_CDP_FALLBACK_STRATEGY;
}

async function waitForRecoverablePageIdentity(
  browser: Browser,
  activePageIdentity: MagicBrowseActivePageIdentity | undefined
): Promise<MagicBrowseActivePageIdentity | undefined> {
  const deadline = Date.now() + LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_TIMEOUT_MS;

  while (true) {
    const page = await findRecoverablePage(browser, activePageIdentity);
    if (page) {
      return await readPageIdentity(page);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }

    await sleep(Math.min(LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_POLL_MS, remainingMs));
  }
}

async function findRecoverablePage(
  browser: Browser,
  activePageIdentity: MagicBrowseActivePageIdentity | undefined
): Promise<Page | undefined> {
  const pages = await browser.pages();

  if (activePageIdentity?.targetId) {
    for (const page of pages) {
      if ((await readPageTargetId(page)) === activePageIdentity.targetId) {
        return page;
      }
    }
    return undefined;
  }

  if (activePageIdentity?.url || activePageIdentity?.title) {
    for (const page of pages) {
      const title = await safeReadPageTitle(page);
      const urlMatches = !activePageIdentity.url || page.url() === activePageIdentity.url;
      const titleMatches = !activePageIdentity.title || title === activePageIdentity.title;

      if (urlMatches && titleMatches) {
        return page;
      }
    }
    return undefined;
  }

  const meaningfulPages = pages.filter((page) => isMeaningfulHttpPageUrl(page.url()));
  return meaningfulPages.length === 1 ? meaningfulPages[0] : undefined;
}

async function safeReadPageTitle(page: Page): Promise<string | undefined> {
  try {
    const title = await page.title();
    return title.trim().length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeBrowserWithTimeout(
  browser: Browser,
  timeoutMs: number
): Promise<'closed' | 'failed' | 'timed_out'> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const closeTask = Promise.resolve()
    .then(() => browser.close())
    .then(
      () => 'closed' as const,
      () => 'failed' as const
    );
  const timeoutTask = new Promise<'timed_out'>((resolve) => {
    timeout = setTimeout(() => resolve('timed_out'), timeoutMs);
  });

  try {
    return await Promise.race([closeTask, timeoutTask]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    void closeTask.catch(() => undefined);
  }
}

async function authenticateProxyIfNeeded(
  page: Page,
  proxy: MagicBrowseProxyConfig | undefined
): Promise<void> {
  if (!proxy?.username || proxy.password === undefined) {
    return;
  }

  await page.authenticate({
    username: proxy.username,
    password: proxy.password,
  });
}

function createDefaultSessionId(): string {
  return `magicbrowse-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultActId(): string {
  return `act-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultObserveId(): string {
  return `observe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDeadSessionError(error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(
    `The persisted browser session is no longer running. Launch or attach a fresh browser first. Cause: ${cause}`
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
