import { defaultSessionManager } from '../session-manager-instance.js';
import type {
  MagicBrowseActionTargetDescriptor,
  MagicBrowseFillableTargetDescriptor,
  MagicBrowseObserveResult,
} from '../types.js';
import type { MagicBrowseLlmAdapter } from '../llm/types.js';
import { isBrowserActionDeadlineError } from '../runtime/browser-action-deadline.js';
import {
  parseFlowDefinition,
  type MagicBrowseFlowDefinition,
  type MagicBrowseFlowStep,
} from './flow-schema.js';
import {
  resolveFlowTarget,
  substituteVariables,
  targetQueryMatches,
  type ReplayCandidate,
} from './resolve.js';

// replay(): execute a recorded flow deterministically with per-step healing
// and scoped agent blocks. Sits beside act()/observe() as pure orchestration
// over the public session APIs — no vendored-agent changes. Ordinary
// non-"completed" statuses may fall back to plain act(); unknown-completion
// timeouts return `needs_replan` and categorically do not. Replay itself never
// throws for flow-level problems.

export interface MagicBrowseReplayEvent {
  readonly kind:
    | 'entry'
    | 'step.ok'
    | 'step.skipped'
    | 'step.heal'
    | 'step.agent'
    | 'verify'
    | 'done';
  readonly stepIndex?: number;
  readonly detail: string;
}

export interface MagicBrowseReplayOptions {
  /** Flow document (raw JSON or already-parsed definition). */
  readonly flow: unknown;
  /** Call-time variable bindings; merged over the recording's defaults. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Required for heal and recorded agent steps; omit for pure-deterministic flows. */
  readonly llmAdapter?: MagicBrowseLlmAdapter;
  readonly headless?: boolean;
  /**
   * Reuse the current live session (deterministic navigation to the entry
   * URL) instead of launching a browser — saves several seconds per flow
   * when running flows back to back. Falls back to launch when no session
   * exists.
   */
  readonly reuseSession?: boolean;
  readonly onEvent?: (event: MagicBrowseReplayEvent) => void;
}

export type MagicBrowseReplayStatus =
  | 'completed'
  | 'needs_replan'
  | 'entry_precondition_failed'
  | 'verify_failed'
  | 'failed';

export interface MagicBrowseReplayResult {
  readonly status: MagicBrowseReplayStatus;
  readonly flowId: string;
  readonly wallClockMs: number;
  readonly stepsReplayed: number;
  readonly scopedAgentCalls: number;
  readonly healedSteps: readonly { step: number; reason: string }[];
  readonly verifyDetail?: string;
  readonly failure?: string;
  /** The timed-out action may have completed before its acknowledgement stalled. */
  readonly completionState?: 'unknown';
  readonly retryable?: true;
  readonly mutationState?: 'unknown';
  /** Recovery is intentionally outside this replay attempt. */
  readonly recovery?: 'fresh_observe_required';
  readonly failureReason?: 'action_timeout' | 'action_cancelled';
}

interface PageState {
  readonly plannerView: string;
  readonly candidates: readonly ReplayCandidate[];
}

interface ReplayStepAttempt {
  readonly ok: boolean;
  readonly reason: string;
  readonly completionUnknown?: true;
  readonly interruptionReason?: 'action_timeout' | 'action_cancelled';
}

type ScopedAgentOutcome = 'completed' | 'timed_out' | 'cancelled' | 'failed';

function toCandidates(observation: MagicBrowseObserveResult): readonly ReplayCandidate[] {
  const action = observation.orchestration?.actionTargets?.descriptors ?? [];
  const fillable = observation.orchestration?.fillableTargets?.descriptors ?? [];
  const submit = observation.orchestration?.submitTargets ?? [];
  return [
    ...action.map((d) => ({ source: 'action' as const, ...d })),
    // Submit targets are click-compatible action descriptors (same contract
    // the CLI relies on for `click <target-id>` of submit buttons).
    ...submit.map((d) => ({
      source: 'action' as const,
      ...(d as unknown as MagicBrowseActionTargetDescriptor),
    })),
    ...fillable.map((d) => ({ source: 'fillable' as const, ...d })),
  ];
}

async function readPageState(): Promise<PageState> {
  const observation = await defaultSessionManager.observe({ includeOrchestration: true });
  return { plannerView: observation.plannerView, candidates: toCandidates(observation) };
}

function describeHealGoal(
  step: Extract<MagicBrowseFlowStep, { target: unknown }>,
  variables: Readonly<Record<string, string>>
): string {
  const value =
    'value' in step ? ` with the value "${substituteVariables(step.value, variables)}"` : '';
  return (
    `Perform exactly one step on the current page: ${step.action} the element best matching ` +
    `this recorded descriptor ${JSON.stringify(step.target)}${value}. The page may have changed ` +
    `since recording — find the element that serves the same purpose. Emit done immediately ` +
    `after that single action. Never enter card, password, or login data.`
  );
}

function currentTabLine(plannerView: string): string {
  return plannerView.split('\n').find((line) => line.startsWith('Current tab:')) ?? '';
}

export async function replay(options: MagicBrowseReplayOptions): Promise<MagicBrowseReplayResult> {
  const startedAt = Date.now();
  const flow: MagicBrowseFlowDefinition = parseFlowDefinition(options.flow);
  const variables = { ...flow.variables, ...(options.variables ?? {}) };
  const emit = (event: MagicBrowseReplayEvent) => options.onEvent?.(event);
  const healedSteps: { step: number; reason: string }[] = [];
  let stepsReplayed = 0;
  let scopedAgentCalls = 0;

  const finish = (
    status: MagicBrowseReplayStatus,
    extra: Partial<
      Pick<
        MagicBrowseReplayResult,
        | 'verifyDetail'
        | 'failure'
        | 'completionState'
        | 'retryable'
        | 'mutationState'
        | 'recovery'
        | 'failureReason'
      >
    > = {}
  ): MagicBrowseReplayResult => ({
    status,
    flowId: flow.id,
    wallClockMs: Date.now() - startedAt,
    stepsReplayed,
    scopedAgentCalls,
    healedSteps,
    ...extra,
  });

  const finishUnknownCompletion = (
    stepIndex: number | undefined,
    action: MagicBrowseFlowStep['action'] | 'observe',
    failureReason: 'action_timeout' | 'action_cancelled' = 'action_timeout'
  ): MagicBrowseReplayResult => {
    const failure = `${
      stepIndex === undefined ? 'replay observation' : `step ${stepIndex}: ${action}`
    } ${failureReason}; completion unknown`;
    emit({
      kind: 'done',
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      detail: `needs_replan: ${failure}`,
    });
    return finish('needs_replan', {
      failure,
      failureReason,
      completionState: 'unknown',
      retryable: true,
      mutationState: 'unknown',
      recovery: 'fresh_observe_required',
    });
  };

  const readReplayPageState = async (
    stepIndex?: number
  ): Promise<
    | { readonly status: 'ready'; readonly page: PageState }
    | { readonly status: 'interrupted'; readonly result: MagicBrowseReplayResult }
  > => {
    try {
      return { status: 'ready', page: await readPageState() };
    } catch (error) {
      if (!isBrowserActionDeadlineError(error)) {
        throw error;
      }
      return {
        status: 'interrupted',
        result: finishUnknownCompletion(stepIndex, 'observe', error.code),
      };
    }
  };

  const runScopedAgent = async (
    goal: string,
    maxSteps: number,
    timeoutMs: number | undefined
  ): Promise<ScopedAgentOutcome> => {
    if (!options.llmAdapter) return 'failed';
    scopedAgentCalls += 1;
    const result = await defaultSessionManager.act({
      goal,
      maxSteps,
      llmAdapter: options.llmAdapter,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (result.status === 'completed') return 'completed';
    if (result.status === 'timed_out') return 'timed_out';
    return result.status === 'cancelled' && result.mutationState === 'unknown'
      ? 'cancelled'
      : 'failed';
  };

  // Entry: the recorded deep link, then the precondition staleness gate.
  const entryUrl = substituteVariables(flow.entry.url, variables);
  const existing = options.reuseSession
    ? await defaultSessionManager.currentSession().catch(() => undefined)
    : undefined;
  if (existing) {
    await defaultSessionManager.navigateCurrentSession(entryUrl);
  } else {
    await defaultSessionManager.launch({ url: entryUrl, headless: options.headless ?? true });
  }
  emit({ kind: 'entry', detail: `${entryUrl}${existing ? ' (session reused)' : ''}` });
  // Telemetry marker; failures here must never affect the replay itself.
  void defaultSessionManager
    .recordSessionRunEvent({
      type: 'replay.start',
      message: `replay ${flow.id} v${flow.version ?? 1}`,
      data: { flowId: flow.id, version: flow.version ?? 1, taskClass: flow.taskClass },
    })
    .catch(() => undefined);
  const initialPageState = await readReplayPageState();
  if (initialPageState.status === 'interrupted') {
    return initialPageState.result;
  }
  let page = initialPageState.page;
  // Precondition gate with settle retries: a slow page load must read as
  // "wait and look again", not as a stale recording.
  const preconditionNeedles = (flow.entry.precondition?.textIncludes ?? []).map((needle) =>
    substituteVariables(needle, variables)
  );
  for (let attempt = 1; preconditionNeedles.length > 0; attempt += 1) {
    const missing = preconditionNeedles.find((needle) => !page.plannerView.includes(needle));
    if (!missing) break;
    if (attempt >= 3) {
      return finish('entry_precondition_failed', {
        failure: `entry precondition not met after ${attempt} attempts: "${missing}"`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const settledPageState = await readReplayPageState();
    if (settledPageState.status === 'interrupted') {
      return settledPageState.result;
    }
    page = settledPageState.page;
  }

  for (const [index, step] of flow.steps.entries()) {
    if (step.waitMs) await new Promise((resolve) => setTimeout(resolve, step.waitMs));
    // waitMs implies reobserve: waiting is useless against a stale snapshot.
    if (step.reobserve || step.waitMs) {
      const reobservedPageState = await readReplayPageState(index);
      if (reobservedPageState.status === 'interrupted') {
        return reobservedPageState.result;
      }
      page = reobservedPageState.page;
    }

    if (step.action === 'agent') {
      const outcome = await runScopedAgent(
        substituteVariables(step.goal, variables),
        step.maxSteps ?? 10,
        step.timeoutMs
      );
      if (outcome === 'timed_out') return finishUnknownCompletion(index, step.action);
      if (outcome === 'cancelled') {
        return finishUnknownCompletion(index, step.action, 'action_cancelled');
      }
      if (outcome !== 'completed') {
        return finish('failed', { failure: `step ${index}: agent block did not complete` });
      }
      stepsReplayed += 1;
      emit({ kind: 'step.agent', stepIndex: index, detail: 'agent block completed' });
      continue;
    }

    if (step.action === 'press') {
      const result = await defaultSessionManager.press({
        keys: step.keys,
        ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      });
      if (result.status !== 'completed') {
        if (result.reason === 'action_timeout' || result.reason === 'action_cancelled') {
          return finishUnknownCompletion(index, step.action, result.reason);
        }
        return finish('failed', { failure: `step ${index}: press ${step.keys} ${result.status}` });
      }
      stepsReplayed += 1;
      emit({ kind: 'step.ok', stepIndex: index, detail: `press ${step.keys}` });
      continue;
    }

    const attempt = async (): Promise<ReplayStepAttempt> => {
      // An element can appear as both an action target and a fillable target;
      // resolve against the pool that matches the step's verb so the same
      // element never reads as ambiguous with itself.
      const pool = page.candidates.filter((candidate) =>
        step.action === 'click' ? candidate.source === 'action' : candidate.source === 'fillable'
      );
      const resolved = resolveFlowTarget(pool, step.target);
      if (!resolved.hit) {
        return { ok: false, reason: `descriptor miss (${resolved.matchCount} matches)` };
      }
      const candidate = resolved.candidate;
      const value = 'value' in step ? substituteVariables(step.value, variables) : undefined;
      const result =
        step.action === 'click'
          ? await defaultSessionManager.click({
              target: candidate as unknown as MagicBrowseActionTargetDescriptor,
              ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
            })
          : step.action === 'select'
            ? await defaultSessionManager.select({
                target: candidate as unknown as MagicBrowseFillableTargetDescriptor,
                optionText: value ?? '',
                ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
              })
            : step.action === 'type'
              ? await defaultSessionManager.type({
                  target: candidate as unknown as MagicBrowseFillableTargetDescriptor,
                  text: value ?? '',
                  ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
                })
              : await defaultSessionManager.fill({
                  target: candidate as unknown as MagicBrowseFillableTargetDescriptor,
                  value: value ?? '',
                  ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
                });
      if (
        result.status !== 'completed' &&
        (result.reason === 'action_timeout' || result.reason === 'action_cancelled')
      ) {
        return {
          ok: false,
          reason: `${step.action} ${result.reason}`,
          completionUnknown: true,
          interruptionReason: result.reason,
        };
      }
      return result.status === 'completed'
        ? { ok: true, reason: '' }
        : { ok: false, reason: `${step.action} ${result.status}` };
    };

    let outcome = await attempt();
    if (outcome.completionUnknown) {
      return finishUnknownCompletion(
        index,
        step.action,
        outcome.interruptionReason ?? 'action_timeout'
      );
    }
    if (!outcome.ok && !step.optional && outcome.reason.includes('(0 matches)')) {
      // Settle retry: a zero-match miss right after navigation usually means
      // the page hasn't finished rendering, not that the recording is stale.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const settledPageState = await readReplayPageState(index);
      if (settledPageState.status === 'interrupted') {
        return settledPageState.result;
      }
      page = settledPageState.page;
      outcome = await attempt();
      if (outcome.completionUnknown) {
        return finishUnknownCompletion(
          index,
          step.action,
          outcome.interruptionReason ?? 'action_timeout'
        );
      }
    }
    if (outcome.ok) {
      stepsReplayed += 1;
      emit({ kind: 'step.ok', stepIndex: index, detail: step.action });
      continue;
    }
    if (step.optional) {
      emit({ kind: 'step.skipped', stepIndex: index, detail: outcome.reason });
      continue;
    }
    emit({ kind: 'step.heal', stepIndex: index, detail: outcome.reason });
    const healed = await runScopedAgent(
      describeHealGoal(step, variables),
      step.healMaxSteps ?? 6,
      step.timeoutMs
    );
    if (healed === 'timed_out') {
      return finishUnknownCompletion(index, 'agent');
    }
    if (healed === 'cancelled') {
      return finishUnknownCompletion(index, 'agent', 'action_cancelled');
    }
    if (healed !== 'completed') {
      return finish('failed', {
        failure: `step ${index}: ${outcome.reason}; heal unavailable or failed`,
      });
    }
    healedSteps.push({ step: index, reason: outcome.reason });
    stepsReplayed += 1;
    const healedPageState = await readReplayPageState(index);
    if (healedPageState.status === 'interrupted') {
      return healedPageState.result;
    }
    page = healedPageState.page;
  }

  // Terminal contract: deterministic verification, never an LLM judgment.
  const verificationPageState = await readReplayPageState();
  if (verificationPageState.status === 'interrupted') {
    return verificationPageState.result;
  }
  page = verificationPageState.page;
  const problems: string[] = [];
  if (flow.verify.urlIncludes) {
    const expected = substituteVariables(flow.verify.urlIncludes, variables);
    if (!currentTabLine(page.plannerView).includes(expected)) {
      problems.push(`url does not include "${expected}"`);
    }
  }
  for (const needle of flow.verify.textIncludes ?? []) {
    if (!page.plannerView.includes(substituteVariables(needle, variables))) {
      problems.push(`page text does not include "${needle}"`);
    }
  }
  // requiredTargets is an existence assertion (>=1 match), not an action
  // target: ambiguity is fine when nothing will be clicked.
  const dedupedByRef = [...new Map(page.candidates.map((c) => [c.ref, c])).values()];
  for (const query of flow.verify.requiredTargets ?? []) {
    if (!dedupedByRef.some((candidate) => targetQueryMatches(candidate, query))) {
      problems.push(`required target missing: ${JSON.stringify(query)}`);
    }
  }
  for (const query of flow.verify.requiredValues ?? []) {
    const prefix = query.valueStartsWith ?? '';
    if (prefix && !page.plannerView.includes(`value=${prefix}`)) {
      problems.push(`required value missing: ${prefix}`);
    }
  }
  const verifyDetail = problems.length === 0 ? 'all checks passed' : problems.join('; ');
  emit({ kind: 'verify', detail: verifyDetail });
  const status = problems.length === 0 ? 'completed' : 'verify_failed';
  emit({ kind: 'done', detail: status });
  const result = finish(status, { verifyDetail });
  void defaultSessionManager
    .recordSessionRunEvent({
      type: 'replay.complete',
      message: `replay ${flow.id} ${status}`,
      data: {
        flowId: flow.id,
        version: flow.version ?? 1,
        status,
        wallClockMs: result.wallClockMs,
        stepsReplayed: result.stepsReplayed,
        scopedAgentCalls: result.scopedAgentCalls,
        healedSteps: result.healedSteps,
        verifyDetail,
      },
    })
    .catch(() => undefined);
  return result;
}
