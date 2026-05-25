# `vendor/browser/dom/raw_types.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/dom/raw_types.ts` @ 322384f8

## Components

Pure type declarations — no runtime code:

- `RawDomTextNode` — `{ type, text, isVisible }` — the shape emitted by `buildDomTree.js` for text nodes.
- `RawDomElementNode` — the shape emitted by `buildDomTree.js` for element nodes. Includes visibility flags, viewport/interactivity markers, coordinate sets.
- `RawDomTreeNode` — union of the two.
- `BuildDomTreeArgs` — input shape for `window.buildDomTree(args)`.
- `PerfMetrics` — debug-only timing data.
- `BuildDomTreeResult` — `{ rootId, map, perfMetrics? }`.

## Footguns

- **`BuildDomTreeArgs` is under-specified.** The typed interface lists `showHighlightElements, focusHighlightIndex, viewportExpansion, debugMode?`. The actual `buildDomTree.js` implementation also requires `startId` and `startHighlightIndex` in args — without them, ID counter becomes NaN and the whole tree collapses to a single body node. See preflight.buildDomTree.smoke.test.ts. Record this in `docs/pitfalls.md`.
- `RawDomTreeNode` has no `type` discriminator on elements — you distinguish them by presence of `tagName`. Text nodes always have `type: "TEXT_NODE"`.

## Tests

No unit tests — pure types, covered indirectly by preflight and `dom/views.test.ts`.

## Phase C changes applied

None — only `.js` suffix on `from './history/view.js'` (toolchain-compat).
