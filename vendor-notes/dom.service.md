# `vendor/browser/dom/{parse,cross-frame}.ts` + `src/browser/dom-service.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/dom/service.ts` @ 322384f8

`service.ts` (634 lines) was the chrome-most-coupled file in nanobrowser. We
split it along its natural seam — pure algorithm vs. transport orchestration —
and treated the two halves differently:

## Vendored unchanged: algorithm

Files:
- `vendor/browser/dom/parse.ts` — `_parse_node`, `_constructDomTree`
- `vendor/browser/dom/cross-frame.ts` — `_visibleIFramesFailedLoading`,
  `_locateMatchingIframeNode`, `_getRawDomTreeNodes`, `_getMaxID`,
  `_getMaxHighlighIndex`, `constructFrameTree`

These contain no `chrome.*` calls. Logic preserved verbatim.

**Single signature change** in `constructFrameTree`: instead of calling
`chrome.scripting.executeScript({ target: { tabId, frameIds: [id] } })` on
line 242 of nanobrowser's original, the function now accepts a `BuildInFrame`
callback as its last parameter. The orchestrator (puppeteer-based or
chrome-extension-based) implements that callback.

This keeps the most fragile algorithm (cross-frame stitching with strict /
non-strict iframe matching, recursive subframe traversal, max-id tracking)
unchanged. Tests pin it on synthetic `BuildDomTreeResult` inputs without any
puppeteer or chrome dependency.

## Rewritten: orchestrator

File: `src/browser/dom-service.ts` (NOT vendored). Written for puppeteer.

| Original (nanobrowser) | Replacement |
|---|---|
| `chrome.scripting.executeScript({ tabId, func, args })` | `page.mainFrame().evaluate(fn, args)` |
| `chrome.scripting.executeScript({ tabId, allFrames: true, func })` | `Promise.all(page.frames().map(f => f.evaluate(fn)))` |
| `chrome.scripting.executeScript({ tabId, frameIds: [id], func })` | resolve via in-function `Map<number, Frame>`, then `frame.evaluate(fn, args)` |
| `chrome.webNavigation.getAllFrames({ tabId })` | `page.frames()` filtered to non-main, with synthetic `frameId` counter |
| `chrome.scripting.executeScript({ tabId, files: ['buildDomTree.js'] })` | `frame.evaluate(buildDomTreeSource)` (source read once from `vendor/buildDomTree.js`, cached in module-level variable) |

Frame ID synthesis is **scoped to a single `getState` call** — the `Map<Frame, number>` lives only inside the function that needs it. No global state, no
leaking handles between calls. `frameId` becomes opaque to the algorithm
(`constructFrameTree` only passes it through to the callback).

## Excised — not migrated

Two functions from nanobrowser's `service.ts` did not come over:
- `getMarkdownContent` — relies on `window.turn2Markdown`, which is a
  *different* nanobrowser inject script (`turn2markdown.js`) that we did not
  vendor. Not used in Wave 1.
- `getReadabilityContent` — same situation, depends on `window.parserReadability`.
  Not used in Wave 1.

If/when these are needed, the corresponding inject scripts must be vendored
alongside `buildDomTree.js`.

## Invariants preserved

- Empty `BuildDomTreeResult.map` or missing `rootId` raises
  `Failed to build DOM tree: No result returned or invalid structure`.
- `about:blank` and `chrome://*` URLs short-circuit to a minimal body
  `DOMElementNode` without injecting buildDomTree.
- `injectBuildDomTreeScripts` is idempotent — checks
  `typeof window.buildDomTree === 'function'` per frame before injecting.
- `removeHighlights` swallows per-frame errors (frame may be detached or
  cross-origin) and continues across remaining frames.
- `getScrollInfo` returns `[scrollY, visualViewportHeight, scrollHeight]` —
  matches the second variant in nanobrowser's source (the commented-out
  variant returning `[pixels_above, pixels_below]` was not adopted).

## Footguns

- **`buildDomTreeSource` is read from `vendor/buildDomTree.js`** at runtime via
  `fs.readFileSync` resolved relative to `import.meta.url`. If the package is
  bundled or moved, the relative path may break. Keep the file shipped
  alongside the JS output.
- **`startId` and `startHighlightIndex`** must be passed in args. `buildDomTree.js`
  destructures them — if undefined, `ID.current++` becomes `NaN`. Already
  documented in `docs/pitfalls.md`. The orchestrator always passes `0`/`0` for
  the main frame and `maxNodeId+1`/`maxHighlightIndex+1` for sub-frames (via
  `constructFrameTree`).
- **Cross-origin sub-frames** can throw on `frame.evaluate` (puppeteer has
  isolated worlds per frame, but cross-origin policies still apply). The
  orchestrator catches and logs, returning `null` from the buildInFrame
  callback. `constructFrameTree` then throws `Failed to build DOM tree`. This
  matches nanobrowser's behavior (chrome.scripting also throws on
  cross-origin where the extension lacks permission).
- **`constructFrameTree` is mutating**: it modifies `parentFramePage.map` and
  `iframeNode.children` in place. Tests rely on this behavior.

## Tests

- `vendor/browser/dom/parse.test.ts` — 9 cases (text/element parsing,
  fallbacks, tree linkage, selectorMap construction).
- `vendor/browser/dom/cross-frame.test.ts` — 10 cases (max-id helpers, iframe
  filtering, strict/non-strict matching, callback invocation, error
  propagation).
- `src/browser/dom-service.integration.test.ts` — 6 cases against real
  Chromium via `puppeteer.launch`: about:blank short-circuit, simple page DOM,
  parent linkage, idempotent injection, `removeHighlights` on
  never-injected page, `getScrollInfo` on tall page.

## Phase C changes applied

- Split into vendored (algorithm) + own (orchestrator).
- `constructFrameTree` signature: added `buildInFrame: BuildInFrame` parameter,
  removed the inline `chrome.scripting.executeScript` call.
- Logger replaced: `@src/background/log` → `../adapter/logger.js`.
- `getMarkdownContent`, `getReadabilityContent` not migrated (excised).
- `getClickableElements` exported as a thin wrapper over `getState` for parity
  with nanobrowser's API surface.
