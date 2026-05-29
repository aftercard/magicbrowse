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
  MagicBrowseTrustedRuntimeEvidence,
} from '../types.js';
import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import { redactSensitiveValue } from '../redaction.js';
import {
  fillOpenDataTarget as executeFillOpenDataTarget,
  type FillOpenDataTargetInput,
  type FillOpenDataTargetResult,
} from '../resolution/fill-open-data.js';
import {
  fillProtectedGroup as executeFillProtectedGroup,
  type MagicBrowseProtectedFillTargetDescriptor,
  type MagicBrowseProtectedFieldWriter,
  type FillProtectedGroupInput,
  type FillProtectedGroupResult,
} from '../resolution/fill-protected.js';
import {
  buildMagicBrowseDeterministicActionBlockedResult,
  executeMagicBrowseClickAction,
  executeMagicBrowseInputAction,
  executeMagicBrowsePressAction,
  executeMagicBrowseSelectAction,
} from '../resolution/deterministic-actions.js';
import type { MagicBrowseMatchGroupCandidate, MagicBrowseMatchReadyGroupResult } from '../resolution/match.js';
import {
  buildResolveFieldTargetDescriptors,
  type BrowserStateResolveFieldTargetDescriptor,
} from '../resolution/targets.js';
import { submitFormTarget as executeSubmitFormTarget } from '../resolution/submit-target.js';
import { executeMagicBrowseAct } from '../runtime/execute-act.js';
import { executeMagicBrowseObserve } from '../runtime/execute-observe.js';
import BrowserPage, { DropdownOptionValueNotFoundError } from '../vendor/browser/page.js';
import {
  createFileAgentSessionStateStore,
  type AgentSessionStateStore,
} from './agent-session-store.js';
import {
  buildCdpHttpEndpointUrl,
  probeCdpEndpoint,
  resolveAttachEndpoint,
} from './attach-endpoint.js';
import {
  createDetachedChromeBrowserLauncher,
  normalizeProxySetting,
  type OwnedBrowserLauncher,
} from './owned-browser-launcher.js';
import {
  readPageIdentity,
  readPageTargetId,
  resolveActivePage,
  resolveActivePageForDiagnostics,
} from './page-resolver.js';
import {
  createFileMagicBrowseSessionStore,
  createPersistedMagicBrowseSession,
  type MagicBrowseSessionStore,
  type PersistedMagicBrowseSession,
  touchPersistedMagicBrowseSession,
} from './session-store.js';
import {
  createFileMagicBrowseRunStore,
  type MagicBrowseRunRecorder,
  type MagicBrowseRunStore,
} from './run-store.js';
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
}

const plainPuppeteer = puppeteer as unknown as MagicBrowsePuppeteerClient;
const LOCAL_BROWSER_CONNECT_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_BROWSER_CONNECT_TIMEOUT_MS = 8_000;
const DIAGNOSTIC_PAGE_RESOLUTION_TIMEOUT_MS = 8_000;
const LOCAL_CDP_FALLBACK_PROTOCOL_TIMEOUT_MS = 3_000;
const LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_TIMEOUT_MS = 2_000;
const LOCAL_CDP_FALLBACK_PAGE_DISCOVERY_POLL_MS = 50;
const LOCAL_CDP_FALLBACK_STRATEGY = 'without_initial_target_wait' as const;
const LOCAL_CDP_FALLBACK_REASON = 'public_connect_timeout' as const;
const OWNED_BROWSER_PUPPETEER_CLOSE_TIMEOUT_MS = 2_000;
const OWNED_BROWSER_CLOSE_CONNECT_TIMEOUT_MS = 2_000;
export const DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS = 300;

type BrowserConnectWithTimeoutResult =
  | { readonly status: 'connected'; readonly browser: Browser }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timed_out' };

type StatusPageIdentityResolution =
  | { readonly status: 'resolved'; readonly activePageIdentity: MagicBrowseActivePageIdentity }
  | { readonly status: 'unresolved' | 'failed' | 'timed_out' };

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
        await this.launcher.close({ cdpUrl: launched.cdpUrl, pid: launched.pid }).catch(() => undefined);
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
        await this.closeCurrentSession({ sessionId: current.id, ignoreMissing: true });
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
    if (current?.cloudProvider?.name === 'browserbase' && current.cloudProvider.sessionId === browserbaseSession.id) {
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

    try {
      browser = await this.connect(session, { runRecorder, actId }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      latestResolvedPageIdentity = await readPageIdentity(page);
      await runRecorder.append({
        type: 'act.page_resolved',
        actId,
        data: {
          before: session.activePageIdentity,
          resolved: latestResolvedPageIdentity,
        },
      });
      const markerResolution = resolveTrustedHumanVerificationEvidence({
        marker: session.humanVerificationResolved,
        currentPageIdentity: latestResolvedPageIdentity,
        now: new Date(),
      });
      markerClearReason = markerResolution.clearReason;
      if (markerResolution.clearReason) {
        await runRecorder.append({
          type: 'human_verification.marker.resolved',
          level: markerResolution.evidence ? 'info' : 'debug',
          actId,
          data: {
            verificationKind: 'captcha',
            clearReason: markerResolution.clearReason,
            markerPageIdentity: session.humanVerificationResolved?.pageIdentity,
            currentPageIdentity: latestResolvedPageIdentity,
            expiresAt: session.humanVerificationResolved?.expiresAt,
          },
        });
      }
      const loadedAgentState = await this.agentStateStore.loadAgentState(session.id);
      if (loadedAgentState.warning) {
        await runRecorder.append({
          type: 'agent.state.load.warning',
          level: 'warn',
          actId,
          message: loadedAgentState.warning,
        });
      } else if (loadedAgentState.state) {
        await runRecorder.append({
          type: 'agent.state.loaded',
          level: 'debug',
          actId,
          data: {
            taskCount: loadedAgentState.state.tasks.length,
            messageCount: loadedAgentState.state.messageManager.messages.length,
          },
        });
      }
      const executed = await executeMagicBrowseAct({
        browser,
        page,
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        options,
        runRecorder,
        actId,
        initialAgentState: loadedAgentState.state,
        protectedRedactionProfiles: session.protectedRedactionProfiles,
        trustedRuntimeEvidence: markerResolution.evidence
          ? [markerResolution.evidence]
          : undefined,
      });
      await this.agentStateStore.saveAgentState(session.id, executed.agentState);
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: executed.activePageIdentity,
        humanVerificationResolved: markerClearReason ? null : undefined,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        instruction: options.goal,
        activePageIdentity: executed.activePageIdentity,
        lastActStatus: executed.result.status,
        lastFinalUrl: executed.result.finalUrl,
      });
      await runRecorder.append({
        type: 'act.complete',
        actId,
        data: {
          status: executed.result.status,
          finalUrl: executed.result.finalUrl,
          finalMessage: executed.result.finalMessage,
          handoff: executed.result.handoff,
          stepCount: executed.result.steps.length,
          activePageIdentity: executed.activePageIdentity,
        },
      });
      return executed.result;
    } catch (error) {
      if (markerClearReason) {
        await this.store.saveCurrentSession(
          touchPersistedMagicBrowseSession(session, {
            runId: runRecorder.runId,
            activePageIdentity: latestResolvedPageIdentity,
            humanVerificationResolved: null,
          })
        );
      }
      await runRecorder.append({
        type: 'act.error',
        level: 'error',
        actId,
        message: errorToMessage(error),
      });
      await runRecorder.update({ lastActStatus: 'error' });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
        await runRecorder.append({
          type: 'act.browser_disconnected',
          actId,
        });
      } else {
        await runRecorder.append({
          type: 'act.browser_not_connected',
          level: 'warn',
          actId,
        });
      }
      await runRecorder.flush();
    }
  }

  async observe(options: MagicBrowseObserveOptions = {}): Promise<MagicBrowseObserveResult> {
    const session = await this.requireCurrentSession('observe', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
    const observeId = this.createObserveId();
    await runRecorder.append({
      type: 'observe.start',
      actId: observeId,
      data: {
        sessionId: session.id,
        runId: runRecorder.runId,
        activePageIdentity: session.activePageIdentity,
      },
    });
    let browser: Browser | undefined;

    try {
      browser = await this.connect(session, { runRecorder, actId: observeId }).catch(
        (error: unknown) => {
          throw createDeadSessionError(error);
        }
      );
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      await runRecorder.append({
        type: 'observe.page_resolved',
        actId: observeId,
        data: {
          before: session.activePageIdentity,
          resolved: await readPageIdentity(page),
        },
      });
      const observed = await executeMagicBrowseObserve({
        browser,
        page,
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        includeOrchestration: options.includeOrchestration,
        ...(typeof options.viewportExpansion === 'number'
          ? { viewportExpansion: options.viewportExpansion }
          : {}),
        runRecorder,
        observeId,
        protectedRedactionProfiles: session.protectedRedactionProfiles,
      });
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: observed.activePageIdentity,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: observed.activePageIdentity,
      });
      await runRecorder.append({
        type: 'observe.complete',
        actId: observeId,
        data: {
          plannerViewLength: observed.result.plannerView.length,
          activePageIdentity: observed.activePageIdentity,
        },
      });
      return observed.result;
    } catch (error) {
      await runRecorder.append({
        type: 'observe.error',
        level: 'error',
        actId: observeId,
        message: errorToMessage(error),
      });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
        await runRecorder.append({
          type: 'observe.browser_disconnected',
          actId: observeId,
        });
      } else {
        await runRecorder.append({
          type: 'observe.browser_not_connected',
          level: 'warn',
          actId: observeId,
        });
      }
      await runRecorder.flush();
    }
  }

  async fillOpenDataTarget(options: FillOpenDataTargetInput): Promise<FillOpenDataTargetResult> {
    const session = await this.requireCurrentSession('fillOpenDataTarget', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
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
      const browserPage = new BrowserPage(page, {
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
      });
      const { runRecorder: _callerRecorder, ...fillInput } = options;
      const result = await executeFillOpenDataTarget({
        ...fillInput,
        sessionId: session.id,
        page: browserPage,
        runRecorder,
      });
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: await readPageIdentity(page),
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: updatedSession.activePageIdentity,
      });
      return result;
    } catch (error) {
      await runRecorder.append({
        type: 'open_data_fill.error',
        level: 'error',
        message: 'Open-data field fill failed before completion.',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          targetRef: options.target.ref,
          status: 'blocked',
          reason: 'fill_failed',
        },
      });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  async click(options: MagicBrowseClickOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'click',
      sessionId: options.sessionId,
      targetRef: options.target.ref,
      failureReason: 'click_failed',
      run: ({ browserPage, page, runRecorder, session }) =>
        executeMagicBrowseClickAction({
          sessionId: session.id,
          target: options.target,
          page: browserPage,
          runRecorder,
          readPageIdentity: async () => readPageIdentity(page),
        }),
    });
  }

  async type(options: MagicBrowseTypeOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'type',
      sessionId: options.sessionId,
      targetRef: options.target.ref,
      failureReason: 'input_failed',
      run: ({ browserPage, page, runRecorder, session }) =>
        executeMagicBrowseInputAction({
          action: 'type',
          sessionId: session.id,
          target: options.target,
          text: options.text,
          page: browserPage,
          runRecorder,
          readPageIdentity: async () => readPageIdentity(page),
        }),
    });
  }

  async fill(options: MagicBrowseFillOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'fill',
      sessionId: options.sessionId,
      targetRef: options.target.ref,
      failureReason: 'input_failed',
      run: ({ browserPage, page, runRecorder, session }) =>
        executeMagicBrowseInputAction({
          action: 'fill',
          sessionId: session.id,
          target: options.target,
          text: options.value,
          page: browserPage,
          runRecorder,
          readPageIdentity: async () => readPageIdentity(page),
        }),
    });
  }

  async select(options: MagicBrowseSelectOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'select',
      sessionId: options.sessionId,
      targetRef: options.target.ref,
      failureReason: 'select_failed',
      run: ({ browserPage, page, runRecorder, session }) =>
        executeMagicBrowseSelectAction({
          sessionId: session.id,
          target: options.target,
          optionText: options.optionText,
          page: browserPage,
          runRecorder,
          readPageIdentity: async () => readPageIdentity(page),
        }),
    });
  }

  async press(options: MagicBrowsePressOptions): Promise<MagicBrowseDeterministicActionResult> {
    return this.executeDeterministicCurrentSession({
      action: 'press',
      sessionId: options.sessionId,
      failureReason: 'press_failed',
      run: ({ browserPage, page, runRecorder, session }) =>
        executeMagicBrowsePressAction({
          sessionId: session.id,
          keys: options.keys,
          page: browserPage,
          runRecorder,
          readPageIdentity: async () => readPageIdentity(page),
        }),
    });
  }

  async fillProtectedGroup(options: FillProtectedGroupInput): Promise<FillProtectedGroupResult> {
    const session = await this.requireCurrentSession('fillProtectedGroup', options.sessionId);
    const runRecorder = await this.ensureSessionRun(session);
    let browser: Browser | undefined;
    const collectedProfiles: NonNullable<PersistedMagicBrowseSession['protectedRedactionProfiles']> = {};

    try {
      browser = await this.connect(session, { runRecorder }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      const browserPage = new BrowserPage(page, {
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
      });
      const state = await browserPage.getState(false);
      const descriptors = buildResolveFieldTargetDescriptors(state);
      const targets = protectedTargetsForSubject(options.subject.fields, descriptors);
      const readyMatch = readyGroupMatch(options.match);
      if (!readyMatch) {
        return blockedProtectedGroupResult(options, 'match_not_ready');
      }
      const candidate = protectedCandidateForMatch(readyMatch, options.candidates);
      if (!candidate) {
        return blockedProtectedGroupResult(options, 'unknown_candidate_ref');
      }

      const result = await executeFillProtectedGroup({
        artifactRef: readyMatch.artifactRef,
        subject: {
          ...options.subject,
          fields: readyMatch.fields ?? options.subject.fields,
        },
        candidate: {
          ...candidate,
          ...(readyMatch.fieldPolicies ? { fieldPolicies: readyMatch.fieldPolicies } : {}),
        },
        targets,
        artifactReader: options.artifactReader,
        ...(options.assistiveResolver ? { assistiveResolver: options.assistiveResolver } : {}),
        writer: createProtectedFieldWriter(browserPage, descriptors),
        runRecorder,
        redactionProfileRef: readyMatch.artifactRef,
        onProtectedRedactionProfile: (profileRef, profile) => {
          collectedProfiles[profileRef] = profile;
        },
      });

      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: await readPageIdentity(page),
        protectedRedactionProfiles:
          Object.keys(collectedProfiles).length > 0 ? collectedProfiles : undefined,
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: updatedSession.activePageIdentity,
        protectedRedactionProfiles:
          Object.keys(collectedProfiles).length > 0 ? collectedProfiles : undefined,
      });
      return result;
    } catch (error) {
      await runRecorder.append({
        type: 'protected_fill.error',
        level: 'error',
        message: 'Protected group fill failed before completion.',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          fillRef: options.subject.fillRef,
          status: 'blocked',
          reason: 'fill_failed',
        },
      });
      throw error;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
  }

  async screenshot(options: MagicBrowseScreenshotOptions = {}): Promise<MagicBrowseScreenshotResult> {
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
      const activePageIdentity = await readPageIdentity(page);
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
        summary: error instanceof Error ? error.message : String(error),
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

    try {
      browser = await this.connect(session, { runRecorder }).catch((error: unknown) => {
        throw createDeadSessionError(error);
      });
      const page = await resolveActivePage({
        browser,
        activePageIdentity: session.activePageIdentity,
      });
      await authenticateProxyIfNeeded(page, session.proxy);
      const browserPage = new BrowserPage(page, {
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
      });
      const result = await executeSubmitFormTarget({
        ...options,
        sessionId: session.id,
        page: browserPage,
        runRecorder,
        pageRef: options.target.pageRef,
        readPageIdentity: async () => readPageIdentity(page),
      });
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: await readPageIdentity(page),
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: updatedSession.activePageIdentity,
      });
      return result;
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
      throw error;
    } finally {
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
      const pageIdentity = await readPageIdentity(page);
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
        message: errorToMessage(error),
      });
      throw error;
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
    await this.closeCurrentSession({ sessionId: options.sessionId, ignoreMissing: false });
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

  private async executeDeterministicCurrentSession(input: {
    readonly action: MagicBrowseDeterministicActionVerb;
    readonly sessionId?: string;
    readonly targetRef?: string;
    readonly failureReason: MagicBrowseDeterministicActionBlockedReason;
    readonly run: (context: {
      readonly session: PersistedMagicBrowseSession;
      readonly runRecorder: MagicBrowseRunRecorder;
      readonly page: Page;
      readonly browserPage: BrowserPage;
    }) => Promise<MagicBrowseDeterministicActionResult>;
  }): Promise<MagicBrowseDeterministicActionResult> {
    const session = await this.loadCurrentSessionForDeterministicAction(input.sessionId);
    if (!session) {
      return buildMagicBrowseDeterministicActionBlockedResult({
        action: input.action,
        reason: 'missing_session',
        targetRef: input.targetRef,
      });
    }

    const runRecorder = await this.ensureSessionRun(session);
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
      const browserPage = new BrowserPage(page, {
        displayHighlights: session.ownership === 'attached' || session.headless === false,
        minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
      });
      const result = await input.run({
        session,
        runRecorder,
        page,
        browserPage,
      });
      const updatedSession = touchPersistedMagicBrowseSession(session, {
        runId: runRecorder.runId,
        activePageIdentity: await readPageIdentity(page),
      });
      await this.store.saveCurrentSession(updatedSession);
      await runRecorder.update({
        activePageIdentity: updatedSession.activePageIdentity,
      });
      return result;
    } catch {
      const result = buildMagicBrowseDeterministicActionBlockedResult({
        action: input.action,
        reason: input.failureReason,
        targetRef: input.targetRef,
      });
      await runRecorder.append({
        type: 'deterministic_action.blocked',
        level: 'warn',
        data: {
          sessionId: session.id,
          runId: runRecorder.runId,
          action: result.action,
          status: result.status,
          targetRef: result.targetRef,
          reason: result.reason,
          summary: result.summary,
        },
      });
      return result;
    } finally {
      if (browser) {
        await disconnectBrowser(browser);
      }
      await runRecorder.flush();
    }
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
          const closeResult = await closeBrowserWithTimeout(browser, OWNED_BROWSER_PUPPETEER_CLOSE_TIMEOUT_MS);
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
      throw error;
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
    options: { readonly runRecorder?: MagicBrowseRunRecorder; readonly actId?: string } = {}
  ): Promise<Browser> {
    if (isBrowserbaseSession(session)) {
      await assertBrowserbaseSessionStillConnectable(session, this.resolveBrowserbaseClient());
      const client = this.resolveClient(session.stealth);
      return client.connect(this.buildConnectOptions(session, { browserWSEndpoint: session.cdpUrl }));
    } else {
      await assertSessionEndpointStillMatches(session);
    }

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
    options: { readonly runRecorder?: MagicBrowseRunRecorder; readonly actId?: string },
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
    const activePageIdentity = await waitForRecoverablePageIdentity(browser, session.activePageIdentity);
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
    const updatedSession = touchPersistedMagicBrowseSession(session, {
      localCdpConnectPreference: preference,
    });
    const mutableSession = session as MutablePersistedMagicBrowseSession;
    Object.assign(mutableSession, updatedSession);
    if (!updatedSession.localCdpConnectPreference) {
      delete mutableSession.localCdpConnectPreference;
    }
    await this.store.saveCurrentSession(updatedSession);
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
            this.buildConnectOptions(session, { browserWSEndpoint: session.cdpUrl })
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
        void connectTask.then(async (lateResult) => {
          if (lateResult.status === 'connected') {
            await disconnectBrowser(lateResult.browser);
          }
        }, () => undefined);
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
            await assertBrowserbaseSessionStillConnectable(session, this.resolveBrowserbaseClient());
          } else {
            await assertSessionEndpointStillMatches(session);
          }
          const client = this.resolveClient(session.stealth);
          return await client.connect(
            this.buildConnectOptions(session, { browserWSEndpoint: session.cdpUrl })
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
        void connectTask.then(async (lateResult) => {
          if (lateResult.status === 'connected') {
            await disconnectBrowser(lateResult.browser);
          }
        }, () => undefined);
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
      ...(session.protectedRedactionProfiles
        ? { protectedRedactionProfiles: session.protectedRedactionProfiles }
        : {}),
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

  private async ensureSessionRun(session: PersistedMagicBrowseSession): Promise<MagicBrowseRunRecorder> {
    return this.runStore.getOrCreateSessionRun({
      sessionId: session.id,
      runId: session.runId,
      ownership: session.ownership,
      cloudProvider: session.cloudProvider,
      cdpUrl: isBrowserbaseSession(session) ? undefined : session.cdpUrl,
      pid: session.pid,
      profile: session.profile,
      activePageIdentity: session.activePageIdentity,
      protectedRedactionProfiles: session.protectedRedactionProfiles,
    });
  }

  private async finishStatus(
    runRecorder: MagicBrowseRunRecorder,
    session: PersistedMagicBrowseSession,
    result: MagicBrowseStatusResult
  ): Promise<MagicBrowseStatusResult> {
    const redactedResult = redactSensitiveValue(result, {
      protectedRedactionProfiles: session.protectedRedactionProfiles,
    }) as MagicBrowseStatusResult;
    await runRecorder.append({
      type: 'status.complete',
      data: redactedResult,
    });
    return redactedResult;
  }
}

function isBrowserbaseSession(
  session: PersistedMagicBrowseSession
): session is PersistedMagicBrowseSession & {
  readonly cloudProvider: NonNullable<PersistedMagicBrowseSession['cloudProvider']>;
} {
  return session.cloudProvider?.name === 'browserbase';
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

async function assertSessionEndpointStillMatches(session: PersistedMagicBrowseSession): Promise<void> {
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

export function createMagicBrowseSessionManager(
  options: MagicBrowseSessionManagerOptions = {}
): MagicBrowseSessionManager {
  return new MagicBrowseSessionManager(options);
}

async function disconnectBrowser(browser: Browser): Promise<void> {
  try {
    await browser.disconnect();
  } catch {
    // Already disconnected.
  }
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
  return session.viewport ? { width: session.viewport.width, height: session.viewport.height } : null;
}

function shouldPreferLocalCdpFallbackConnect(session: PersistedMagicBrowseSession): session is
  PersistedMagicBrowseSession & {
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

function summarizeSession(session: PersistedMagicBrowseSession): Record<string, unknown> {
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
    protectedRedactionProfiles: session.protectedRedactionProfiles,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function normalizeMarkerTtlSeconds(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_HUMAN_VERIFICATION_RESOLVED_TTL_SECONDS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('magicbrowse mark-captcha-resolved --ttl must be a positive number of seconds.');
  }
  return value;
}

function resolveTrustedHumanVerificationEvidence(input: {
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

function statusSessionMetadata(
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

function buildAliveStatusResult(
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

async function readConnectedStatusPageIdentityWithTimeout(
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

async function readPageIdentityFromCdpList(
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

function isMeaningfulHttpPageUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? '';
  return normalized.startsWith('http://') || normalized.startsWith('https://');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readyGroupMatch(
  match: FillProtectedGroupInput['match']
): MagicBrowseMatchReadyGroupResult | undefined {
  return match.kind === 'ready_group' ? match : undefined;
}

function protectedCandidateForMatch(
  match: MagicBrowseMatchReadyGroupResult,
  candidates: readonly MagicBrowseMatchGroupCandidate[]
): MagicBrowseMatchGroupCandidate | undefined {
  return candidates.find((candidate) => candidate.candidateRef === match.candidateRef);
}

function protectedTargetsForSubject(
  fields: FillProtectedGroupInput['subject']['fields'],
  descriptors: readonly BrowserStateResolveFieldTargetDescriptor[]
): readonly MagicBrowseProtectedFillTargetDescriptor[] {
  const targetRefs = new Set(fields.map((field) => field.targetRef));
  return descriptors
    .filter((descriptor) => targetRefs.has(descriptor.ref))
    .map((descriptor) => ({
      targetRef: descriptor.ref,
      label: descriptor.label,
      displayLabel: descriptor.displayLabel,
      kind: descriptor.kind,
      selectorMapIndex: descriptor.selectorMapIndex,
      context: {
        hintText: [
          descriptor.placeholder,
          descriptor.text,
          descriptor.inputName,
          descriptor.autocomplete,
        ]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' '),
      },
    }));
}

function createProtectedFieldWriter(
  page: Pick<
    BrowserPage,
    'getState' | 'inputTextElementNode' | 'selectDropdownOption' | 'selectDropdownOptionByValue'
  >,
  descriptors: readonly BrowserStateResolveFieldTargetDescriptor[]
): MagicBrowseProtectedFieldWriter {
  const descriptorByRef = new Map(descriptors.map((descriptor) => [descriptor.ref, descriptor]));

  return {
    async fill(input) {
      const descriptor = descriptorByRef.get(input.targetRef);
      if (!descriptor) {
        throw new Error(`Protected fill target ${input.targetRef} is not available.`);
      }
      if (descriptor.kind === 'select') {
        try {
          await page.selectDropdownOptionByValue(descriptor.selectorMapIndex, input.value);
          return;
        } catch (error) {
          if (!(error instanceof DropdownOptionValueNotFoundError)) {
            throw new Error(`Protected select target ${input.targetRef} could not be filled.`);
          }
        }

        try {
          await page.selectDropdownOption(descriptor.selectorMapIndex, input.value);
          return;
        } catch {
          throw new Error(`Protected select target ${input.targetRef} could not be filled.`);
        }
      }

      const result = await executeMagicBrowseInputAction({
        action: 'fill',
        target: descriptor,
        text: input.value,
        page,
        failOnClientValidation: true,
      });
      if (result.status === 'blocked') {
        throw new Error(`Protected fill target ${input.targetRef} could not be filled.`);
      }
    },
  };
}

function blockedProtectedGroupResult(
  options: FillProtectedGroupInput,
  reason: 'match_not_ready' | 'unknown_candidate_ref'
): FillProtectedGroupResult {
  const candidateRef =
    'candidateRef' in options.match && typeof options.match.candidateRef === 'string'
      ? options.match.candidateRef
      : 'unknown';
  const artifactRef =
    'artifactRef' in options.match && typeof options.match.artifactRef === 'string'
      ? options.match.artifactRef
      : 'unknown';
  return {
    status: 'blocked',
    reason,
    fillRef: options.subject.fillRef,
    candidateRef,
    artifactRef,
    summary: `protected_fill blocked fill=${options.subject.fillRef} candidate=${candidateRef} reason=${reason}`,
  };
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
