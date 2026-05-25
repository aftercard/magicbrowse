# `vendor/agent/agents/{base,planner,navigator}.ts` + `vendor/agent/executor.ts`

Sources: `https://github.com/nanobrowser/nanobrowser/tree/322384f8b4d48d8614343e51efca68c85e64f90b/chrome-extension/src/background/agent/{agents/{base,planner,navigator},prompts/planner,prompts/templates/planner,executor}.ts` @ 322384f8

## Components

- `agent/agents/base.ts` (227 lines) — `BaseAgent` abstract class with `invoke()` (calls LLM via `BaseChatModel.completionWithRetry` or `withStructuredOutput`), `parseModelOutput`, response validation. Provider-aware (different LangChain APIs need different invocation patterns).
- `agent/agents/navigator.ts` (678 lines) — concrete `NavigatorAgent extends BaseAgent`. Builds dynamic zod schema from registered actions, runs one execution step (state → LLM → parsed action[] → invoke each action → emit events → return done flag). Handles iframe state revalidation via `BrowserStateHistory`.
- `agent/agents/planner.ts`, `prompts/planner.ts`, `prompts/templates/planner.ts` — concrete `PlannerAgent` and planner prompt. Planner judges web/non-web work, writes high-level next steps, and owns final task completion confirmation.
- `agent/executor.ts` — top-level orchestrator: constructs Planner + Navigator + AgentContext + EventManager, runs the step loop, emits TASK_*/STEP_* events, handles cancel/pause/resume, and requires planner confirmation before `TASK_OK`.

## Adapter map

| nanobrowser import | replacement |
|---|---|
| `@src/background/log` | `src/adapter/logger.ts` |
| `@src/background/utils` | `src/vendor/utils.ts` |
| `@src/background/browser/{dom/views,views,dom/history/{service,view}}` | vendored under `vendor/browser/` |
| `@src/background/browser/context` | `src/browser/browser-context.ts` (our own) |
| `@extension/i18n` | `src/adapter/i18n.ts` + `src/adapter/i18n/locales/**` |
| `@extension/storage` (ProviderTypeEnum, GeneralSettingsConfig) | `src/adapter/storage-stubs.ts` |
| `@extension/storage/lib/chat` (chatHistoryStore) | `src/adapter/storage-stubs.ts` (no-op) |
| `../services/analytics` | `src/adapter/analytics-stub.ts` (no-op) |

## Phase C surgical changes

### `agent/agents/navigator.ts`

- `Set.isSubsetOf` (ES2025, line 396) replaced with manual loop. ES2025 lib not yet enabled in our tsconfig and the helper is trivial.
- `convertZodToJsonSchema, repairJsonString` import path — now `'../../utils.js'` (our vendored copy).

### `agent/executor.ts`

- Planner integration is preserved. `execute()` follows nanobrowser's authority split:
  planner runs at `planningInterval` and after navigator reports `done`; navigator
  executes actions; `TASK_OK` is emitted only when the latest planner output has
  `done === true`.
- `import.meta.env.DEV` (Vite-specific) → `process.env.NODE_ENV === 'development'`.
- `extraArgs.plannerLLM` is honored and defaults to `navigatorLLM`.

Other excisions for adapter shape:

- `analytics.trackTask*` calls now hit a no-op stub but signatures preserved (variadic).
- `chatHistoryStore.{loadAgentStepHistory,storeAgentStepHistory}` calls now hit stub returning `null` / no-op. `replayHistory()` method preserved but will throw on missing history (early-returns with `t('exec_replay_historyNotFound')`).

## Tests

- `vendor/agent/agents/navigator.test.ts` — 3 cases on `NavigatorActionRegistry`:
  - register + lookup by name
  - undefined for missing
  - duplicate name overwrites
- `vendor/agent/executor.test.ts` — fake-LLM executor characterization:
  - planner confirmation, not navigator `done`, is task-completion authority
  - max-steps failure when navigator `done` cannot be planner-confirmed

`setupModelOutputSchema` (which constructs the dynamic zod schema for LLM
output) is exercised end-to-end in Шаг 9 live tests where the navigator
runs against a real LLM and a real ActionBuilder. Unit-mocking `Action`
shape is too coupled to internals to be meaningful here.

## Footguns

- **Navigator `done` consumes one more loop turn.** A tiny `maxSteps` budget can
  fail with `exec_errors_maxStepsReached` after a successful-looking navigator
  `done` action because the planner did not get a chance to confirm completion.
- **`process.env.NODE_ENV === 'development'`** is the only environment-aware
  branch left. CLI runners that don't set NODE_ENV (most production cases)
  will skip the verbose history-debug log. Set `NODE_ENV=development` when
  diagnosing executor flow.
- **`chatHistoryStore` stub silently no-ops on writes.** If `generalSettings.replayHistoricalTasks` is true, `executor.execute()` calls `storeAgentStepHistory`, which does nothing. Replay across runs requires a real persistent store.
