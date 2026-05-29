import {
  type HTTPRequest,
  type HTTPResponse,
  type KeyInput,
  type Page as PuppeteerPage,
  type ElementHandle,
  type Frame,
} from 'puppeteer-core';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
} from '../../browser/dom-service.js';
import { DOMElementNode, type DOMState } from './dom/views.js';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState, URLNotAllowedError } from './views.js';
import { createLogger } from '../../adapter/logger.js';
import { ClickableElementProcessor } from './dom/clickable/service.js';
import { isUrlAllowed } from './util.js';
import { isTransientPuppeteerContextError } from './puppeteer-errors.js';

const logger = createLogger('Page');

const STABLE_ELEMENT_IDENTITY_ATTRIBUTES = [
  'id',
  'name',
  'type',
  'role',
  'href',
  'for',
  'autocomplete',
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'data-id',
  'data-qa',
  'data-cy',
  'data-testid',
  'data-test-id',
];
const MAGICBROWSE_DOM_NODE_ID_PROPERTY = '__aftercardMagicBrowseDomNodeId';
const HIGHLIGHT_CONTAINER_ID = 'playwright-highlight-container';

type DefaultScrollContainerInput =
  | { type: 'percent'; yPercent: number }
  | { type: 'by'; y: number }
  | { type: 'page'; direction: 'previous' | 'next' };

const SCROLL_DEFAULT_CONTAINER_SCRIPT = `
function viewportHeight() {
  return window.visualViewport?.height || window.innerHeight;
}

function viewportWidth() {
  return window.visualViewport?.width || window.innerWidth;
}

function intersectsViewport(rect) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight() && rect.left < viewportWidth();
}

function intersectionArea(rect) {
  const width = Math.max(0, Math.min(rect.right, viewportWidth()) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight()) - Math.max(rect.top, 0));
  return width * height;
}

function zIndexScore(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 10000)) / 100 : 0;
}

function hasOverlaySignal(el, style) {
  const role = el.getAttribute('role')?.toLowerCase();
  const ariaModal = el.getAttribute('aria-modal')?.toLowerCase();
  const identity = String(el.id) + ' ' + String(el.className).toLowerCase();
  return (
    style.position === 'fixed' ||
    role === 'dialog' ||
    role === 'alertdialog' ||
    ariaModal === 'true' ||
    /\\b(modal|dialog|overlay|drawer|popover|sheet)\\b/.test(identity)
  );
}

function canScrollForInput(el) {
  const maxScrollTop = el.scrollHeight - el.clientHeight;
  if (maxScrollTop <= 1) {
    return false;
  }
  if (scrollInput.type === 'percent') {
    if (scrollInput.yPercent <= 0) {
      return el.scrollTop > 1;
    }
    if (scrollInput.yPercent >= 100) {
      return el.scrollTop < maxScrollTop - 1;
    }
    return true;
  }
  if (scrollInput.type === 'by') {
    return scrollInput.y < 0 ? el.scrollTop > 1 : el.scrollTop < maxScrollTop - 1;
  }
  return scrollInput.direction === 'previous' ? el.scrollTop > 1 : el.scrollTop < maxScrollTop - 1;
}

function findPrimaryScrollableOverlay() {
  const viewportArea = Math.max(1, viewportWidth() * viewportHeight());
  const activeElement = document.activeElement;
  let best = null;

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || !intersectsViewport(rect)) {
      continue;
    }
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      continue;
    }
    const scrollable =
      el.scrollHeight > el.clientHeight + 1 &&
      (style.overflowY === 'auto' ||
        style.overflowY === 'scroll' ||
        style.overflowY === 'overlay' ||
        style.overflow === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'overlay');
    if (!scrollable || !hasOverlaySignal(el, style)) {
      continue;
    }

    const areaRatio = intersectionArea(rect) / viewportArea;
    if (areaRatio < 0.15 && style.position !== 'fixed') {
      continue;
    }

    let score = areaRatio * 100;
    if (style.position === 'fixed') score += 500;
    if (el.getAttribute('aria-modal')?.toLowerCase() === 'true') score += 300;
    if ((el.getAttribute('role') ?? '').toLowerCase().includes('dialog')) score += 250;
    if (activeElement && el.contains(activeElement)) score += 150;
    if (canScrollForInput(el)) score += 200;
    score += zIndexScore(style.zIndex);

    if (!best || score > best.score) {
      best = { element: el, score };
    }
  }

  return best?.element ?? null;
}

function scrollElement(el) {
  if (scrollInput.type === 'percent') {
    const scrollTop = (el.scrollHeight - el.clientHeight) * (scrollInput.yPercent / 100);
    el.scrollTo({ top: scrollTop, left: el.scrollLeft, behavior: 'smooth' });
    return;
  }
  if (scrollInput.type === 'by') {
    el.scrollBy({ top: scrollInput.y, left: 0, behavior: 'smooth' });
    return;
  }
  const delta = scrollInput.direction === 'previous' ? -el.clientHeight : el.clientHeight;
  el.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
}

const primaryScrollableOverlay = findPrimaryScrollableOverlay();
if (primaryScrollableOverlay) {
  scrollElement(primaryScrollableOverlay);
  return;
}

if (scrollInput.type === 'percent') {
  const scrollHeight = document.documentElement.scrollHeight;
  const scrollTop = (scrollHeight - viewportHeight()) * (scrollInput.yPercent / 100);
  window.scrollTo({ top: scrollTop, left: window.scrollX, behavior: 'smooth' });
  return;
}
if (scrollInput.type === 'by') {
  window.scrollBy({ top: scrollInput.y, left: 0, behavior: 'smooth' });
  return;
}
const delta = scrollInput.direction === 'previous' ? -viewportHeight() : viewportHeight();
window.scrollBy({ top: delta, left: 0, behavior: 'smooth' });
`;

export class DropdownOptionValueNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DropdownOptionValueNotFoundError';
  }
}

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
  };
}

export interface InputTextElementNodeResult {
  readonly clientValidation: {
    readonly invalid: boolean;
    readonly reason?: 'aria_invalid' | 'native_validation';
  };
  readonly inputTarget: InputTargetActivationDiagnostics;
}

export type InputTargetActivationSource =
  | 'requested_target'
  | 'proxy_active_target'
  | 'requested_target_after_unrelated_active'
  | 'requested_target_after_no_active';

export interface InputTargetElementDiagnostics {
  readonly tagName: string | null;
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly role?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly internalNodeId?: string;
}

export interface InputTargetActivationDiagnostics {
  readonly source: InputTargetActivationSource;
  readonly requested: InputTargetElementDiagnostics;
  readonly active?: InputTargetElementDiagnostics;
  readonly chosen: InputTargetElementDiagnostics;
}

type InputTargetResolution = {
  readonly element: ElementHandle;
  readonly activation: InputTargetActivationDiagnostics;
};

function cloneInputTargetElementDiagnostics(
  diagnostics: InputTargetElementDiagnostics,
): InputTargetElementDiagnostics {
  return { ...diagnostics };
}

/**
 * Cached clickable elements hashes for the last state
 */
export class CachedStateClickableElementsHashes {
  url: string;
  hashes: Set<string>;

  constructor(url: string, hashes: Set<string>) {
    this.url = url;
    this.hashes = hashes;
  }
}

export default class Page {
  private _tabId: number;
  // Phase C: removed `_browser` — browser handle is resolved on demand via `_puppeteerPage.browser()`.
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _cachedState: PageState | null = null;
  private _cachedStateClickableElementsHashes: CachedStateClickableElementsHashes | null = null;

  // ADAPTED (Phase A.5): instead of (tabId, url, title, config) used by nanobrowser,
  // we accept a puppeteer Page directly — we own the Browser and don't need to attach
  // via ExtensionTransport. `tabId` is kept as an opaque identifier for BrowserContext
  // (Шаг 3b will assign it a synthetic counter); defaults to 0.
  constructor(puppeteerPage: PuppeteerPage, config: Partial<BrowserContextConfig> = {}, tabId: number = 0) {
    this._tabId = tabId;
    this._puppeteerPage = puppeteerPage;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, puppeteerPage.url(), '');
  }

  get tabId(): number {
    return this._tabId;
  }

  // Adapted: was a cached `_validWebPage` field set once at construction. That broke when
  // the wrapper was constructed at about:blank and then navigated — the cache stayed false
  // forever, blinding all the guards below. Now reads the current URL each access.
  private get _validWebPage(): boolean {
    if (!this._puppeteerPage) return false;
    const lower = this._puppeteerPage.url().trim().toLowerCase();
    if (!lower) return false;
    if (lower.startsWith('https://chromewebstore.google.com')) return false;
    return lower.startsWith('http');
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  // Phase C: in nanobrowser this attaches puppeteer via ExtensionTransport.connectTab(tabId).
  // We own the puppeteer Browser (passed as a Page in the constructor) so attach is a no-op:
  // success simply means we have a valid web page and a puppeteerPage handle.
  // Stealth/anti-detection is applied at puppeteer.launch time via puppeteer-extra-plugin-stealth,
  // not per-page here.
  async attachPuppeteer(): Promise<boolean> {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  // Phase C: nanobrowser's detachPuppeteer disconnected the per-tab browser created by attach.
  // We don't own a per-tab browser — Page comes from a shared puppeteer Browser owned by
  // BrowserContext (closed centrally on cleanup). So detach just nulls out the reference and
  // clears cached state, without disconnecting the underlying browser.
  async detachPuppeteer(): Promise<void> {
    this._puppeteerPage = null;
    this._state = build_initial_state(this._tabId);
  }

  async removeHighlight(): Promise<void> {
    if (this._validWebPage && this._puppeteerPage) {
      await _removeHighlights(this._puppeteerPage);
    }
  }

  async getClickableElements(showHighlightElements: boolean, focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage || !this._puppeteerPage) {
      return null;
    }
    return _getClickableElements(this._puppeteerPage, {
      showHighlightElements,
      focusElement,
      viewportExpansion: this._config.viewportExpansion,
    });
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number, number]> {
    if (!this._validWebPage || !this._puppeteerPage) {
      return [0, 0, 0];
    }
    return _getScrollInfo(this._puppeteerPage);
  }

  // Get scroll position information for a specific element.
  async getElementScrollInfo(elementNode: DOMElementNode): Promise<[number, number, number]> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const element = await this.locateElement(elementNode);
    if (!element) {
      throw new Error(`Element: ${elementNode} not found`);
    }

    // Find the nearest scrollable ancestor
    const scrollableElement = await this._findNearestScrollableElement(element);
    if (!scrollableElement) {
      throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
    }

    const scrollInfo = await scrollableElement.evaluate(el => {
      return {
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      };
    });

    return [scrollInfo.scrollTop, scrollInfo.clientHeight, scrollInfo.scrollHeight];
  }

  /**
   * Find the nearest scrollable ancestor of the given element
   * @param element The element to start searching from
   * @returns The nearest scrollable ancestor or null if none found
   */
  private async _findNearestScrollableElement(element: ElementHandle): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      return null;
    }

    // Check if the current element is scrollable
    const isScrollable = await element.evaluate((el: Element) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const canScrollVertically =
        style.overflowY === 'scroll' ||
        style.overflowY === 'auto' ||
        style.overflow === 'scroll' ||
        style.overflow === 'auto';

      return hasVerticalScrollbar && canScrollVertically;
    });

    if (isScrollable) {
      return element;
    }

    // Check parent elements
    let currentElement: ElementHandle<Element> | null = element;

    try {
      while (currentElement) {
        // Get the parent element (as an ElementHandle) of the current element
        const parentHandle = (await currentElement.evaluateHandle(
          (el: Element) => el.parentElement,
        )) as ElementHandle<Element> | null;

        const parentElement = (parentHandle ? await parentHandle.asElement() : null) as ElementHandle<Element> | null;

        if (!parentElement) {
          // Reached the root without finding a scrollable ancestor
          currentElement = null;
          break;
        }

        const parentIsScrollable = await parentElement.evaluate((el: Element) => {
          if (!(el instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(el);
          const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
          const canScrollVertically =
            ['scroll', 'auto'].includes(style.overflowY) || ['scroll', 'auto'].includes(style.overflow);

          return hasVerticalScrollbar && canScrollVertically;
        });

        if (parentIsScrollable) {
          // Found a scrollable ancestor – return it (the caller should dispose when finished)
          return parentElement;
        }

        // Move up the DOM tree – dispose the previous element handle before continuing
        if (currentElement !== element) {
          try {
            await currentElement.dispose();
          } catch (disposeErr) {
            logger.debug('Failed to dispose element handle:', disposeErr);
          }
        }

        currentElement = parentElement;
      }
    } catch (error) {
      // Error accessing parent, break out of loop
      logger.error('Error finding scrollable parent:', error);
    }

    // If no scrollable ancestor found, return the document body or documentElement
    try {
      const bodyElement = await this._puppeteerPage.$('body');
      if (bodyElement) {
        const bodyIsScrollable = await bodyElement.evaluate(el => {
          if (!(el instanceof HTMLElement)) return false;
          return el.scrollHeight > el.clientHeight;
        });
        if (bodyIsScrollable) {
          return bodyElement;
        }
      }

      // Last resort: return document element for page-level scrolling
      const documentElement = await this._puppeteerPage.evaluateHandle(() => document.documentElement);
      const docElement = (await documentElement.asElement()) as ElementHandle<Element> | null;
      return docElement;
    } catch (error) {
      logger.error('Failed to find scrollable element:', error);
      return null;
    }
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  getCachedState(): PageState | null {
    return this._cachedState;
  }

  async getState(useVision = false, cacheClickableElementsHashes = false): Promise<PageState> {
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const updatedState = await this._updateState(useVision);

    // Find out which elements are new
    // Do this only if url has not changed
    if (cacheClickableElementsHashes) {
      // If we are on the same url as the last state, we can use the cached hashes
      if (
        this._cachedStateClickableElementsHashes &&
        this._cachedStateClickableElementsHashes.url === updatedState.url
      ) {
        // Get clickable elements from the updated state
        const updatedStateClickableElements = ClickableElementProcessor.getClickableElements(updatedState.elementTree);

        // Mark elements as new if they weren't in the previous state
        for (const domElement of updatedStateClickableElements) {
          const hash = await ClickableElementProcessor.hashDomElement(domElement);
          domElement.isNew = !this._cachedStateClickableElementsHashes.hashes.has(hash);
        }
      }

      // In any case, we need to cache the new hashes
      const newHashes = await ClickableElementProcessor.getClickableElementsHashes(updatedState.elementTree);
      this._cachedStateClickableElementsHashes = new CachedStateClickableElementsHashes(updatedState.url, newHashes);
    }

    // Save the updated state as the cached state
    this._cachedState = updatedState;

    return updatedState;
  }

  async _updateState(useVision = false, focusElement = -1): Promise<PageState> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this._captureState(useVision, focusElement);
      } catch (error) {
        if (attempt === 0 && isTransientPuppeteerContextError(error)) {
          logger.warning('Page state capture hit transient page context churn; settling and retrying once:', error);
          await this.waitForPageAndFramesLoad();
          continue;
        }
        logger.error('Failed to update state:', error);
        return this._state;
      }
    }
    return this._state;
  }

  private async _captureState(useVision: boolean, focusElement: number): Promise<PageState> {
    const puppeteerPage = this._puppeteerPage;
    if (!puppeteerPage) {
      return this._state;
    }

    // Test if page is still accessible before doing heavier DOM extraction.
    await puppeteerPage.evaluate('1');
    await this.removeHighlight();

    // Get DOM content (equivalent to dom_service.get_clickable_elements)
    // This part would need to be implemented based on your DomService logic
    // showHighlightElements is true if either useVision or displayHighlights is true
    const displayHighlights = this._config.displayHighlights || useVision;
    const content = await this.getClickableElements(displayHighlights, focusElement);
    if (!content) {
      logger.warning('Failed to get clickable elements');
      return this._state;
    }
    // log the attributes of content object
    if ('selectorMap' in content) {
      logger.debug('content.selectorMap:', content.selectorMap.size);
    } else {
      logger.debug('content.selectorMap: not found');
    }
    if ('elementTree' in content) {
      logger.debug('content.elementTree:', content.elementTree?.tagName);
    } else {
      logger.debug('content.elementTree: not found');
    }

    // Take screenshot if needed
    const screenshot = useVision ? await this.takeScreenshot() : null;
    const [scrollY, visualViewportHeight, scrollHeight] = await this.getScrollInfo();

    const updatedState: PageState = {
      ...this._state,
      elementTree: content.elementTree,
      selectorMap: content.selectorMap,
      url: puppeteerPage.url(),
      title: await this.title(),
      screenshot,
      scrollY,
      visualViewportHeight,
      scrollHeight,
    };
    this._state = updatedState;
    return updatedState;
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions
      await this._puppeteerPage.evaluate(() => {
        const styleId = 'puppeteer-disable-animations';
        if (!document.getElementById(styleId)) {
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = `
            *, *::before, *::after {
              animation: none !important;
              transition: none !important;
            }
          `;
          document.head.appendChild(style);
        }
      });

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element
      await this._puppeteerPage.evaluate(() => {
        const style = document.getElementById('puppeteer-disable-animations');
        if (style) {
          style.remove();
        }
      });

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      try {
        return await this._puppeteerPage.title();
      } catch (error) {
        if (isTransientPuppeteerContextError(error)) {
          logger.warning('Page title read hit transient page context churn:', error);
          return this._state.title;
        }
        throw error;
      }
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    // Check if URL is allowed
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
      logger.info('navigateTo complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Navigation failed:', error);
      throw error;
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Page refresh failed:', error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate back:', error);
      throw error;
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }

      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
        return;
      }

      logger.error('Could not navigate forward:', error);
      throw error;
    }
  }

  // scroll to a percentage of the page or element
  // if yPercent is 0, scroll to the top of the page, if 100, scroll to the bottom of the page
  // if elementNode is provided, scroll to a percentage of the element
  // if elementNode is not provided, scroll to a percentage of the page
  async scrollToPercent(yPercent: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._scrollDefaultContainer({ type: 'percent', yPercent });
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate((el, yPercent) => {
        const scrollHeight = el.scrollHeight;
        const viewportHeight = el.clientHeight;
        const scrollTop = (scrollHeight - viewportHeight) * (yPercent / 100);
        el.scrollTo({
          top: scrollTop,
          left: el.scrollLeft,
          behavior: 'smooth',
        });
      }, yPercent);
    }
  }

  async scrollBy(y: number, elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }
    if (!elementNode) {
      await this._scrollDefaultContainer({ type: 'by', y });
    } else {
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }
      await scrollableElement.evaluate(el => {
        el.scrollBy({
          top: y,
          left: 0,
          behavior: 'smooth',
        });
      });
    }
  }

  async scrollToPreviousPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      await this._scrollDefaultContainer({ type: 'page', direction: 'previous' });
    } else {
      // Scroll the specific element up by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, -el.clientHeight);
      });
    }
  }

  async scrollToNextPage(elementNode?: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    if (!elementNode) {
      await this._scrollDefaultContainer({ type: 'page', direction: 'next' });
    } else {
      // Scroll the specific element down by its client height
      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }

      // Find the nearest scrollable ancestor
      const scrollableElement = await this._findNearestScrollableElement(element);
      if (!scrollableElement) {
        throw new Error(`No scrollable ancestor found for element: ${elementNode}`);
      }

      await scrollableElement.evaluate(el => {
        el.scrollBy(0, el.clientHeight);
      });
    }
  }

  private async _scrollDefaultContainer(input: DefaultScrollContainerInput): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const scrollDefaultContainer = new Function(
      'scrollInput',
      SCROLL_DEFAULT_CONTAINER_SCRIPT
    ) as (scrollInput: DefaultScrollContainerInput) => void;
    await this._puppeteerPage.evaluate(scrollDefaultContainer, input);
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    const lowerKey = key.trim().toLowerCase();
    const isMac = navigator.userAgent.toLowerCase().includes('mac os x');

    if (isMac) {
      if (lowerKey === 'control' || lowerKey === 'ctrl') {
        return 'Meta' as KeyInput; // Use Command key on Mac
      }
      if (lowerKey === 'command' || lowerKey === 'cmd') {
        return 'Meta' as KeyInput; // Map Command/Cmd to Meta on Mac
      }
      if (lowerKey === 'option' || lowerKey === 'opt') {
        return 'Alt' as KeyInput; // Map Option/Opt to Alt on Mac
      }
    }

    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string, nth: number = 1): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Convert text to lowercase for consistent searching
      const lowerCaseText = text.toLowerCase();

      // Try different locator strategies to find all elements containing the text
      const selectors = [
        // Using text selector (equivalent to get_by_text) - for exact text match
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${lowerCaseText}')])`,
      ];

      for (const selector of selectors) {
        try {
          // Use $$ to get all matching elements
          const elements = await this._puppeteerPage.$$(selector);

          if (elements.length > 0) {
            // Find visible elements and select the nth occurrence
            const visibleElements = [];

            for (const element of elements) {
              const isVisible = await element.evaluate(el => {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  style.opacity !== '0' &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              });

              if (isVisible) {
                visibleElements.push(element);
              }
            }

            // Check if we have enough visible elements for the requested nth occurrence
            if (visibleElements.length >= nth) {
              const targetElement = visibleElements[nth - 1]; // Convert to 0-indexed
              await this._scrollIntoViewIfNeeded(targetElement);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete

              // Dispose of all element handles to prevent memory leaks
              for (const element of elements) {
                await element.dispose();
              }

              return true;
            }
          }

          // Dispose of all element handles to prevent memory leaks
          for (const element of elements) {
            await element.dispose();
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(index: number, text: string): Promise<string> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text === optionText);

          if (!option) {
            const availableOptions = options.map(o => JSON.stringify(o.text)).join(', ');
            return {
              found: false,
              message: `Exact option ${JSON.stringify(optionText)} not found in dropdown element with index ${elementIndex}. Available options: ${availableOptions}`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      if (!result.found) {
        throw new Error(result.message);
      }
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async selectDropdownOptionByValue(index: number, value: string): Promise<string> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug('Attempting to select dropdown by exact option value');
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option by value: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      const result = await elementHandle.evaluate(
        (select, optionValue, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              status: 'blocked' as const,
              reason: 'not_select' as const,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find((opt) => opt.value === optionValue);

          if (!option) {
            const availableOptions = options.map((o) => JSON.stringify(o.value)).join(', ');
            return {
              status: 'blocked' as const,
              reason: 'value_not_found' as const,
              message: `Exact option value not found in dropdown element with index ${elementIndex}. Available values: ${availableOptions}`,
            };
          }

          const previousValue = select.value;
          select.value = option.value;

          if (select.value !== optionValue) {
            return {
              status: 'blocked' as const,
              reason: 'value_not_retained' as const,
              message: `Dropdown element with index ${elementIndex} did not retain selected option value`,
            };
          }

          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }

          return {
            status: 'selected' as const,
            message: `Selected option by exact value with text "${option.text}"`,
          };
        },
        value,
        index,
      );

      logger.debug('Selection result:', result);
      if (result.status !== 'selected') {
        if (result.reason === 'value_not_found') {
          throw new DropdownOptionValueNotFoundError(result.message);
        }
        throw new Error(result.message);
      }
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      if (error instanceof DropdownOptionValueNotFoundError) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      // throw new Error('Puppeteer page is not connected');
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;
    let currentShadowHost: ElementHandle<Element> | null = null;

    const locateInCurrentBoundary = async (target: DOMElementNode): Promise<ElementHandle<Element> | null> => {
      const elementHandle = currentShadowHost
        ? await this._queryElementInOpenShadowRoot(currentShadowHost, target)
        : await this._queryElementInDocumentOrFrame(currentFrame, target);
      if (!elementHandle) {
        return null;
      }

      const matchesExpectedIdentity = await this._elementHandleMatchesDomElement(elementHandle, target);
      if (!matchesExpectedIdentity) {
        await elementHandle.dispose().catch(() => undefined);
        logger.info('Located element did not match observed DOMElementNode identity');
        return null;
      }
      return elementHandle;
    };

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Walk observed boundaries from document/frame into iframes and open shadow roots.
    for (const parent of parents.reverse()) {
      if (parent.tagName === 'iframe') {
        const frameElement = await locateInCurrentBoundary(parent);
        if (!frameElement) {
          logger.warning('Could not find iframe in observed boundary path');
          return null;
        }
        const frame: Frame | null = await frameElement.contentFrame();
        if (!frame) {
          logger.warning('Could not access frame content for observed iframe');
          return null;
        }
        currentFrame = frame;
        currentShadowHost = null;
        logger.info('currentFrame changed', currentFrame);
        continue;
      }

      if (parent.shadowRoot) {
        const shadowHost = await locateInCurrentBoundary(parent);
        if (!shadowHost) {
          logger.warning('Could not find shadow host in observed boundary path');
          return null;
        }
        const hasOpenShadowRoot = await shadowHost.evaluate(host => host.shadowRoot !== null);
        if (!hasOpenShadowRoot) {
          await shadowHost.dispose().catch(() => undefined);
          logger.warning('Observed shadow host no longer exposes an open shadowRoot');
          return null;
        }
        currentShadowHost = shadowHost;
      }
    }

    try {
      const elementHandle = await locateInCurrentBoundary(element);

      // If element found, check visibility and scroll into view
      if (elementHandle) {
        const isHidden = await elementHandle.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(elementHandle);
        }
        return elementHandle;
      }

      logger.info('elementHandle not located');
    } catch (error) {
      logger.error('Failed to locate element:', error);
    }

    return null;
  }

  private async _queryElementInDocumentOrFrame(
    root: PuppeteerPage | Frame,
    element: DOMElementNode,
  ): Promise<ElementHandle<Element> | null> {
    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
    let elementHandle: ElementHandle<Element> | null = null;

    if (cssSelector.trim()) {
      try {
        elementHandle = (await root.$(cssSelector)) as ElementHandle<Element> | null;
      } catch (error) {
        logger.error('Failed to locate element using CSS selector:', error);
      }
    }

    // Document/frame-local XPath fallback is retained for normal DOM boundaries.
    if (!elementHandle) {
      const xpath = element.xpath;
      if (xpath) {
        try {
          logger.info('Trying XPath selector:', xpath);
          const fullXpath = xpath.startsWith('/') ? xpath : `/${xpath}`;
          const xpathSelector = `::-p-xpath(${fullXpath})`;
          elementHandle = (await root.$(xpathSelector)) as ElementHandle<Element> | null;
        } catch (xpathError) {
          logger.error('Failed to locate element using XPath:', xpathError);
        }
      }
    }

    return elementHandle;
  }

  private async _queryElementInOpenShadowRoot(
    shadowHost: ElementHandle<Element>,
    element: DOMElementNode,
  ): Promise<ElementHandle<Element> | null> {
    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
    if (!cssSelector.trim()) {
      return null;
    }

    const handle = await shadowHost.evaluateHandle((host, selector) => {
      if (!(host instanceof Element) || !host.isConnected || host.shadowRoot === null) {
        return null;
      }
      return host.shadowRoot.querySelector(selector);
    }, cssSelector);
    const elementHandle = handle.asElement() as ElementHandle<Element> | null;
    if (!elementHandle) {
      await handle.dispose().catch(() => undefined);
      return null;
    }
    return elementHandle;
  }

  private async _elementHandleMatchesDomElement(
    elementHandle: ElementHandle,
    expectedElement: DOMElementNode,
  ): Promise<boolean> {
    const expectedIdentity = this._domElementIdentity(expectedElement);
    const actualIdentity = await elementHandle.evaluate((el, stableAttributeNames, internalNodeIdProperty, highlightContainerId) => {
      if (!(el instanceof Element) || !el.isConnected) {
        return null;
      }

      function getElementPosition(currentElement: Element): number {
        const parent =
          currentElement.parentElement ||
          (currentElement.parentNode instanceof ShadowRoot ? currentElement.parentNode : null);
        if (!parent || !parent.children) {
          return 0;
        }
        const tagName = currentElement.nodeName.toLowerCase();
        const siblings = Array.from(parent.children).filter(
          sibling => sibling.id !== highlightContainerId && sibling.nodeName.toLowerCase() === tagName,
        );
        if (siblings.length === 1) {
          return 0;
        }
        return siblings.indexOf(currentElement) + 1;
      }

      function getXPathTree(currentElement: Element): string {
        const segments: string[] = [];
        let cursor: Element | null = currentElement;
        while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
          const position = getElementPosition(cursor);
          const tagName = cursor.nodeName.toLowerCase();
          const xpathIndex = position > 0 ? `[${position}]` : '';
          segments.unshift(`${tagName}${xpathIndex}`);
          if (cursor.parentNode instanceof ShadowRoot) {
            break;
          }
          cursor = cursor.parentElement;
        }
        return `/${segments.join('/')}`;
      }

      function getParentBranchPath(currentElement: Element): string[] {
        const branch: string[] = [];
        let cursor: Element | null = currentElement;
        while (cursor !== null && cursor !== cursor.ownerDocument.body) {
          branch.push(cursor.tagName.toLowerCase());
          const parentNode: ParentNode | null = cursor.parentNode;
          cursor = parentNode instanceof ShadowRoot ? parentNode.host : cursor.parentElement;
        }
        return branch.reverse();
      }

      const stableAttributes: Record<string, string> = {};
      for (const attributeName of stableAttributeNames) {
        const value = el.getAttribute(attributeName);
        if (value !== null) {
          stableAttributes[attributeName] = value;
        }
      }

      return {
        tagName: el.tagName.toLowerCase(),
        xpath: getXPathTree(el),
        parentBranchPath: getParentBranchPath(el),
        stableAttributes,
        internalNodeId:
          (el as unknown as Record<string, string | undefined>)[internalNodeIdProperty] ?? null,
      };
    }, STABLE_ELEMENT_IDENTITY_ATTRIBUTES, MAGICBROWSE_DOM_NODE_ID_PROPERTY, HIGHLIGHT_CONTAINER_ID);

    if (!actualIdentity) {
      return false;
    }

    if (expectedIdentity.tagName && actualIdentity.tagName !== expectedIdentity.tagName) {
      return false;
    }

    if (expectedIdentity.xpath && normalizeXPath(actualIdentity.xpath) !== expectedIdentity.xpath) {
      return false;
    }

    if (!sameStringArray(actualIdentity.parentBranchPath, expectedIdentity.parentBranchPath)) {
      return false;
    }

    if (expectedIdentity.internalNodeId !== null && actualIdentity.internalNodeId !== expectedIdentity.internalNodeId) {
      return false;
    }

    for (const [attributeName, expectedValue] of Object.entries(expectedIdentity.stableAttributes)) {
      if (actualIdentity.stableAttributes[attributeName] !== expectedValue) {
        return false;
      }
    }

    return true;
  }

  private _domElementIdentity(element: DOMElementNode): {
    tagName: string | null;
    xpath: string | null;
    parentBranchPath: string[];
    stableAttributes: Record<string, string>;
    internalNodeId: string | null;
  } {
    const stableAttributes: Record<string, string> = {};
    for (const attributeName of STABLE_ELEMENT_IDENTITY_ATTRIBUTES) {
      const value = element.attributes[attributeName];
      if (value !== undefined) {
        stableAttributes[attributeName] = value;
      }
    }

    return {
      tagName: normalizeTagName(element.tagName),
      xpath: normalizeXPath(element.xpath),
      parentBranchPath: domParentBranchPath(element),
      stableAttributes,
      internalNodeId: element.internalNodeId,
    };
  }

  async inputTextElementNode(
    useVision: boolean,
    elementNode: DOMElementNode,
    text: string
  ): Promise<InputTextElementNodeResult> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before typing
      // if (elementNode.highlightIndex != null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }
      await this._assertOriginalInputTargetCanResolve(element);

      // Ensure element is ready for input
      try {
        // First wait for element stability
        await this._waitForElementStability(element, 1500);

        // Then check visibility and scroll into view if needed
        const isHidden = await element.isHidden();
        if (!isHidden) {
          await this._scrollIntoViewIfNeeded(element, 1500);
        }
      } catch (e) {
        // Continue even if these operations fail
        logger.debug(`Non-critical error preparing element: ${e}`);
      }

      const inputResolution = await this._resolveInputTarget(element);
      await this._assertCanInputText(inputResolution.element);
      await this._typeIntoEditableElement(inputResolution.element, text);

      // Wait for page stability after input
      await this.waitForPageAndFramesLoad();
      const clientValidation = await this._readClientValidationState(inputResolution.element).catch((error) => {
        logger.debug(`Non-critical error reading input validation state: ${error}`);
        return { invalid: false } as const;
      });

      return {
        clientValidation,
        inputTarget: inputResolution.activation,
      };
    } catch (error) {
      const errorMsg = `Failed to input text into element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  private async _readClientValidationState(element: ElementHandle): Promise<InputTextElementNodeResult['clientValidation']> {
    return element.evaluate((el) => {
      const ariaInvalid = el.getAttribute('aria-invalid')?.trim().toLowerCase();
      if (ariaInvalid === 'true') {
        return { invalid: true, reason: 'aria_invalid' as const };
      }

      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
        el.validity &&
        !el.validity.valid
      ) {
        return { invalid: true, reason: 'native_validation' as const };
      }

      return { invalid: false };
    });
  }

  private async _resolveInputTarget(element: ElementHandle): Promise<InputTargetResolution> {
    const requested = await this._describeInputTarget(element);
    if (!this._puppeteerPage) {
      return {
        element,
        activation: {
          source: 'requested_target',
          requested: cloneInputTargetElementDiagnostics(requested),
          chosen: cloneInputTargetElementDiagnostics(requested),
        },
      };
    }

    const beforeActivationMarker = `__magicbrowseInputSeenBefore_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const beforeActivationMarked = await this._markEditableInputsBeforeActivation(beforeActivationMarker);

    try {
      await this._activateInputTarget(element);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      logger.debug(`Non-critical error activating input target: ${error}`);
      try {
        await element.focus();
      } catch (focusError) {
        logger.debug(`Non-critical error focusing input target: ${focusError}`);
      }
    }

    try {
      const activeHandle = await this._puppeteerPage.evaluateHandle(() => {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable)
        ) {
          return active;
        }
        return null;
      });
      const activeElement = activeHandle.asElement() as ElementHandle | null;
      if (activeElement) {
        const active = await this._describeInputTarget(activeElement);
        const decision = await this._classifyActiveInputTarget(
          element,
          activeElement as ElementHandle,
          beforeActivationMarker,
          beforeActivationMarked,
        );

        if (decision.useActive) {
          return {
            element: activeElement as ElementHandle,
            activation: {
              source: decision.source,
              requested: cloneInputTargetElementDiagnostics(requested),
              active: cloneInputTargetElementDiagnostics(active),
              chosen: cloneInputTargetElementDiagnostics(active),
            },
          };
        }

        await activeHandle.dispose();
        return {
          element,
          activation: {
            source: decision.source,
            requested: cloneInputTargetElementDiagnostics(requested),
            active: cloneInputTargetElementDiagnostics(active),
            chosen: cloneInputTargetElementDiagnostics(requested),
          },
        };
      }
      await activeHandle.dispose();
    } catch (error) {
      logger.debug(`Non-critical error resolving active input target: ${error}`);
    } finally {
      await this._clearEditableInputsBeforeActivationMarker(beforeActivationMarker);
    }

    return {
      element,
      activation: {
        source: 'requested_target_after_no_active',
        requested: cloneInputTargetElementDiagnostics(requested),
        chosen: cloneInputTargetElementDiagnostics(requested),
      },
    };
  }

  private async _activateInputTarget(element: ElementHandle): Promise<void> {
    await element.evaluate((el) => {
      if (!(el instanceof HTMLElement)) {
        return;
      }
      el.focus();
      el.click();
    });
  }

  private async _markEditableInputsBeforeActivation(marker: string): Promise<boolean> {
    if (!this._puppeteerPage) {
      return false;
    }

    try {
      await this._puppeteerPage.evaluate((propertyName) => {
        for (const element of document.querySelectorAll('input, textarea, [contenteditable]')) {
          (element as HTMLElement & Record<string, boolean | undefined>)[propertyName] = true;
        }
      }, marker);
      return true;
    } catch (error) {
      logger.debug(`Non-critical error marking pre-activation inputs: ${error}`);
      return false;
    }
  }

  private async _clearEditableInputsBeforeActivationMarker(marker: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    try {
      await this._puppeteerPage.evaluate((propertyName) => {
        for (const element of document.querySelectorAll('input, textarea, [contenteditable]')) {
          delete (element as HTMLElement & Record<string, boolean | undefined>)[propertyName];
        }
      }, marker);
    } catch (error) {
      logger.debug(`Non-critical error clearing pre-activation input marker: ${error}`);
    }
  }

  private async _classifyActiveInputTarget(
    requested: ElementHandle,
    active: ElementHandle,
    beforeActivationMarker: string,
    beforeActivationMarked: boolean,
  ): Promise<{ readonly useActive: boolean; readonly source: InputTargetActivationSource }> {
    try {
      return await requested.evaluate(
        (requestedElement, activeElement, marker, markerApplied) => {
          const isEditable = (element: Element): boolean => {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              return !element.disabled && !element.readOnly;
            }
            return element instanceof HTMLElement && element.isContentEditable;
          };

          if (requestedElement === activeElement || requestedElement.contains(activeElement)) {
            return { useActive: true, source: 'requested_target' as const };
          }

          const activeExistedBeforeActivation = markerApplied
            ? Boolean((activeElement as HTMLElement & Record<string, boolean | undefined>)[marker])
            : true;
          if (!isEditable(requestedElement) || !activeExistedBeforeActivation) {
            return { useActive: true, source: 'proxy_active_target' as const };
          }

          return { useActive: false, source: 'requested_target_after_unrelated_active' as const };
        },
        active,
        beforeActivationMarker,
        beforeActivationMarked,
      );
    } catch (error) {
      logger.debug(`Non-critical error classifying active input target: ${error}`);
      return { useActive: false, source: 'requested_target_after_unrelated_active' };
    }
  }

  private async _describeInputTarget(element: ElementHandle): Promise<InputTargetElementDiagnostics> {
    try {
      return await element.evaluate((el, internalNodeIdProperty) => {
        const descriptor: {
          tagName: string | null;
          id?: string;
          name?: string;
          type?: string;
          role?: string;
          placeholder?: string;
          ariaLabel?: string;
          internalNodeId?: string;
        } = {
          tagName: el.tagName ? el.tagName.toLowerCase() : null,
        };
        const attributes = [
          ['id', 'id'],
          ['name', 'name'],
          ['type', 'type'],
          ['role', 'role'],
          ['placeholder', 'placeholder'],
          ['aria-label', 'ariaLabel'],
        ] as const;
        for (const [attributeName, outputName] of attributes) {
          const value = el.getAttribute(attributeName)?.trim();
          if (value) {
            descriptor[outputName] = value;
          }
        }

        const internalNodeId =
          (el as unknown as Record<string, string | undefined>)[internalNodeIdProperty] ?? undefined;
        if (internalNodeId) {
          descriptor.internalNodeId = internalNodeId;
        }

        return descriptor;
      }, MAGICBROWSE_DOM_NODE_ID_PROPERTY);
    } catch (error) {
      logger.debug(`Non-critical error describing input target: ${error}`);
      return { tagName: null };
    }
  }

  private async _assertOriginalInputTargetCanResolve(element: ElementHandle): Promise<void> {
    const blockedReason = await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.disabled) return 'target_disabled';
        if (el.readOnly) return 'target_readonly';
      }
      return null;
    });

    if (blockedReason) {
      throw new Error(`Cannot input text: ${blockedReason}`);
    }
  }

  private async _assertCanInputText(element: ElementHandle): Promise<void> {
    const blockedReason = await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.disabled) return 'target_disabled';
        if (el.readOnly) return 'target_readonly';
        return null;
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        return null;
      }
      return 'target_not_editable';
    });

    if (blockedReason) {
      throw new Error(`Cannot input text: ${blockedReason}`);
    }
  }

  private async _typeIntoEditableElement(element: ElementHandle, text: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    const canUseKeyboard = await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        el.select();
        return !el.readOnly && !el.disabled;
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return true;
      }
      return false;
    });

    if (canUseKeyboard) {
      try {
        const currentValue = await this._readEditableValue(element);
        if (currentValue.length > 0) {
          await this._puppeteerPage.keyboard.press('Backspace');
        }
        await this._puppeteerPage.keyboard.type(text, { delay: 50 });
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.debug(`Keyboard input failed, falling back to direct setter: ${error}`);
      }
    }

    const value = await this._readEditableValue(element);
    if (value !== text) {
      await this._setEditableValue(element, text);
    }
  }

  private async _readEditableValue(element: ElementHandle): Promise<string> {
    return await element.evaluate(el => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.value;
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        return el.textContent ?? '';
      }
      return '';
    });
  }

  private async _setEditableValue(element: ElementHandle, text: string): Promise<void> {
    await element.evaluate((el, value) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (valueSetter) {
          valueSetter.call(el, value);
        } else {
          el.value = value;
        }
      } else if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = value;
      }

      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
  }

  /**
   * Wait for an element to become stable (no position/size changes)
   * Similar to Playwright's wait_for_element_state('stable')
   */
  private async _waitForElementStability(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();
    let lastRect = await element.boundingBox();

    while (Date.now() - startTime < timeout) {
      // Wait a short time
      await new Promise(resolve => setTimeout(resolve, 50));

      // Get current position and size
      const currentRect = await element.boundingBox();

      // If element is no longer in DOM or not visible
      if (!currentRect) {
        break;
      }

      // Compare with previous position/size
      if (
        lastRect &&
        Math.abs(lastRect.x - currentRect.x) < 2 &&
        Math.abs(lastRect.y - currentRect.y) < 2 &&
        Math.abs(lastRect.width - currentRect.width) < 2 &&
        Math.abs(lastRect.height - currentRect.height) < 2
      ) {
        // Position is stable - wait a bit more to be sure and then return
        await new Promise(resolve => setTimeout(resolve, 50));
        return;
      }

      // Update last position
      lastRect = currentRect;
    }

    // If we got here, either the element stabilized or we timed out
    logger.debug('Element stability check completed (timeout or stable)');
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 1000): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const isVisible = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();

        // Check if element has size
        if (rect.width === 0 || rect.height === 0) return false;

        // Check if element is hidden
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return false;
        }

        return true;
      });

      if (isVisible) break;

      // Check timeout - log warning and return instead of throwing
      if (Date.now() - startTime > timeout) {
        logger.warning('Timed out while trying to scroll element into view, continuing anyway');
        break;
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking
      // if (elementNode.highlightIndex !== null) {
      //   await this._updateState(useVision, elementNode.highlightIndex);
      // }

      const element = await this.locateElement(elementNode);
      if (!element) {
        throw new Error(`Element: ${elementNode} not found`);
      }
      await this._assertCanClickElement(element);

      // Scroll element into view if needed
      await this._scrollIntoViewIfNeeded(element);

      try {
        // First attempt: Use Puppeteer's click method with timeout
        await Promise.race([
          element.click(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
        ]);
        await this._checkAndHandleNavigation();
      } catch (error) {
        // if URLNotAllowedError, throw it
        if (error instanceof URLNotAllowedError) {
          throw error;
        }
        if (isTransientPuppeteerContextError(error)) {
          logger.info('Primary click hit transient page context churn; settling page:', error);
          await this.waitForPageAndFramesLoad();
          return;
        }
        // Second attempt: Use evaluate to perform a direct click
        logger.info('Failed to click element, trying again', error);
        try {
          await element.evaluate(el => (el as HTMLElement).click());
        } catch (secondError) {
          // if URLNotAllowedError, throw it
          if (secondError instanceof URLNotAllowedError) {
            throw secondError;
          }
          throw new Error(
            `Failed to click element: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to click element: ${elementNode}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async _assertCanClickElement(element: ElementHandle): Promise<void> {
    const blockedReason = await element.evaluate(el => {
      if (
        el instanceof HTMLButtonElement ||
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLOptionElement ||
        el instanceof HTMLOptGroupElement ||
        el instanceof HTMLFieldSetElement
      ) {
        if (el.disabled) return 'target_disabled';
      }
      if (el.getAttribute('aria-disabled') === 'true') return 'target_disabled';
      if (el instanceof HTMLElement && el.inert) return 'target_inert';
      if (el.closest('[inert]')) return 'target_inert';
      return null;
    });

    if (blockedReason) {
      throw new Error(`Cannot click element: ${blockedReason}`);
    }
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    // If there is no cached state, return an empty map
    if (this._cachedState === null) {
      return new Map();
    }
    // Otherwise return the cached state's selector map
    return this._cachedState.selectorMap;
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          logger.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    logger.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();

      // Check if the loaded URL is allowed
      if (this._puppeteerPage) {
        await this._checkAndHandleNavigation();
      }
    } catch (error) {
      if (error instanceof URLNotAllowedError) {
        throw error;
      }
      logger.warning('Page load failed, continuing...', error);
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    logger.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }

  /**
   * Check the current page URL and handle if it's not allowed
   * @throws URLNotAllowedError if the current URL is not allowed
   */
  private async _checkAndHandleNavigation(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    const currentUrl = this._puppeteerPage.url();
    if (!isUrlAllowed(currentUrl, this._config.allowedUrls, this._config.deniedUrls)) {
      const errorMessage = `URL: ${currentUrl} is not allowed`;
      logger.error(errorMessage);

      // Navigate to home page or about:blank
      const safeUrl = this._config.homePageUrl || 'about:blank';
      logger.info(`Redirecting to safe URL: ${safeUrl}`);

      try {
        await this._puppeteerPage.goto(safeUrl);
      } catch (error) {
        logger.error(`Failed to redirect to safe URL: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw new URLNotAllowedError(errorMessage);
    }
  }
}

function normalizeTagName(tagName: string | null): string | null {
  return tagName ? tagName.toLowerCase() : null;
}

function normalizeXPath(xpath: string | null): string | null {
  if (!xpath) {
    return null;
  }
  return xpath.startsWith('/') ? xpath : `/${xpath}`;
}

function domParentBranchPath(element: DOMElementNode): string[] {
  const branch: string[] = [];
  let current: DOMElementNode | null = element;
  while (current.parent !== null && current.tagName !== 'body') {
    if (current.tagName) {
      branch.push(current.tagName.toLowerCase());
    }
    current = current.parent;
  }
  return branch.reverse();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
