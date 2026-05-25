// BrowserContext — written for puppeteer from scratch (NOT vendored).
//
// Replaces nanobrowser's `chrome-extension/.../browser/context.ts` (chrome.tabs.*-coupled,
// 360 lines with `waitForTabEvents` listener glue). Our version owns a puppeteer Browser,
// manages a Map<number, Page> of vendored Page wrappers (Шаг 3a), and synthesizes opaque
// `tabId`s with a counter. No chrome.* anywhere.

import type { Browser, Page as PuppeteerPage } from 'puppeteer-core';

import Page from '../vendor/browser/page.js';
import {
  type BrowserContextConfig,
  type BrowserState,
  type TabInfo,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  URLNotAllowedError,
} from '../vendor/browser/views.js';
import { isUrlAllowed } from '../vendor/browser/util.js';
import { createLogger } from '../adapter/logger.js';
import { isTransientPuppeteerContextError } from '../vendor/browser/puppeteer-errors.js';

const logger = createLogger('BrowserContext');

export class BrowserContext {
  private _browser: Browser;
  private _config: BrowserContextConfig;
  private _attachedPages: Map<number, Page> = new Map();
  private _puppeteerPageByTabId: Map<number, PuppeteerPage> = new Map();
  private _tabIdByPuppeteerPage: WeakMap<PuppeteerPage, number> = new WeakMap();
  private _currentTabId: number | null = null;
  private _nextTabId = 1;

  constructor(
    browser: Browser,
    config: Partial<BrowserContextConfig> = {},
    initialPage?: PuppeteerPage
  ) {
    this._browser = browser;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    if (initialPage) {
      const wrapper = this._registerPuppeteerPage(initialPage);
      this._currentTabId = wrapper.tabId;
    }
  }

  getConfig(): BrowserContextConfig {
    return this._config;
  }

  updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
  }

  private _registerPuppeteerPage(puppeteerPage: PuppeteerPage): Page {
    const existing = this._tabIdByPuppeteerPage.get(puppeteerPage);
    if (existing !== undefined) {
      const wrapper = this._attachedPages.get(existing);
      if (wrapper) return wrapper;
    }
    const tabId = this._nextTabId;
    this._nextTabId += 1;
    const wrapper = new Page(puppeteerPage, this._config, tabId);
    this._attachedPages.set(tabId, wrapper);
    this._puppeteerPageByTabId.set(tabId, puppeteerPage);
    this._tabIdByPuppeteerPage.set(puppeteerPage, tabId);
    return wrapper;
  }

  private async _syncBrowserPages(): Promise<void> {
    const pages = await this._browser.pages();
    for (const puppeteerPage of pages) {
      if (isPuppeteerPageClosed(puppeteerPage)) {
        this._unregisterPuppeteerPage(puppeteerPage);
        continue;
      }
      this._registerPuppeteerPage(puppeteerPage);
    }
  }

  private _unregisterPuppeteerPage(puppeteerPage: PuppeteerPage): void {
    const tabId = this._tabIdByPuppeteerPage.get(puppeteerPage);
    if (tabId === undefined) return;
    this._attachedPages.delete(tabId);
    this._puppeteerPageByTabId.delete(tabId);
    this._tabIdByPuppeteerPage.delete(puppeteerPage);
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Returns the current Page wrapper. If no current tab is set, picks the first puppeteer
   * page (or creates a new blank one) and registers it.
   */
  async getCurrentPage(): Promise<Page> {
    if (this._currentTabId !== null) {
      const existing = this._attachedPages.get(this._currentTabId);
      if (existing) return existing;
    }

    const pages = await this._browser.pages();
    const puppeteerPage = pages.length > 0 ? pages[0] : await this._browser.newPage();
    const wrapper = this._registerPuppeteerPage(puppeteerPage);
    this._currentTabId = wrapper.tabId;
    return wrapper;
  }

  async getCurrentPuppeteerPage(): Promise<PuppeteerPage> {
    const page = await this.getCurrentPage();
    const puppeteerPage = this._puppeteerPageByTabId.get(page.tabId);
    if (!puppeteerPage) {
      throw new Error(`Current puppeteer page is missing for tab ${page.tabId}`);
    }
    return puppeteerPage;
  }

  /**
   * Opens a new tab and navigates to the given URL.
   */
  async openTab(url: string): Promise<Page> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`Open tab failed. URL: ${url} is not allowed`);
    }
    const puppeteerPage = await this._browser.newPage();
    try {
      await puppeteerPage.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      logger.warning('openTab navigation failed', url, err);
    }
    try {
      await puppeteerPage.bringToFront();
    } catch (err) {
      logger.warning('openTab bringToFront failed', err);
    }
    const wrapper = this._registerPuppeteerPage(puppeteerPage);
    this._currentTabId = wrapper.tabId;
    return wrapper;
  }

  /**
   * Closes the tab with the given id and removes it from internal maps.
   */
  async closeTab(tabId: number): Promise<void> {
    const wrapper = this._attachedPages.get(tabId);
    const puppeteerPage = this._puppeteerPageByTabId.get(tabId);
    if (wrapper) {
      await wrapper.detachPuppeteer();
    }
    if (puppeteerPage) {
      try {
        await puppeteerPage.close();
      } catch (err) {
        logger.warning('closeTab puppeteerPage.close failed', err);
      }
      this._tabIdByPuppeteerPage.delete(puppeteerPage);
    }
    this._attachedPages.delete(tabId);
    this._puppeteerPageByTabId.delete(tabId);
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Brings the tab to front and updates the current tabId.
   */
  async switchTab(tabId: number): Promise<Page> {
    const wrapper = this._attachedPages.get(tabId);
    if (!wrapper) {
      throw new Error(`Tab ${tabId} not found`);
    }
    const puppeteerPage = this._puppeteerPageByTabId.get(tabId);
    if (puppeteerPage) {
      try {
        await puppeteerPage.bringToFront();
      } catch (err) {
        logger.warning('switchTab bringToFront failed', err);
      }
    }
    this._currentTabId = tabId;
    return wrapper;
  }

  /**
   * Navigates the current tab to the given URL.
   */
  async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }
    const page = await this.getCurrentPage();
    await page.navigateTo(url);
  }

  /**
   * Returns metadata for all attached tabs (only those with non-empty url+title).
   */
  async getTabInfos(): Promise<TabInfo[]> {
    await this._syncBrowserPages();
    const out: TabInfo[] = [];
    for (const [tabId, wrapper] of this._attachedPages) {
      try {
        const url = wrapper.url();
        const title = await wrapper.title();
        if (url && title) {
          out.push({ id: tabId, url, title });
        }
      } catch (error) {
        if (isTransientPuppeteerContextError(error)) {
          logger.warning('Skipping tab metadata during transient page context churn', tabId, error);
        } else {
          logger.warning('Skipping tab metadata after title read failed', tabId, error);
        }
      }
    }
    return out;
  }

  /**
   * Live-read browser pages before returning ids. The click action relies on this
   * matching nanobrowser's chrome.tabs.query behavior to detect target=_blank tabs.
   */
  async getAllTabIds(): Promise<Set<number>> {
    await this._syncBrowserPages();
    return new Set(this._attachedPages.keys());
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    await this._syncBrowserPages();
    const page = await this.getCurrentPage();
    const pageState = await page.getState(useVision, cacheClickableElementsHashes);
    const tabs = await this.getTabInfos();
    return { ...pageState, tabs };
  }

  async getCachedState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    await this._syncBrowserPages();
    const page = await this.getCurrentPage();
    let pageState = page.getCachedState();
    if (!pageState) {
      pageState = await page.getState(useVision, cacheClickableElementsHashes);
    }
    const tabs = await this.getTabInfos();
    return { ...pageState, tabs };
  }

  async removeHighlight(): Promise<void> {
    if (this._currentTabId === null) return;
    const page = this._attachedPages.get(this._currentTabId);
    if (!page) return;
    await page.removeHighlight();
  }

  /**
   * Detaches all wrappers and closes underlying puppeteer pages. Does NOT close the
   * Browser itself — that's the caller's responsibility (the entity that called
   * `puppeteer.launch`).
   */
  async cleanup(): Promise<void> {
    try {
      await this.removeHighlight();
    } catch (err) {
      logger.warning('cleanup removeHighlight failed', err);
    }
    for (const [tabId, wrapper] of this._attachedPages) {
      try {
        await wrapper.detachPuppeteer();
      } catch (err) {
        logger.warning('cleanup detachPuppeteer failed', tabId, err);
      }
    }
    this._attachedPages.clear();
    this._puppeteerPageByTabId.clear();
    this._currentTabId = null;
  }
}

function isPuppeteerPageClosed(page: PuppeteerPage): boolean {
  const value = (page as unknown as { isClosed?: () => boolean }).isClosed;
  return typeof value === 'function' ? value.call(page) : false;
}
