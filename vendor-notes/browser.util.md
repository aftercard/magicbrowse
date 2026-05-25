# `vendor/browser/util.ts`

Source: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/browser/util.ts` @ 322384f8

## Components

- **`isUrlAllowed(url, allowList, denyList)`** — URL firewall check.
- **`isNewTabPage(url)`** — predicate for blank/new-tab URLs.
- **`capTextLength(text, maxLength)`** — truncation with ellipsis suffix.

## Invariants

- Dangerous schemes (`javascript:`, `data:`, `file:`, `chrome://`, `chrome-extension://`, `vbscript:`, `ws:`, `wss:`, chromewebstore.google.com) are ALWAYS blocked regardless of firewall config. Adding new schemes here is a behavioural change — document it.
- Empty allow + empty deny → allow all. This means "no firewall configured" is permissive, not restrictive.
- `about:blank` is specifically whitelisted even when firewall is configured.
- Deny has precedence over allow at full-URL level; at domain level, deny also precedes allow.
- Invalid URL strings are denied by default (catch-all in try/catch) **unless** both lists are empty (in which case we short-circuit earlier and allow).
- Domain matching does suffix match (`domain.endsWith('.' + deniedEntry)` or exact). So `deny: ['evil.com']` blocks `tracker.evil.com` but not `notevil.com`.

## Footguns

- Port numbers are stripped from domain before matching — relying on port-specific allow/deny does not work (treated as same domain).
- `capTextLength` adds `...` even for text exactly `maxLength+1` — it doesn't balance the total length.
- The empty-deny short-circuit on unparseable URLs is subtle: `isUrlAllowed('not a url', [], [])` → `true` (short-circuit before parse); with any non-empty list → `false` (parse fails, catch returns false). Document + test both paths.

## Tests

`util.test.ts` — 15 assertions across dangerous schemes, firewall disabled, about:blank, deny/allow by domain, port handling, precedence, invalid URL.

## Phase C changes applied

None — no `@src/background/log` import, no chrome.* usage, no webextension-polyfill. Module is portable as-is.
