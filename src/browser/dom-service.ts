// Orchestrator for DOM extraction. NOT vendored — written for puppeteer
// directly. Uses the vendored algorithmic helpers (`parse.ts`, `cross-frame.ts`)
// for tree construction and frame stitching.
//
// Replaces nanobrowser's `chrome.scripting.executeScript` / `chrome.webNavigation.getAllFrames`
// with `page.evaluate` / `frame.evaluate` / `page.frames()`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Frame, Page } from 'puppeteer-core';

import { createLogger } from '../adapter/logger.js';
import { _constructDomTree } from '../vendor/browser/dom/parse.js';
import {
  _getMaxHighlighIndex,
  _getMaxID,
  _visibleIFramesFailedLoading,
  constructFrameTree,
  type BuildInFrame,
  type BuildSubFrameArgs,
  type FrameInfo,
} from '../vendor/browser/dom/cross-frame.js';
import type { BuildDomTreeResult } from '../vendor/browser/dom/raw_types.js';
import { DOMElementNode, type DOMState } from '../vendor/browser/dom/views.js';
import { isNewTabPage } from '../vendor/browser/util.js';
import {
  FORM_MUTATION_JOURNAL_SOURCE_VERSION,
  installFormMutationJournal,
  readFormMutationWindow,
} from './form-mutation-journal.js';

const logger = createLogger('DOMService');

const __filename = fileURLToPath(import.meta.url);
const buildDomTreeSourcePath = path.resolve(path.dirname(__filename), '../vendor/buildDomTree.js');
let buildDomTreeSourceCache: string | null = null;
let buildDomTreeSourceVersionCache: string | null = null;

function getBuildDomTreeSource(): string {
  if (buildDomTreeSourceCache === null) {
    buildDomTreeSourceCache = fs.readFileSync(buildDomTreeSourcePath, 'utf8');
  }
  return buildDomTreeSourceCache;
}

function getBuildDomTreeSourceVersion(): string {
  if (buildDomTreeSourceVersionCache === null) {
    buildDomTreeSourceVersionCache = createHash('sha256')
      .update(getBuildDomTreeSource())
      .digest('hex');
  }
  return buildDomTreeSourceVersionCache;
}

export interface GetStateOptions {
  showHighlightElements?: boolean;
  focusElement?: number;
  viewportExpansion?: number;
  debugMode?: boolean;
}

interface BuildDomTreeWindow extends Window {
  __magicBrowseBuildDomTreeVersion?: string;
  buildDomTree?: (args: unknown) => BuildDomTreeResult | null;
}

/**
 * Inject the current buildDomTree.js source into every frame on the page.
 * Existing functions from an older CLI/package build are replaced, while a
 * matching source digest makes repeated calls idempotent.
 */
export async function injectBuildDomTreeScripts(page: Page): Promise<void> {
  const src = getBuildDomTreeSource();
  const sourceVersion = getBuildDomTreeSourceVersion();
  await Promise.all(
    page.frames().map(async (frame) => {
      try {
        await installFormMutationJournal(frame, FORM_MUTATION_JOURNAL_SOURCE_VERSION);
        const installed = await frame.evaluate(() => ({
          present: typeof (window as BuildDomTreeWindow).buildDomTree === 'function',
          version: (window as BuildDomTreeWindow).__magicBrowseBuildDomTreeVersion ?? null,
        }));
        if (!installed.present || installed.version !== sourceVersion) {
          await frame.evaluate(src);
          await frame.evaluate((version) => {
            (window as BuildDomTreeWindow).__magicBrowseBuildDomTreeVersion = version;
          }, sourceVersion);
        }
      } catch (err) {
        logger.error('failed to inject buildDomTree into frame', frame.url(), err);
      }
    })
  );
}

function emptyBodyDomState(): DOMState {
  const elementTree = new DOMElementNode({
    tagName: 'body',
    xpath: '',
    attributes: {},
    children: [],
    isVisible: false,
    isInteractive: false,
    isTopElement: false,
    isInViewport: false,
    parent: null,
  });
  return { elementTree, selectorMap: new Map(), formMutationFrames: [] };
}

async function collectFormMutationFrames(
  page: Page
): Promise<NonNullable<DOMState['formMutationFrames']>> {
  const mainFrame = page.mainFrame();
  return Promise.all(
    page.frames().map(async (frame) => {
      const base = {
        url: frame.url(),
        parentUrl: frame.parentFrame()?.url(),
        mainFrame: frame === mainFrame,
      };
      try {
        const window = await readFormMutationWindow(frame, 0);
        return {
          ...base,
          checkpoint: window.checkpoint,
          summaries: window.summaries,
          coverageAvailable: window.coverageAvailable,
          missing: false,
        };
      } catch {
        return {
          ...base,
          summaries: [],
          coverageAvailable: false,
          missing: true,
        };
      }
    })
  );
}

async function buildDomTreeInFrame(
  frame: Frame,
  args: BuildSubFrameArgs
): Promise<BuildDomTreeResult | null> {
  try {
    return (await frame.evaluate(
      (a) => (window as BuildDomTreeWindow).buildDomTree?.(a) ?? null,
      args as unknown
    )) as BuildDomTreeResult | null;
  } catch (err) {
    logger.error('buildDomTree evaluation failed in frame', frame.url(), err);
    return null;
  }
}

async function collectSubFrameInfo(
  subFrames: readonly Frame[],
  frameToId: Map<Frame, number>
): Promise<FrameInfo[]> {
  const collected = await Promise.all(
    subFrames.map(async (frame): Promise<FrameInfo | null> => {
      const id = frameToId.get(frame);
      if (id === undefined) return null;
      try {
        const info = await frame.evaluate(() => ({
          computedHeight: window.innerHeight,
          computedWidth: window.innerWidth,
          href: window.location.href,
          name: window.name,
          title: document.title,
        }));
        return {
          frameId: id,
          computedHeight: info.computedHeight,
          computedWidth: info.computedWidth,
          href: info.href,
          name: info.name,
          title: info.title,
        };
      } catch (err) {
        logger.warning('cannot collect frame info', frame.url(), err);
        return null;
      }
    })
  );
  return collected.filter((x): x is FrameInfo => x !== null);
}

/**
 * Get the DOMState (element tree + selector map) for the current page.
 * Returns an empty body for new-tab / chrome:// URLs.
 */
export async function getState(page: Page, options: GetStateOptions = {}): Promise<DOMState> {
  const url = page.url();
  if (isNewTabPage(url) || url.startsWith('chrome://')) {
    return emptyBodyDomState();
  }

  await injectBuildDomTreeScripts(page);

  const showHighlightElements = options.showHighlightElements ?? true;
  const focusElement = options.focusElement ?? -1;
  const viewportExpansion = options.viewportExpansion ?? 0;
  const debugMode = options.debugMode ?? false;

  const mainArgs: BuildSubFrameArgs = {
    showHighlightElements,
    focusHighlightIndex: focusElement,
    viewportExpansion,
    startId: 0,
    startHighlightIndex: 0,
    debugMode,
  };

  const mainFrame = page.mainFrame();
  const mainResult = (await mainFrame.evaluate(
    (a) => (window as BuildDomTreeWindow).buildDomTree?.(a) ?? null,
    mainArgs as unknown
  )) as BuildDomTreeResult | null;

  if (!mainResult || !mainResult.map || !mainResult.rootId) {
    throw new Error('Failed to build DOM tree: No result returned or invalid structure');
  }

  // The first extraction assigns the shared non-enumerable physical IDs.
  // Install/update journals once more so later mutations can reference those
  // IDs without the observer racing the extractor's shadow-specific scheme.
  await Promise.all(
    page
      .frames()
      .map((frame) =>
        installFormMutationJournal(frame, FORM_MUTATION_JOURNAL_SOURCE_VERSION).catch(
          () => undefined
        )
      )
  );

  let stitchedResult: BuildDomTreeResult = mainResult;

  const failedIframes = _visibleIFramesFailedLoading(mainResult);
  if (Object.values(failedIframes).length > 0) {
    const subFrames = page.frames().filter((f) => f !== mainFrame);

    const frameToId = new Map<Frame, number>();
    const idToFrame = new Map<number, Frame>();
    let nextId = 1;
    for (const f of subFrames) {
      frameToId.set(f, nextId);
      idToFrame.set(nextId, f);
      nextId += 1;
    }

    const allFramesInfo = await collectSubFrameInfo(subFrames, frameToId);

    const buildInFrame: BuildInFrame = async (frameInfo, args) => {
      const frame = idToFrame.get(frameInfo.frameId);
      if (!frame) return null;
      return buildDomTreeInFrame(frame, args);
    };

    const stitched = await constructFrameTree(
      showHighlightElements,
      focusElement,
      viewportExpansion,
      debugMode,
      mainResult,
      allFramesInfo,
      _getMaxID(mainResult),
      _getMaxHighlighIndex(mainResult),
      buildInFrame
    );
    stitchedResult = stitched.resultPage;
  }

  const [elementTree, selectorMap] = _constructDomTree(stitchedResult);
  const formMutationFrames = await collectFormMutationFrames(page);
  return { elementTree, selectorMap, formMutationFrames };
}

/**
 * Get the clickable elements DOMState for the current page (entry point used
 * by callers; exists for parity with nanobrowser's API).
 */
export async function getClickableElements(
  page: Page,
  options: GetStateOptions = {}
): Promise<DOMState> {
  return getState(page, options);
}

/**
 * Remove the playwright-highlight-container DOM nodes that buildDomTree creates
 * during scene capture. Runs across all frames.
 */
export async function removeHighlights(page: Page): Promise<void> {
  await Promise.all(
    page.frames().map(async (frame) => {
      try {
        await frame.evaluate(() => {
          const container = document.getElementById('playwright-highlight-container');
          if (container) container.remove();
          const highlighted = document.querySelectorAll(
            '[browser-user-highlight-id^="playwright-highlight-"]'
          );
          for (const el of Array.from(highlighted)) {
            el.removeAttribute('browser-user-highlight-id');
          }
        });
      } catch (err) {
        logger.error('failed to remove highlights', frame.url(), err);
      }
    })
  );
}

/**
 * Returns [scrollY, visualViewportHeight, scrollHeight] for the main frame.
 */
export async function getScrollInfo(page: Page): Promise<[number, number, number]> {
  const result = await page.mainFrame().evaluate(() => ({
    scrollY: window.scrollY,
    visualViewportHeight: window.visualViewport?.height || window.innerHeight,
    scrollHeight: document.body.scrollHeight,
  }));
  return [result.scrollY, result.visualViewportHeight, result.scrollHeight];
}
