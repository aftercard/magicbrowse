# @aftercard-ai/magicbrowse

[![npm version](https://img.shields.io/npm/v/@aftercard-ai/magicbrowse)](https://www.npmjs.com/package/@aftercard-ai/magicbrowse) [![License](https://img.shields.io/badge/license-MIT%20%2B%20Apache--2.0-blue.svg)](THIRD_PARTY_NOTICES.md) [![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

Give your AI agent a real browser and a disciplined way to operate it.

MagicBrowse is an LLM-first browser automation runtime for systems that need
to work with real web pages. It drives Chromium over CDP with a planner and
navigator loop, while still exposing deterministic browser verbs for precise
click, type, fill, select, and press steps.

Your application stays in charge of business logic, credentials, approvals,
and orchestration. MagicBrowse owns the browser session, page observation,
goal-driven browser work, guarded deterministic actions, and diagnostics.

The package has four main parts:

- **Browser sessions** - `launch(...)`, `attach(...)`, `status(...)`,
  `close(...)`, and persisted current-session state under `MAGICBROWSE_HOME`.
- **Page understanding** - `observe(...)` and `screenshot(...)` return a
  redacted view of the active page and the actionable/fillable targets on it.
- **LLM-driven action** - `act(...)` runs the planner and navigator against an
  explicit LLM adapter and returns a typed terminal status.
- **Deterministic apply steps** - `click(...)`, `type(...)`, `fill(...)`,
  `select(...)`, and `press(...)` execute known actions without asking the LLM
  to invent values.

Typical workflow:

1. open a browser with `launch(...)` or connect to one with `attach(...)`;
2. ask what is on the page with `observe(...)`, or delegate a bounded goal with
   `act(...)`;
3. use deterministic verbs when you already know the target and value;
4. stop at Memory fill, approval, login, or human-verification edges and let
   the owning application decide what happens next;
5. close the session when the workflow is done.

That shape fits backend workers, CLIs, agent runtimes, browser handoff flows,
and application-specific checkout or form automation.

## Key Terms

Three terms come up repeatedly in the API:

- **`session`** - the managed browser session returned by `launch(...)` or
  `attach(...)`. Top-level calls use the current persisted session; the returned
  session object exposes the same operations pre-bound to that session id.
- **`targetRef`** - a stable reference returned by `observe(...)` for an
  actionable or fillable page element. Refs are tied to the page state that
  produced them. Navigation, route changes, or a major DOM re-render can make
  old refs stale, so call `observe(...)` again after meaningful page changes.
- **CDP** - the Chrome DevTools Protocol. Chrome, Chromium, Browserbase, and
  other browser providers can expose a CDP endpoint that MagicBrowse can launch
  or attach to.

MagicBrowse does not load `.env` files in the library entrypoint. Host
applications own configuration loading and pass credentials or LLM adapters
explicitly.

## Install

```bash
npm i @aftercard-ai/magicbrowse
```

The library is ESM-only and requires Node.js `>=18`.

If you want the operator-facing CLI, install the separate CLI package:

```bash
npm i -g @aftercard-ai/magicbrowse-cli@latest
```

`@aftercard-ai/magicbrowse` is the library package for imports. It does not
install the `magicbrowse` shell command.

## Quick Start

This example launches Chromium, asks the browser agent to read a page, and then
closes the session.

```ts
import {
  act,
  close,
  createDirectLlmAdapter,
  launch,
} from '@aftercard-ai/magicbrowse';

const llmAdapter = createDirectLlmAdapter({
  provider: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY,
  navigatorModel: 'google/gemini-2.5-flash',
  plannerModel: 'google/gemini-2.5-pro',
});

const session = await launch({
  url: 'https://news.ycombinator.com',
  headless: true,
});

try {
  const result = await act({
    goal: 'Report the title and current score of the front-page top story, then stop.',
    maxSteps: 5,
    llmAdapter,
    onEvent(event) {
      process.stderr.write(`[${event.actor}.${event.state}] ${event.details}\n`);
    },
  });

  if (result.status !== 'completed') {
    throw new Error(result.finalMessage ?? `MagicBrowse stopped with ${result.status}`);
  }

  process.stdout.write(`${result.finalMessage ?? 'Done.'}\n`);
} finally {
  await close({ sessionId: session.id });
}
```

`act(...)` requires an explicit LLM. Pass either a `MagicBrowseLlmAdapter` or a
LangChain `BaseChatModel`. There is no package-level environment fallback.

The built-in direct adapter supports `openai`, `azure-openai`, `anthropic`,
`deepseek`, `gemini`, `xai`, `groq`, `cerebras`, `ollama`, `openrouter`,
`llama`, and `custom` provider families. Product CLIs and apps can pass their
own backend adapter instead.

## Observe First, Then Act Precisely

Use `observe(...)` when your host application wants to inspect the page before
choosing a deterministic action.

```ts
import { click, launch, observe } from '@aftercard-ai/magicbrowse';

await launch({ url: 'https://example.com', headless: true });

const page = await observe({
  includeOrchestration: true,
});

const firstButton = page.orchestration?.actionTargets?.descriptors.find(
  (target) => target.kind === 'button'
);

if (firstButton) {
  await click({ target: firstButton });
}
```

Deterministic verbs do not call the LLM. They take the observed target plus
caller-supplied input and dispatch through the same browser executor used by
the LLM-driven path.

## Attach To An Existing Browser

If a browser already exposes a CDP endpoint, use `attach(...)` instead of
`launch(...)`.

Common CDP sources:

- local Chrome or Chromium started with `--remote-debugging-port`;
- Browserbase or another managed browser provider;
- any browser runtime that gives you a CDP WebSocket endpoint.

```ts
import { attach, observe } from '@aftercard-ai/magicbrowse';

const session = await attach({
  cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/browser-id',
});

const page = await observe({ sessionId: session.id });
process.stdout.write(`${page.plannerView}\n`);
```

Attach is not a different API family. It is the second entry point into the
same session manager, run store, and action executor used by `launch(...)`.

## Cloud Browsers

MagicBrowse can create or attach to Browserbase sessions when the host provides
Browserbase credentials in the process environment.

```ts
import { launch } from '@aftercard-ai/magicbrowse';

await launch({
  cloud: true,
  url: 'https://example.com',
});
```

Required Browserbase environment variables:

- `BROWSERBASE_API_KEY`
- `BROWSERBASE_PROJECT_ID`

Optional variables include `BROWSERBASE_REGION` and `BROWSERBASE_TIMEOUT`.
Cloud session metadata is persisted in the MagicBrowse session state, while
provider connection URLs are redacted from returned data.

## What Each Main API Does

| API | Use it when | Typical result |
| --- | --- | --- |
| `launch(options?)` | You need a new owned browser session | managed session, current session file, run record |
| `attach(options)` | You already have a running CDP browser | managed session bound to the external browser |
| `currentSession()` | You want the current persisted session handle | session object or `undefined` |
| `status()` | You want to know whether the current session is reachable | `browser_alive`, `browser_not_running`, or `browser_mismatch` |
| `observe(options?)` | You want a redacted page inventory | page identity, signals, action targets, fillable targets |
| `act(options)` | You want goal-driven browser work through planner + navigator | typed terminal status, steps, final message, optional handoff |
| `screenshot(options?)` | You want a screenshot of the active page | screenshot bytes or saved file metadata |
| `click(options)` | You know which observed target to click | deterministic action result |
| `type(options)` | You want to type text into an observed target | deterministic action result |
| `fill(options)` | You want to clear and fill an observed target | deterministic action result |
| `select(options)` | You want to choose an option on an observed select target | deterministic action result |
| `press(options)` | You want to send a key chord to the focused page | deterministic action result |
| `submitFormTarget(options)` | You want to submit a known observed form target | submit result |
| `markCaptchaResolved(options?)` | A human or approved solver resolved CAPTCHA on the current page | single-use trusted continuation marker |
| `close(options?)` | You are done with the browser | owned browser closed or attached session cleared |

Use machine-readable fields for control flow. `finalMessage` is for humans and
logs, not for parsing.

## Act Statuses

`MagicBrowseActResult.status` is intentionally typed:

- `completed` - the delegated browser task completed.
- `blocked` - the task cannot continue without missing input, a different
  strategy, or a page state change.
- `needs_handoff` - the task reached Memory-managed data, login/OTP, payment,
  identity/KYC data, CAPTCHA, or human verification.
- `needs_approval` - the next useful action would commit a consequential
  external side effect and needs explicit approval.
- `failed` - runtime, model, or browser-tool failure.
- `max_steps` - the step budget ended before a terminal decision.
- `cancelled` - caller or user cancellation.

For Memory fill boundaries, `needs_handoff` may include
`handoff: { kind: 'memory_fill', resumeObjective }`. After MagicPay completes
the Memory `plan-fill` / `apply-fill` workflow, call `act(...)` again with that
narrow `resumeObjective` to continue.

## Memory Fill

MagicBrowse keeps Memory orchestration outside the public root API. Host
applications should observe the page, plan through MagicPay Memory, apply the
approved fill, and then resume MagicBrowse with deterministic browser verbs
such as `fill(...)` and `select(...)` only when explicit values are already in
the host application's runtime boundary.

Core rules:

- Raw Memory values are not sent to the planner or navigator.
- Observe output and run records are redacted after Memory fills.
- Login, identity, checkout, payment, CAPTCHA, and human-verification edges
  stop as `needs_handoff` unless the caller uses the dedicated guarded path.
- Consequential external actions should go through the caller's approval flow
  before the browser continues.

## Session Persistence And Diagnostics

MagicBrowse stores current-session state and run diagnostics under
`MAGICBROWSE_HOME`.

Default location:

```text
~/.magicbrowse/
```

Important files:

- `current-session.json` - active session pointer, CDP endpoint, page identity,
  and run id.
- `runs/<runId>.json` - session events, act starts/results, executor events,
  LLM trace markers, page identity changes, close/detach events, and redacted
  browser observations.
- `run-index.json` - mapping from session ids to run ids, so repeated `act(...)`
  calls inside one session append to the same record.

Use a separate `MAGICBROWSE_HOME` per concurrent workflow. The default current
session file is a singleton.

```bash
MAGICBROWSE_HOME=/tmp/my-workflow node ./my-browser-worker.mjs
```

## Browser Safety Boundaries

MagicBrowse is designed for browser delegation, not unchecked autonomy.

- It should not type passwords, OTPs, payment details, identity details, API
  keys, private keys, or secrets through the LLM-driven `act(...)` path.
- It should not bypass CAPTCHA or human verification.
- It should not submit consequential external actions without caller approval.
- It should not invent missing user data.
- It should fail closed when semantic field matching is unavailable, invalid,
  or uncertain.

These boundaries are part of the runtime contract, not only prompt wording.

## CLI

The CLI lives in `@aftercard-ai/magicbrowse-cli`.

```bash
npm i -g @aftercard-ai/magicbrowse-cli@latest
magicbrowse --help
```

Common commands:

```bash
magicbrowse init <apiKey>
magicbrowse doctor
magicbrowse launch https://example.com
magicbrowse observe
magicbrowse act "Find the checkout button and stop before payment"
magicbrowse close
```

The CLI owns its credential loading and product integration behavior. The
library package remains explicit and host-controlled.

## Development

```bash
npm install
npm run check-types
npm run build
npm run lint
npm run pack:verify
npm run smoke:pack-install
```

Live browser-agent tests require provider credentials and are intentionally not
part of the default public verification workflow.

## License And Third Party Notices

aftercard-authored code is licensed under the MIT License. MagicBrowse also
includes adapted Nanobrowser components under Apache-2.0; see
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for provenance and license
details.

## Documentation

- Public package: <https://www.npmjs.com/package/@aftercard-ai/magicbrowse>
- Source repository: <https://github.com/aftercardAI/magicbrowse>
- CLI package: <https://www.npmjs.com/package/@aftercard-ai/magicbrowse-cli>
- Issues: <https://github.com/aftercardAI/magicbrowse/issues>

Vendor adaptation notes live in [`vendor-notes/`](./vendor-notes/) for
engineers who need to understand the bundled browser/planner internals.
