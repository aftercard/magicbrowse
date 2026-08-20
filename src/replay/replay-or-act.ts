import { defaultSessionManager } from '../session-manager-instance.js';
import type { MagicBrowseLlmAdapter } from '../llm/types.js';
import type { MagicBrowseActResult, MagicBrowseManagedSession } from '../types.js';
import { replay } from './replay.js';
import type {
  MagicBrowseReplayEvent,
  MagicBrowseReplayOptions,
  MagicBrowseReplayResult,
} from './replay.js';

// Graceful-degradation composition: try a recorded flow when one is
// provided, and on an ordinary non-completed outcome — including thrown
// errors such as schema-invalid documents — continue with the plain agent
// path. Unknown-completion timeouts are the exception: another agent action
// could duplicate a write or click, so `needs_replan` is returned unchanged.

export interface MagicBrowseReplayOrActOptions {
  /** Recorded flow document, if the caller found an enabled one. */
  readonly flow?: unknown;
  readonly variables?: Readonly<Record<string, string>>;
  readonly headless?: boolean;
  readonly llmAdapter: MagicBrowseLlmAdapter;
  /** The delegated goal used for the agent fallback (and for act-only runs). */
  readonly goal: string;
  readonly maxSteps?: number;
  /** Start URL for the agent path when no flow ran (or replay never launched). */
  readonly startUrl?: string;
  readonly onReplayEvent?: (event: MagicBrowseReplayEvent) => void;
}

export interface MagicBrowseReplayOrActResult {
  /** Which path produced the final outcome. */
  readonly source: 'replay' | 'act_after_replay' | 'act';
  readonly replay?: MagicBrowseReplayResult;
  readonly replayError?: string;
  readonly act?: MagicBrowseActResult;
}

interface ReplayOrActDeps {
  readonly replayFn: (options: MagicBrowseReplayOptions) => Promise<MagicBrowseReplayResult>;
  readonly actFn: (options: {
    goal: string;
    maxSteps?: number;
    llmAdapter: MagicBrowseLlmAdapter;
  }) => Promise<MagicBrowseActResult>;
  readonly launchFn: (options: { url?: string; headless?: boolean }) => Promise<unknown>;
  readonly currentSessionFn: () => Promise<MagicBrowseManagedSession | undefined>;
}

export function composeReplayOrAct(deps: ReplayOrActDeps) {
  return async function replayOrAct(
    options: MagicBrowseReplayOrActOptions
  ): Promise<MagicBrowseReplayOrActResult> {
    let replayResult: MagicBrowseReplayResult | undefined;
    let replayError: string | undefined;

    if (options.flow !== undefined) {
      try {
        replayResult = await deps.replayFn({
          flow: options.flow,
          variables: options.variables,
          llmAdapter: options.llmAdapter,
          headless: options.headless,
          onEvent: options.onReplayEvent,
        });
        if (replayResult.status === 'completed') {
          return { source: 'replay', replay: replayResult };
        }
        if (replayResult.status === 'needs_replan') {
          return { source: 'replay', replay: replayResult };
        }
      } catch (error) {
        replayError = error instanceof Error ? error.message : String(error);
      }
    }

    // Agent fallback. If replay launched a session we continue inside it;
    // otherwise start from the caller's URL like the stock path always has.
    const session = await deps.currentSessionFn().catch(() => undefined);
    if (!session) {
      await deps.launchFn({ url: options.startUrl, headless: options.headless });
    }
    const act = await deps.actFn({
      goal: options.goal,
      maxSteps: options.maxSteps,
      llmAdapter: options.llmAdapter,
    });
    return {
      source: options.flow !== undefined ? 'act_after_replay' : 'act',
      replay: replayResult,
      replayError,
      act,
    };
  };
}

export const replayOrAct = composeReplayOrAct({
  replayFn: replay,
  actFn: (options) => defaultSessionManager.act(options),
  launchFn: (options) => defaultSessionManager.launch(options),
  currentSessionFn: () => defaultSessionManager.currentSession(),
});
