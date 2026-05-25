// Vendored from nanobrowser @ 322384f8b4d48d8614343e51efca68c85e64f90b
// chrome-extension/src/background/browser/dom/service.ts
//
// Pure parsing helpers extracted from `service.ts`. They contain no chrome.*
// calls and no I/O — they only transform `BuildDomTreeResult` shapes into the
// `DOMElementNode` tree the rest of the system consumes.

import type { BuildDomTreeResult, RawDomTreeNode } from './raw_types.js';
import { type DOMBaseNode, DOMElementNode, DOMTextNode } from './views.js';
import type { ViewportInfo } from './history/view.js';

/**
 * Parse a raw DOM node and return the node object and its children IDs.
 */
export function _parse_node(nodeData: RawDomTreeNode): [DOMBaseNode | null, string[]] {
  if (!nodeData) {
    return [null, []];
  }

  if ('type' in nodeData && nodeData.type === 'TEXT_NODE') {
    const textNode = new DOMTextNode(nodeData.text, nodeData.isVisible, null);
    return [textNode, []];
  }

  const elementData = nodeData as Exclude<RawDomTreeNode, { type: string }>;

  let viewportInfo: ViewportInfo | undefined = undefined;
  if ('viewport' in nodeData && typeof nodeData.viewport === 'object' && nodeData.viewport) {
    const viewportObj = nodeData.viewport as { width: number; height: number };
    viewportInfo = {
      width: viewportObj.width,
      height: viewportObj.height,
      scrollX: 0,
      scrollY: 0,
    };
  }

  const elementNode = new DOMElementNode({
    tagName: elementData.tagName,
    xpath: elementData.xpath,
    attributes: elementData.attributes ?? {},
    children: [],
    isVisible: elementData.isVisible ?? false,
    isInteractive: elementData.isInteractive ?? false,
    isTopElement: elementData.isTopElement ?? false,
    isInViewport: elementData.isInViewport ?? false,
    highlightIndex: elementData.highlightIndex ?? null,
    shadowRoot: elementData.shadowRoot ?? false,
    internalNodeId: elementData.internalNodeId ?? null,
    parent: null,
    viewportInfo,
  });

  const childrenIds = elementData.children || [];
  return [elementNode, childrenIds];
}

/**
 * Constructs a DOM tree from the evaluated page data.
 */
export function _constructDomTree(evalPage: BuildDomTreeResult): [DOMElementNode, Map<number, DOMElementNode>] {
  const jsNodeMap = evalPage.map;
  const jsRootId = evalPage.rootId;

  const selectorMap = new Map<number, DOMElementNode>();
  const nodeMap: Record<string, DOMBaseNode> = {};

  for (const [id, nodeData] of Object.entries(jsNodeMap)) {
    const [node] = _parse_node(nodeData);
    if (node === null) {
      continue;
    }
    nodeMap[id] = node;
    if (node instanceof DOMElementNode && node.highlightIndex !== undefined && node.highlightIndex !== null) {
      selectorMap.set(node.highlightIndex, node);
    }
  }

  for (const [id, node] of Object.entries(nodeMap)) {
    if (node instanceof DOMElementNode) {
      const nodeData = jsNodeMap[id];
      const childrenIds = 'children' in nodeData ? nodeData.children : [];
      for (const childId of childrenIds) {
        if (!(childId in nodeMap)) {
          continue;
        }
        const childNode = nodeMap[childId];
        childNode.parent = node;
        node.children.push(childNode);
      }
    }
  }

  const htmlToDict = nodeMap[jsRootId];
  if (htmlToDict === undefined || !(htmlToDict instanceof DOMElementNode)) {
    throw new Error('Failed to parse HTML to dictionary');
  }
  return [htmlToDict, selectorMap];
}
