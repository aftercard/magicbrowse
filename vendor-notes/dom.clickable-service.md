# `vendor/browser/dom/clickable/service.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/dom/clickable/service.ts` @ 322384f8

## Components

- **`getClickableElements(tree)`** — iterative pre-order DFS returning all descendants with non-null `highlightIndex`. Stack-based to avoid stack overflow on deep DOMs.
- **`getClickableElementsHashes(tree)`** → `Promise<Set<string>>` — maps clickable elements to SHA-256 hashes combining parent branch path, attributes, xpath.
- **`hashDomElement(element)`** → `Promise<string>` — hash for a single element.
- **`ClickableElementProcessor`** — namespace re-export of the above for parity with the Python codebase.

## Invariants

- Hash format: `${branchPathHash}-${attributesHash}-${xpathHash}` where each component is a SHA-256 of a UTF-8 encoded string. The outer combination is NOT re-hashed (`_hashString` is identity).
- Hash is **stable** across equal-shape trees — the same DOM state produces the same hash.
- Hash **changes** if any of these change: attributes (even one), xpath, branch path (tagNames of ancestors).
- `getClickableElements` preserves **document pre-order** — clickables appear in the order they appeared in the source HTML.
- Text children are never returned; only `DOMElementNode` descendants with `highlightIndex !== null`.

## Footguns

- `parentBranchPath` includes the element itself AND its ancestors up to (but not including) root with `parent === null`. Check `_getParentBranchPath` — it walks while `parent !== null`. So root's hash has an empty branch path.
- `_parentBranchPathHash` joins with `/` — a tree with `body > section > a` hashes the string `body/section/a`.
- `_attributesHash` concatenates without separator (`${key}=${value}`). Attribute with value `key=other` COULD in principle collide with a different attribute set, though unlikely in practice.
- `_xpathHash` uses empty string for null xpath. Two elements with `xpath: null` vs `xpath: ''` hash identically.
- Relies on `crypto.subtle.digest('SHA-256', ...)` — works in browser and Node 18+ (WebCrypto API). No polyfill needed in our puppeteer-attached context since everything runs server-side.

## Tests

`clickable/service.test.ts` — 7 named cases:
- Returns only non-null-highlightIndex nodes.
- Deep trees (20 levels) do not overflow and preserve pre-order.
- Text nodes ignored in traversal.
- Determinism: same tree → same hash.
- Sensitivity: different attributes/xpath/branch path → different hash.
- Empty attributes + empty xpath still produces a non-empty hash string.
- Namespace `ClickableElementProcessor` exposes the same functions.

## Phase C changes applied

None — only `.js` suffix on `from '../views.js'` (toolchain-compat).
