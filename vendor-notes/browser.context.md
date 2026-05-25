# `src/browser/browser-context.ts`

Source: NOT vendored. Written from scratch for puppeteer.

This module replaces `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/context.ts`
(360 lines, almost entirely `chrome.tabs.*`-coupled, 50 lines of event-listener glue
in `waitForTabEvents`). Nanobrowser's logic was inseparable from chrome-extension
infrastructure — there was no algorithmic core to vendor.

Our version is ~210 lines, owns a puppeteer `Browser`, and exposes the same surface
the agent layer expects: `getCurrentPage`, `openTab`, `closeTab`, `switchTab`,
`navigateTo`, `getTabInfos`, `getAllTabIds`, `getState`, `getCachedState`,
`removeHighlight`, `cleanup`, `updateConfig`.

## Design

- **Identity:** synthetic `tabId` counter (`_nextTabId`), starts at 1, monotonically
  increasing. The vendored `Page` wrapper (Шаг 3a) accepts `tabId` as its third
  constructor parameter and stores it as opaque metadata.
- **Three internal maps:**
  - `_attachedPages: Map<number, Page>` — tabId → wrapper.
  - `_puppeteerPageByTabId: Map<number, PuppeteerPage>` — needed for `closeTab` /
    `switchTab` to call methods on the underlying puppeteer Page (the wrapper
    intentionally hides its `_puppeteerPage` private field).
  - `_tabIdByPuppeteerPage: WeakMap<PuppeteerPage, number>` — used to detect
    re-registration when a puppeteer Page we already saw shows up again.
- **No event listeners** for navigation completion. Nanobrowser's
  `waitForTabEvents` orchestrated `chrome.tabs.onUpdated/onActivated` over multiple
  resolution conditions (url + title + status=complete + activated). We use
  `puppeteer.Page.goto({ waitUntil: 'domcontentloaded' })` which already blocks
  until DOM is ready. If callers need a stricter wait, they can use the
  vendored `Page.waitForPageAndFramesLoad()` from Шаг 3a.
- **`cleanup` does NOT close the browser.** The caller (the entity that called
  `puppeteer.launch`) owns the Browser lifecycle. `cleanup` only detaches our
  wrappers and clears internal state. This avoids surprising the launcher with
  a closed browser.

## Adaptation map

| Original (chrome.tabs.*) | Replacement |
|---|---|
| `chrome.tabs.create({ url, active: true })` | `browser.newPage()` + `puppeteerPage.goto(url, { waitUntil: 'domcontentloaded' })` + `bringToFront()` |
| `chrome.tabs.update(tabId, { url, active: true })` | wrapper Page's `navigateTo(url)` (which uses `puppeteerPage.goto`) |
| `chrome.tabs.update(tabId, { active: true })` | `puppeteerPage.bringToFront()` |
| `chrome.tabs.remove(tabId)` | `puppeteerPage.close()` |
| `chrome.tabs.query({ active: true, currentWindow: true })` | tracked manually in `_currentTabId` |
| `chrome.tabs.query({})` | iteration of `_attachedPages` |
| `chrome.tabs.onUpdated/onActivated` event listeners | not migrated — `goto` already waits |
| `chrome.tabs.Tab` type | replaced by `PuppeteerPage` (we don't expose chrome types) |

## Footguns

- **`getTabInfos` filters by non-empty `url+title`.** If a tab is at `about:blank`
  with empty title, it won't show up. Matches nanobrowser behavior.
- **`_nextTabId` is per-instance.** Two `BrowserContext`s sharing the same
  Browser will assign overlapping tabIds — they don't share counters. Don't
  share Browsers across contexts unless you know what you're doing.
- **`closeTab` swallows `puppeteerPage.close()` errors** — if puppeteer throws
  on close (e.g., page was already closed), we still clear the maps. This is
  intentional — we want cleanup to be idempotent.
- **`removeHighlight` early-returns when `_currentTabId === null`.** It does NOT
  trigger `getCurrentPage()` to materialize one (that would be surprising side
  effect). Callers should ensure a tab exists before calling.

## Tests

- `src/browser/browser-context.unit.test.ts` — 15 cases against mock
  `Browser`/`Page` (vi.fn-based stubs):
  - `getCurrentPage` reuses existing puppeteer pages, creates one when none, idempotent
  - `openTab` validates URL via `isUrlAllowed`, calls goto+bringToFront,
    assigns monotonic tabIds
  - `closeTab` closes underlying page, clears maps, clears `_currentTabId` if it
    was the closed tab, no-op for unknown tabId
  - `switchTab` throws on unknown tabId, returns wrapper, calls bringToFront
  - `navigateTo` enforces URLNotAllowedError
  - `getAllTabIds`, `getTabInfos`
  - `cleanup` clears maps, does NOT close browser
  - `updateConfig` merges
- `src/browser/browser-context.integration.test.ts` — 8 cases against real
  Chromium via `node:http` fixture server:
  - `openTab` actually navigates and the wrapper has `validWebPage=true`
  - `navigateTo` from current page reaches new URL
  - `closeTab` removes from internal map (verified via `getAllTabIds`)
  - `switchTab` brings tab to front (visible URL)
  - `getTabInfos` returns metadata for both tabs
  - `navigateTo` URLNotAllowedError on chrome://
  - `getState` returns BrowserState with tabs + selectorMap
  - `cleanup` doesn't close browser — second BrowserContext over same browser still works
