# `vendor/browser/dom/views.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/dom/views.ts` @ 322384f8

## Components

- **`DOMBaseNode`** — abstract base with `isVisible` + `parent`.
- **`DOMTextNode`** — text leaf. Methods: `hasParentWithHighlightIndex()`, `isParentInViewport()`, `isParentTopElement()`.
- **`DOMElementNode`** — element with children, attributes, visibility flags, optional coordinates/viewport info. Key methods:
  - `getAllTextTillNextClickableElement(maxDepth = -1)` — collects text from descendants, stopping at highlighted elements. Used for LLM-facing descriptions.
  - `clickableElementsToString(includeAttributes)` — produces the indexed `[N]<tag attr=val>text</tag>` representation that the LLM consumes.
  - `getEnhancedCssSelector()` — builds an enhanced CSS selector (used by history service).
- **`DEFAULT_INCLUDE_ATTRIBUTES`** — allowlist of attributes relevant for LLM. Defines which attributes get rendered in `clickableElementsToString`.
- **`DOMState`** — interface `{ elementTree, selectorMap }` — output of the full DOM service pipeline.

## Invariants

- `parent` is `null` for root nodes. Populated during construction by caller (see `test-utils.buildElement`).
- `highlightIndex === null` means "not clickable" (used as the filter for `getClickableElements`).
- `getAllTextTillNextClickableElement` pre-order DFS, short-circuits at any descendant `DOMElementNode` with non-null `highlightIndex`. This isolates the text belonging to THIS clickable from text belonging to nested clickables. Critical for LLM correctness — a button inside a nav should not absorb the nav's text.
- `clickableElementsToString` deduplicates attributes whose values are identical (only for values of length > 5), keeping the earliest in `includeAttributes` order. Token-saving optimization described in code comments as "heavy vibes, but it seems good enough for saving tokens".
- Attributes matching text content are stripped (`aria-label`, `placeholder`, `title`) when they equal the text case-insensitively.

## Footguns

- `children` field typed as `DOMBaseNode[]` — callers must use `instanceof DOMElementNode` narrowing, there's no discriminator.
- `DOMElementNode` constructor takes a params object, but TS allows partial match → missing booleans default via `??` (most default to `false`/`null`). Easy to forget `isInteractive: true` and silently get non-clickable behaviour.
- `getAllTextTillNextClickableElement` with `maxDepth=-1` means unlimited; any non-negative value enables truncation including `0` which means only the current node's text.

## Tests

`views.test.ts` — 10+ assertions:
- DOMTextNode parent-walk (highlighted ancestor, in-viewport, orphan).
- Parent linkage preservation through `buildElement`.
- `getAllTextTillNextClickableElement` with nested highlighted children (does not leak text).
- `maxDepth` respected (positive + negative).
- `clickableElementsToString` emits `[N]` prefix + attribute filtering.

## Phase C changes applied

None — only `.js` suffix on 3 relative imports.
