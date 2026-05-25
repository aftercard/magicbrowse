// Vendored from nanobrowser @ 322384f8b4d48d8614343e51efca68c85e64f90b
// chrome-extension/src/background/browser/dom/service.ts
//
// Cross-frame stitching algorithm — extracted from service.ts. The logic is
// preserved verbatim except for ONE adaptation: `constructFrameTree` no longer
// calls `chrome.scripting.executeScript` directly. Instead, the caller injects
// a `buildInFrame` callback that the orchestrator implements with its own
// transport (puppeteer `frame.evaluate` in our case, `chrome.scripting` in
// nanobrowser's original case).
//
// All other helpers (`_visibleIFramesFailedLoading`, `_locateMatchingIframeNode`,
// `_getRawDomTreeNodes`, `_getMaxID`, `_getMaxHighlighIndex`) are unchanged.

import { createLogger } from '../../../adapter/logger.js';
import type { BuildDomTreeResult, RawDomElementNode } from './raw_types.js';

const logger = createLogger('DOMService');

export interface FrameInfo {
  frameId: number;
  computedHeight: number;
  computedWidth: number;
  href: string | null;
  name: string | null;
  title: string | null;
}

export interface BuildSubFrameArgs {
  showHighlightElements: boolean;
  focusHighlightIndex: number;
  viewportExpansion: number;
  startId: number;
  startHighlightIndex: number;
  debugMode: boolean;
}

/**
 * Callback provided by the orchestrator: invoked by `constructFrameTree` to
 * build a DOM tree inside a specific sub-frame. Returns the same
 * `BuildDomTreeResult` shape that nanobrowser's original `chrome.scripting`
 * call returned.
 */
export type BuildInFrame = (frame: FrameInfo, args: BuildSubFrameArgs) => Promise<BuildDomTreeResult | null>;

export function _getMaxHighlighIndex(result: BuildDomTreeResult, priorMaxHighlightIndex?: number): number {
  return Math.max(
    priorMaxHighlightIndex ?? -1,
    ...Object.values(_getRawDomTreeNodes(result))
      .filter(node => node.highlightIndex != null)
      .map(node => node.highlightIndex ?? -1),
  );
}

export function _getMaxID(result: BuildDomTreeResult, priorMaxId?: number): number {
  return Math.max(priorMaxId ?? -1, parseInt(result.rootId));
}

export function _locateMatchingIframeNode(
  iframeNodes: Record<string, RawDomElementNode>,
  frameInfo: FrameInfo,
  strictComparison: boolean = true,
): RawDomElementNode | undefined {
  const result = Object.values(iframeNodes).find(iframeNode => {
    const frameHeight = parseInt(iframeNode.attributes['computedHeight']);
    const frameWidth = parseInt(iframeNode.attributes['computedWidth']);
    const frameName = iframeNode.attributes['name'];
    const frameUrl = iframeNode.attributes['src'];
    const frameTitle = iframeNode.attributes['title'];
    let heightMatch = false;
    let widthMatch = false;
    const nameMatch = !frameName || !frameInfo.name || frameInfo.name === frameName;
    let urlMatch;
    let titleMatch;
    if (strictComparison) {
      heightMatch = frameInfo.computedHeight === frameHeight;
      widthMatch = frameInfo.computedWidth === frameWidth;
      urlMatch = !frameUrl || !frameInfo.href || frameInfo.href === frameUrl;
      titleMatch = !frameTitle || !frameInfo.title || frameInfo.title === frameTitle;
    } else {
      const heightDifference = Math.abs(frameInfo.computedHeight - frameHeight);
      heightMatch =
        heightDifference < 10 || heightDifference / Math.max(frameInfo.computedHeight, frameHeight, 1) < 0.1;
      const widthDifference = Math.abs(frameInfo.computedWidth - frameWidth);
      widthMatch = widthDifference < 10 || widthDifference / Math.max(frameInfo.computedWidth, frameWidth, 1) < 0.1;
      urlMatch = true;
      titleMatch = true;
    }
    return heightMatch && widthMatch && nameMatch && urlMatch && titleMatch;
  });
  if (result == null && strictComparison) {
    return _locateMatchingIframeNode(iframeNodes, frameInfo, false);
  }
  return result;
}

export function _getRawDomTreeNodes(
  result: BuildDomTreeResult,
  tagName?: string,
): Record<string, RawDomElementNode> {
  const nodes: Record<string, RawDomElementNode> = {};
  for (const [id, nodeData] of Object.entries(result.map)) {
    if (nodeData == null || ('type' in nodeData && nodeData.type === 'TEXT_NODE')) {
      continue;
    }
    const elementData = nodeData as Exclude<typeof nodeData, { type: string }>;
    if (tagName != null && tagName !== elementData.tagName) {
      continue;
    }
    nodes[id] = elementData;
  }
  return nodes;
}

export function _visibleIFramesFailedLoading(result: BuildDomTreeResult): Record<string, RawDomElementNode> {
  const iframeNodes = _getRawDomTreeNodes(result, 'iframe');
  return Object.fromEntries(
    Object.entries(iframeNodes).filter(([, iframeNode]) => {
      const error = iframeNode.attributes['error'];
      const height = parseInt(iframeNode.attributes['computedHeight']);
      const width = parseInt(iframeNode.attributes['computedWidth']);
      const skipped = iframeNode.attributes['skipped'];
      return error != null && height > 1 && width > 1 && !skipped;
    }),
  );
}

/**
 * Stitch failed-loading iframes by recursively building DOM trees inside each
 * sub-frame and merging them into the parent's `BuildDomTreeResult`.
 *
 * Adaptation note: original nanobrowser version called `chrome.scripting.executeScript`
 * directly on line 242 of service.ts. Here we accept a `buildInFrame` callback
 * so the function stays platform-agnostic. All other behavior (matching,
 * recursion, max-id tracking) is preserved.
 */
export async function constructFrameTree(
  showHighlightElements: boolean,
  focusElement: number,
  viewportExpansion: number,
  debugMode: boolean,
  parentFramePage: BuildDomTreeResult,
  allFramesInfo: FrameInfo[],
  startingNodeId: number,
  startingHighlightIndex: number,
  buildInFrame: BuildInFrame,
): Promise<{ maxNodeId: number; maxHighlightIndex: number; resultPage: BuildDomTreeResult }> {
  const parentIframesFailedLoading = _visibleIFramesFailedLoading(parentFramePage);
  const failedLoadingFrames = allFramesInfo.filter(frameInfo => {
    return _locateMatchingIframeNode(parentIframesFailedLoading, frameInfo) != null;
  });
  const parentIframesFailedCount = Object.values(parentIframesFailedLoading).length;
  if (parentIframesFailedCount > failedLoadingFrames.length) {
    logger.warning(
      'Failed to locate some iframes that failed to load:',
      parentIframesFailedCount,
      'vs',
      failedLoadingFrames.length,
    );
  }

  let maxNodeId = startingNodeId;
  let maxHighlightIndex = startingHighlightIndex;

  for (const subFrame of failedLoadingFrames) {
    const subFramePage = await buildInFrame(subFrame, {
      showHighlightElements,
      focusHighlightIndex: focusElement,
      viewportExpansion,
      startId: maxNodeId + 1,
      startHighlightIndex: maxHighlightIndex + 1,
      debugMode,
    });

    if (!subFramePage || !subFramePage.map || !subFramePage.rootId) {
      throw new Error('Failed to build DOM tree: No result returned or invalid structure');
    }
    if (debugMode && subFramePage.perfMetrics) {
      logger.debug('DOM Tree Building Performance Metrics (sub-frame ' + subFrame.frameId + '):', subFramePage.perfMetrics);
    }
    if (!subFramePage.rootId) {
      continue;
    }

    maxNodeId = _getMaxID(subFramePage, maxNodeId);
    maxHighlightIndex = _getMaxHighlighIndex(subFramePage, maxHighlightIndex);

    parentFramePage.map = {
      ...parentFramePage.map,
      ...subFramePage.map,
    };

    const iframeNode = _locateMatchingIframeNode(parentIframesFailedLoading, subFrame);
    if (iframeNode == null) {
      const subFrameRootElement = subFramePage.map[subFramePage.rootId];
      logger.warning('Cannot locate the iframe node for:', subFrame, 'with root element:', subFrameRootElement);
    } else {
      iframeNode.children.push(subFramePage.rootId);
    }

    const childrenIframesFailedLoading = _visibleIFramesFailedLoading(subFramePage);
    const childrenIframesFailedCount = Object.values(childrenIframesFailedLoading).length;
    if (childrenIframesFailedCount > 0) {
      const result = await constructFrameTree(
        showHighlightElements,
        focusElement,
        viewportExpansion,
        debugMode,
        subFramePage,
        allFramesInfo,
        maxNodeId,
        maxHighlightIndex,
        buildInFrame,
      );
      maxNodeId = Math.max(maxNodeId, result.maxNodeId);
      maxHighlightIndex = Math.max(maxHighlightIndex, result.maxHighlightIndex);
    }
  }

  return {
    maxNodeId,
    maxHighlightIndex,
    resultPage: parentFramePage,
  };
}
