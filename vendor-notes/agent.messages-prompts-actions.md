# `vendor/agent/{types,history,messages,prompts,actions,event,agents/errors}.ts` + `vendor/utils.ts` + `vendor/services/guardrails/`

Sources: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/{agent,utils.ts,services/guardrails}/` @ 322384f8

## Components

This step vendors the **chrome-extension-independent** core of nanobrowser's agent layer:

- `agent/types.ts` (180 lines) — `AgentContext`, `AgentOptions`, `ActionResult` types and runtime container.
- `agent/history.ts` (29 lines) — `AgentStepHistory`, `StepRecord`.
- `agent/messages/views.ts` (87 lines) — `MessageHistory`, `ManagedMessage`, `MessageMetadata`.
- `agent/messages/utils.ts` (329 lines) — content filtering / wrapping for prompt-injection defense (uses guardrails).
- `agent/messages/service.ts` (440 lines) — `MessageManager` orchestrating message/state/action history, token-budget truncation, system prompt roundtrip.
- `agent/prompts/base.ts` (99 lines) — abstract `BasePrompt` base.
- `agent/prompts/navigator.ts` (34 lines) — navigator system + state prompt builders.
- `agent/prompts/planner.ts` (14 lines) — planner prompt wrapper.
- `agent/prompts/templates/{common,navigator,planner}.ts` — prompt strings (Markdown templates).
- `agent/actions/schemas.ts` (215 lines) — zod schemas for 20 navigator actions.
- `agent/actions/builder.ts` (707 lines) — action registry, builder methods that emit events and call Page methods.
- `agent/event/{types,manager}.ts` (~129 lines) — `AgentEvent`, `EventManager` pub/sub. Wave 1 CLI subscribes here to project to stdout.
- `agent/agents/errors.ts` (314 lines) — typed error classes thrown by agents.
- `vendor/utils.ts` (127 lines) — `getCurrentTimestampStr`, `repairJsonString` (jsonrepair), `convertZodToJsonSchema` (zod-to-json-schema).
- `vendor/services/guardrails/{index,patterns,sanitizer,types}.ts` (~505 lines) — security sanitization for untrusted page content.

Total ~2700 lines vendored, almost byte-identical to nanobrowser.

## Excised — not migrated

- **`agent/helper.ts`** (390 lines) — multi-LLM provider switcher (Anthropic, Google GenAI, xAI, Groq, Cerebras, Ollama, DeepSeek, OpenAI). The only consumer in nanobrowser was `background/index.ts` (the chrome extension entry point), not the agent layer itself. We use a single LLM via the legacy OpenRouter adapter (Шаг 6); helper.ts is not needed.
- **`agent/agents/{base,navigator,planner}.ts`, `agent/executor.ts`** — Шаг 5 work. Vendored later; planner/executor are now present under `src/vendor/agent/`.

## Phase A changes (mechanical)

- `import 'webextension-polyfill';` — none present in agent/, kept this transparent.
- `from '@src/background/log'` → `'../../adapter/logger.js'` (depth-relative).
- `from '@src/background/agent/<X>'` → relative to vendored copy.
- `from '@src/background/services/guardrails'` → vendored `'../../services/guardrails/index.js'`.
- `from '@src/background/utils'` → vendored `'../utils.js'`.
- `from '@extension/i18n'` → `'../../../adapter/i18n.js'` (Node-compatible adapter over copied nanobrowser locale catalogs).
- `.js` suffixes added on all relative imports.

## Phase A.5 (cross-package surgical)

- `agent/types.ts` imports `BrowserContext` — repointed from `vendor/browser/context.js` (chrome-extension version, not vendored) to `'../../browser/browser-context.js'` (our own from Шаг 3b). Vendor parity preserved at the import-shape level — only the path differs.

## Phase C (cleanup)

- `agent/helper.ts` deleted entirely (excised, see above).
- `@extension/i18n` adapter at `src/adapter/i18n.ts` loads the copied nanobrowser locale catalogs and applies Chrome-style placeholder substitutions.

## Adapter map

| nanobrowser import | replacement |
|---|---|
| `@src/background/log` | `src/adapter/logger.ts` |
| `@src/background/utils` | `src/vendor/utils.ts` (vendored) |
| `@src/background/services/guardrails` | `src/vendor/services/guardrails/` (vendored) |
| `@src/background/browser/context` | `src/browser/browser-context.ts` (our own from Шаг 3b) |
| `@extension/i18n` | `src/adapter/i18n.ts` + `src/adapter/i18n/locales/**` |
| `@extension/storage` (helper.ts only) | not needed (helper.ts excised) |
| `@langchain/{anthropic,google-genai,xai,groq,...}` | not needed (helper.ts excised) |

## Tests

- `vendor/agent/event/manager.test.ts` — 8 cases:
  - subscribe/emit, multi-subscriber, no-double-register, unsubscribe, clearSubscribers
  - emit with no subscribers, error swallowing in callback
  - AgentEvent constructor defaults
- `vendor/agent/actions/schemas.test.ts` — 21 cases:
  - canonical valid input for every one of 20 action schemas (done, search_google, go_to_url,
    go_back, click_element, input_text, switch_tab, open_tab, close_tab, cache_content,
    scroll_to_percent/top/bottom, previous_page, next_page, scroll_to_text, send_keys,
    get_dropdown_options, select_dropdown_option, wait)
  - rejection cases: non-integer index, missing required fields, partial done payload
- `vendor/agent/messages/views.test.ts` — 9 cases:
  - addMessage append + token accumulation
  - addMessage at position
  - removeMessage default-last + token subtraction
  - removeLastStateMessage: HumanMessage tail with len>2, no-op when len<=2 or last is AI
  - removeOldestMessage skips SystemMessage
  - MessageMetadata defaults
- `vendor/services/guardrails/guardrails.test.ts` — 14 cases (vendored from
  nanobrowser's own test suite, repaired imports):
  - Sanitization with zero-width chars, task overrides, role manipulation
  - filterExternalContent + filterExternalContentWithReport flows
  - wrapUntrustedContent + cleanEmptyTags

Total new tests: 52 (8 event + 21 schemas + 9 messages-views + 14 guardrails). Suite: 139 → 191.

## Tests deferred

- `messages/service.ts` (440 lines, complex state machine over messages + history + tokens) — characterized indirectly via guardrails tests that exercise `filterExternalContent` and `wrapUntrustedContent`. Direct snapshot tests left for if/when we modify it.
- `actions/builder.ts` (707 lines, depends on AgentContext/Page) — covered by Шаг 5 navigator tests where actions are exercised end-to-end.
- `prompts/navigator.ts` + `templates/navigator.ts` — also exercised end-to-end in Шаг 5.
- `prompts/planner.ts` + `templates/planner.ts` — covered through `vendor/agent/executor.test.ts`, which proves planner confirmation is the terminal authority.

## Footguns

- **`MessageHistory.removeMessage(-1)`** uses `splice(-1, 1)` — removes the last message. Watch for off-by-one if callers expect `index = length - 1` semantics; the function uses negative index splice semantics.
- **`removeLastStateMessage` requires `length > 2`**, not `>= 1` — to preserve at minimum the system prompt and the original user task message. Don't call this on a freshly-created history.
- **`@extension/i18n` is not the Chrome runtime** — the adapter reads bundled locale JSON from disk and chooses `MAGICBROWSE_LOCALE`, `LC_*`, or `LANG`, falling back to English.
- **Guardrails `IGNORED_URL_PATTERNS` and threat detection patterns** are static. They don't auto-update; if a new prompt-injection technique emerges, patterns.ts needs explicit addition.
- **`agent/types.ts` imports `BrowserContext` from our own module** — circular dependency potential if browser-context ever depends on agent types. Currently safe — browser-context is below agent in the dependency tree.
