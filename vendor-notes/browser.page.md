# `vendor/browser/page.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/page.ts` @ 322384f8 (1622 lines, 35 async methods)

## Components

A single `Page` class — the per-tab orchestrator over puppeteer that the agent layer drives. Methods cover:
- DOM scene capture (`getState`, `getClickableElements`, `getScrollInfo`, `getCachedState`, `getSelectorMap`)
- Element location (`locateElement`, `getElementByIndex`, `getDomElementByIndex`, `getElementScrollInfo`)
- Element actions (`clickElementNode`, `inputTextElementNode`, `selectDropdownOption`, `getDropdownOptions`)
- Page control (`navigateTo`, `refreshPage`, `goBack`, `goForward`, `sendKeys`, `takeScreenshot`)
- Scrolling (`scrollToPercent`, `scrollBy`, `scrollToPreviousPage`, `scrollToNextPage`, `scrollToText`)
- Stability waits (`waitForPageLoadState`, `waitForPageAndFramesLoad`, `_waitForStableNetwork`, `_waitForElementStability`)
- Lifecycle (`attachPuppeteer`, `detachPuppeteer`, `getContent`, `url`, `title`, `removeHighlight`)
- Helpers (`isFileUploader`, `_findNearestScrollableElement`, `_scrollIntoViewIfNeeded`, `_checkAndHandleNavigation`, `_addAntiDetectionScripts`, `_convertKey`)

## Approach: vendor + surgical patch

`page.ts` is **almost entirely pure puppeteer** — only 3 methods touch chrome-extension infrastructure (`attachPuppeteer`, `detachPuppeteer`, `_addAntiDetectionScripts`), accounting for ~50 lines out of 1622. The remaining ~30 methods are hard-won puppeteer logic (iframe traversal in `locateElement`, retry+fallback in `clickElementNode`, network-stability FSM in `_waitForStableNetwork` ~170 lines) that we do not want to rewrite.

Strategy: **vendor unchanged + surgical patch on the chrome-coupled bits**. The bulk of the file is byte-identical to nanobrowser's source.

## Phase A changes (mechanical, compile fixes)

- `import 'webextension-polyfill';` — removed.
- Deep `puppeteer-core/lib/esm/...` imports → public `from 'puppeteer-core'`. Kept `connect`/`ExtensionTransport` initially, both removed in Phase C.
- `import { ... } from './dom/service'` → our orchestrator `from '../../browser/dom-service.js'`. Signatures of `getClickableElements`/`removeHighlights`/`getScrollInfo` changed (they now take a `Page` and an options object, not `tabId`).
- `from '@src/background/log'` → `'../../adapter/logger.js'`.
- `.js` suffixes added on all relative imports.

## Phase A.5 changes (constructor + dom-service callers)

Required to make the file usable in node tests (no more `tabId → ExtensionTransport` flow):

- **Constructor signature** changed from `(tabId, url, title, config)` to `(puppeteerPage, config, tabId = 0)`. `_puppeteerPage` is set immediately. `_tabId` is opaque — preserved as a default-0 number for `BrowserContext` (Шаг 3b) to assign synthetic counter values.
- **`_validWebPage` derivation** moved to read `puppeteerPage.url()` instead of a string parameter. Behavior preserved: chrome://, chromewebstore.google.com, and non-http(s) URLs all yield `false`.
- **dom-service callers (3 places):** `_removeHighlights(this._tabId)` / `_getClickableElements(this._tabId, ...)` / `_getScrollInfo(this._tabId)` now pass `this._puppeteerPage` to our orchestrator. Each gained an extra `&& this._puppeteerPage` guard for null-safety.

## Phase C changes (after tests were pinning behavior)

- **`attachPuppeteer()`**: from a 25-line implementation that `connect`-ed via `ExtensionTransport.connectTab(tabId)` and called `_addAntiDetectionScripts`, to a 1-line no-op `return this._validWebPage && this._puppeteerPage !== null`. Stealth/anti-detection happens at `puppeteer.launch` time via `puppeteer-extra-plugin-stealth`, not per-page.
- **`detachPuppeteer()`**: from a `_browser.disconnect()` call inside `if (this._browser)`, to unconditionally nulling `_puppeteerPage` and resetting `_state`. We don't own the per-tab browser — `BrowserContext` owns the shared puppeteer Browser.
- **`_browser` field removed.** The recovery branch in `_updateState` (when `puppeteerPage.evaluate('1')` throws because the page is no longer accessible) now resolves the browser dynamically via `this._puppeteerPage?.browser()` instead of a stored field.
- Imports `connect`, `ExtensionTransport`, `ProtocolType`, `Browser` — removed.
- `_addAntiDetectionScripts` is **kept but no longer called** by any internal site (was only invoked from `attachPuppeteer`). Marked as dead code; can be promoted to a public method if a caller needs per-page injection later.

## Invariants preserved

- `getClickableElements`/`getScrollInfo`/`removeHighlight` are guarded by `_validWebPage` (returns `null` / `[0,0,0]` / no-op for invalid URLs).
- `getCachedState` returns `null` until the first `getState`. After that, `getSelectorMap` reads from the cache.
- `clickElementNode` retry-loop (Promise.race against 2s timeout, fall back to `element.evaluate('el.click()')`) — unchanged.
- `locateElement` iframe traversal (collect parents, reverse order, walk into `contentFrame()`) — unchanged.
- `inputTextElementNode` element stability check + tag-specific dispatch — unchanged.
- `_waitForStableNetwork` 170-line FSM with `IGNORED_URL_PATTERNS` filter — unchanged.
- `sendKeys` Mac/PC modifier mapping (Control→Meta on Mac), modifier release in `finally` — unchanged.

## Footguns

- **`_validWebPage` is set once at construction time** (cached). If the page later navigates from `about:blank` to `http://example.com`, `_validWebPage` stays `false`. For Wave 1 use case, `BrowserContext` constructs the wrapper Page **after** navigation completes, so this is fine. Consumers that construct Page on a blank URL and then navigate must reconstruct the wrapper.
- **`navigator.userAgent` access in `_convertKey`** runs in node (not in puppeteer page context). On Node 21+ `globalThis.navigator` is defined; tests rely on that. If running on older Node, the Mac modifier mapping silently picks the non-Mac branch.
- **`_addAntiDetectionScripts` writes `window.chrome = { runtime: {} }`** — this is an object literal in page context, not the chrome-extension API. Harmless but cosmetic; it shouldn't conflict with sites that expect `chrome.runtime`. If we ever expose this method publicly, document the override.
- **`_browser` recovery path** (when puppeteerPage becomes inaccessible) now relies on `puppeteerPage.browser()` returning a valid handle. If `puppeteerPage` is null (after detach), recovery is silently skipped.
- **`isFileUploader` recursion `maxDepth=3`** — won't detect file inputs nested deeper than 3 levels (forms with deep wrappers). Documented test case in `page.unit.test.ts`.

## Excised — not migrated

- `_addAntiDetectionScripts` is kept in the file but **no longer called**. Stealth is applied at the launch level via `puppeteer-extra-plugin-stealth`. If a caller wants per-page injection, they can promote the method to public.

## Tests

- `vendor/browser/page.unit.test.ts` — 27 cases against a minimal mock puppeteer Page:
  - Constructor + `_validWebPage` for http/https/about:blank/chrome://, chromewebstore
  - `tabId` default & explicit
  - `url()`/`title()` accessors via mocked Page
  - `getCachedState`/`getSelectorMap`/`getDomElementByIndex` empty-state behavior
  - `removeHighlight` no-op on invalid URL and on `displayHighlights=false`
  - `getClickableElements`/`getScrollInfo` guards
  - `isFileUploader` — 6 cases including `maxDepth=3` boundary
  - `attachPuppeteer`/`detachPuppeteer` Phase C behavior
  - `getContent` — null guard + delegation to `puppeteerPage.content()`
- `vendor/browser/page.integration.test.ts` — 15 cases against real Chromium via `node:http` fixture server (`src/__tests__/fixture-server.ts`):
  - `getClickableElements` returns DOMState with selectorMap
  - `getState` caches the result
  - `getSelectorMap` reads cache
  - `getScrollInfo` on a tall page
  - `getContent` returns HTML
  - `takeScreenshot` returns base64 jpeg
  - `navigateTo` enforces `URLNotAllowedError` on chrome://
  - `scrollBy` / `scrollToPercent` change `window.scrollY`
  - `locateElement` resolves to ElementHandle of correct tag
  - `clickElementNode` triggers click handler (data-attribute mutation)
  - `inputTextElementNode` populates input value
  - `getDropdownOptions` lists option text
  - `selectDropdownOption` changes selected value
  - `removeHighlight` removes the playwright-highlight-container

## Tests deferred (not in Шаг 3a)

`_waitForStableNetwork` (170-line FSM with 6 levels of resource filtering) is exercised indirectly by every `navigateTo` call in the integration tests. Direct characterization (controlled slow streams, `IGNORED_URL_PATTERNS` filtering, hard-timeout behavior, listener-leak safety) is left for a future test if/when this code is touched. Phase C did not modify `_waitForStableNetwork`.

## Adaptation map (chrome-coupled → puppeteer)

| Original (nanobrowser) | Replacement |
|---|---|
| `import 'webextension-polyfill';` | removed |
| `from 'puppeteer-core/lib/esm/puppeteer/...js'` (deep) | `from 'puppeteer-core'` (public) |
| `from './dom/service'` | `from '../../browser/dom-service.js'` (our orchestrator from Шаг 2) |
| `from '@src/background/log'` | `from '../../adapter/logger.js'` |
| `connect({ transport: ExtensionTransport.connectTab(tabId) })` in `attachPuppeteer` | constructor receives `puppeteerPage` directly |
| `_browser.pages()` recovery in `_updateState` | `_puppeteerPage.browser().pages()` |
| `_browser.disconnect()` in `detachPuppeteer` | removed (browser owned by `BrowserContext`) |
| Constructor `(tabId, url, title, config)` | `(puppeteerPage, config, tabId = 0)` |
