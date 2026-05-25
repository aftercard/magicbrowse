# `vendor/browser/views.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/views.ts` @ 322384f8

## Components

Pure types — configuration shapes and contract boundaries for the browser/page/context layer:

- `PageId`, `TabInfo` — tab identification.
- `BrowserState` — full snapshot: `{ url, title, tabs, screenshot?, elementTree, selectorMap, ...scrollInfo }`.
- `BrowserStateHistory` — state at a point in time (used by executor's step history).
- `URLNotAllowedError` — thrown by URL firewall.
- `BrowserContextConfig`, `DEFAULT_BROWSER_CONTEXT_CONFIG` — config bag for `browser/context.ts`.

## Invariants

- `BrowserState.selectorMap` is `Record<number, DOMElementNode>` keyed by `highlightIndex`. This is THE lookup structure between LLM action output (`click[5]`) and the live DOM node.
- Coordinate types flow from `dom/history/view` — same shapes used for geometry throughout.
- `BrowserContextConfig` defaults (likely in the actual module, not verified line-by-line yet): `homePageUrl: 'chrome://newtab/'` or similar chrome-extension-ish default; these get replaced in our `context.ts` rewrite (Step 3).

## Footguns

- `BrowserState` is emitted by `browser/page.ts` (`getState()`). Its shape is part of what the agent layer consumes — changing it ripples through messages/prompts.
- `chrome://newtab/` defaults won't work in a puppeteer-owned browser — in Step 3, swap to `about:blank` or configurable.

## Tests

No unit tests — pure types, covered indirectly by integration tests in Step 3.

## Phase C changes applied

None — only `.js` suffix on 2 relative type imports.
