# `vendor/browser/dom/history/{view,service}.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/dom/history/` @ 322384f8

## Components

### `view.ts`

- `HashedDomElement` — tuple `(branchPathHash, attributesHash, xpathHash)` used for identity comparisons.
- `Coordinates`, `CoordinateSet`, `ViewportInfo` — geometry types emitted by `buildDomTree.js`.
- `DOMHistoryElement` — persistable snapshot of an element at a point in time, with `toDict()` for serialization.

### `service.ts`

- **`convertDomElementToHistoryElement(domElement)`** — snapshot a live element into a `DOMHistoryElement`.
- **`findHistoryElementInTree(history, tree)`** → `Promise<DOMElementNode | null>` — locate the matching element in a new DOM state by hash identity. Used for rebinding after navigation/mutation.
- **`compareHistoryElementAndDomElement(history, element)`** → `Promise<boolean>` — identity check.
- **`hashDomElement(element)`** → `Promise<HashedDomElement>` (three-tuple variant, unlike the flat string version in `clickable/service.ts`).
- **`HistoryTreeProcessor`** — namespace re-export of all functions + private helpers.

## Invariants

- Identity is determined by the triple `(branchPathHash, attributesHash, xpathHash)`. `highlightIndex` is **not** part of the identity — after page mutation, the same element can have a different highlight index but still be considered identical.
- `convertDomElementToHistoryElement` stores the enhanced CSS selector computed by `domElement.getEnhancedCssSelector()`. This is the selector that survives navigation for action dispatch.
- `findHistoryElementInTree` does full recursive DFS. Returns the **first** match in DFS order; undefined behaviour when multiple DOM elements hash-collide (unlikely in practice but possible with crafted DOMs).
- `_getParentBranchPath` in `service.ts` is **subtly different** from the one in `clickable/service.ts`: here it starts with the element itself INCLUDED and walks `while parent !== null`. Because the element has a parent by definition if it's a descendant, this includes the descendant chain from topmost-visible-ancestor down to the element.

## Footguns

- Two `hashDomElement` functions exist in the codebase: one in `clickable/service.ts` returns a joined string; this one returns a `HashedDomElement` object with three fields. They produce **the same hash components** but different return shapes. Don't cross-import.
- `_parentBranchPathHash` returns empty string for empty branch path — so a root element (no parent chain) has `branchPathHash === ''`. Two roots with different attributes still differentiate via attributesHash.
- `compareHistoryElementAndDomElement` runs two hash operations in parallel — both involve WebCrypto calls. On huge trees this can be slow; `findHistoryElementInTree` is effectively O(n) hash operations.
- `_textHash` is defined but only used internally (in `HistoryTreeProcessor` namespace export); the actual hash for identity does NOT include text. This is intentional — text may change while the element is the same.

## Tests

`history/service.test.ts` — 8+ named cases:
- Branch path: empty for root, correct for deep descendant.
- `hashDomElement` shape (three string fields) and determinism.
- `convertDomElementToHistoryElement` carries over all fields including fallback empty strings for null tagName/xpath.
- `findHistoryElementInTree` matches by hash when the element's highlightIndex changed (the rebind use case).
- `findHistoryElementInTree` returns null when the element disappeared or has different attributes.
- `compareHistoryElementAndDomElement` — true/false as expected.
- `HistoryTreeProcessor` namespace exposes functions.

## Phase C changes applied

None — only `.js` suffix on imports (toolchain-compat).
