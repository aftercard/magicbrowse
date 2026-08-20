import type { Browser, Page as PuppeteerPage } from 'puppeteer-core';

import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import { BrowserContext } from '../browser/browser-context.js';
import {
  buildActionTargetDescriptors,
  buildMemoryFieldTargetDescriptors,
  buildSubmitTargetDescriptors,
  type BrowserStateTargetSource,
} from '../resolution/targets.js';
import { readPageIdentity } from '../transport/page-resolver.js';
import type { MagicBrowseActivePageIdentity, MagicBrowseObserveResult } from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import { redactSensitiveText, type ExactValueRedactionProfiles } from '../redaction.js';
import { buildBrowserPageSnapshot } from '../vendor/agent/prompts/browser-state-description.js';
import { DEFAULT_AGENT_OPTIONS } from '../vendor/agent/types.js';
import { randomUUID } from 'node:crypto';
import {
  createTargetObservationLease,
  type TargetObservationLease,
} from '../resolution/target-observation-lease.js';

export interface ExecuteMagicBrowseObserveInput {
  readonly browser: Browser;
  readonly page: PuppeteerPage;
  readonly displayHighlights: boolean;
  readonly includeOrchestration?: boolean;
  readonly viewportExpansion?: number;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly observeId?: string;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
}

export interface ExecuteMagicBrowseObserveResult {
  readonly result: MagicBrowseObserveResult;
  readonly activePageIdentity: MagicBrowseActivePageIdentity;
  readonly observationLeases: readonly TargetObservationLease[];
}

export async function executeMagicBrowseObserve(
  input: ExecuteMagicBrowseObserveInput
): Promise<ExecuteMagicBrowseObserveResult> {
  const ctx = new BrowserContext(
    input.browser,
    {
      displayHighlights: input.displayHighlights,
      minimumWaitPageLoadTime: DEFAULT_GENERAL_SETTINGS.minWaitPageLoadTime,
      ...(typeof input.viewportExpansion === 'number'
        ? { viewportExpansion: input.viewportExpansion }
        : {}),
    },
    input.page
  );

  try {
    await ctx.getCurrentPage();
    const state = await ctx.getState(false);
    const textProjector = input.redactionProfiles
      ? (value: string) => redactPlannerViewForOutput(value, input.redactionProfiles)
      : undefined;
    const rawPlannerView = buildBrowserPageSnapshot({
      state,
      includeAttributes: DEFAULT_AGENT_OPTIONS.includeAttributes,
      ...(textProjector ? { textProjector } : {}),
    }).text;
    const plannerView = redactPlannerViewForOutput(rawPlannerView, input.redactionProfiles);
    const finalPage = await ctx.getCurrentPuppeteerPage();
    const activePageIdentity = await readPageIdentity(finalPage);
    const result: MagicBrowseObserveResult = input.includeOrchestration
      ? buildObservedResultWithOrchestration(plannerView, state, input.redactionProfiles)
      : { plannerView };
    const observationLeases = buildPrivateObservationLeases(state);

    return {
      result,
      activePageIdentity,
      observationLeases,
    };
  } finally {
    await ctx.cleanup();
  }
}

function buildPrivateObservationLeases(
  state: BrowserStateTargetSource
): readonly TargetObservationLease[] {
  const observationRef = randomUUID();
  const leases: TargetObservationLease[] = [];
  const fillable = buildMemoryFieldTargetDescriptors(state);
  for (const descriptor of fillable) {
    const element = state.selectorMap.get(descriptor.selectorMapIndex);
    if (!element) continue;
    const actions =
      descriptor.kind === 'select' ? (['select'] as const) : (['fill', 'type'] as const);
    for (const action of actions) {
      const lease = createTargetObservationLease({
        state,
        element,
        descriptor,
        action,
        observationRef,
      });
      if (lease) leases.push(lease);
    }
  }
  for (const descriptor of buildActionTargetDescriptors(state)) {
    const element = state.selectorMap.get(descriptor.selectorMapIndex);
    if (!element) continue;
    const lease = createTargetObservationLease({
      state,
      element,
      descriptor,
      action: 'click',
      observationRef,
    });
    if (lease) leases.push(lease);
  }
  return leases.slice(0, 1024);
}

function redactPlannerViewForOutput(
  plannerView: string,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): string {
  if (!redactionProfiles) {
    return plannerView;
  }

  return redactSensitiveText(plannerView, { redactionProfiles });
}

function buildFillableTargetsSummary(count: number): string {
  const noun = count === 1 ? 'fillable field target' : 'fillable field targets';
  return `Detected ${count} ${noun} for external orchestration.`;
}

function buildActionTargetsSummary(count: number): string {
  const noun = count === 1 ? 'action target' : 'action targets';
  return `Detected ${count} ${noun} for external orchestration.`;
}

function buildObservedResultWithOrchestration(
  plannerView: string,
  state: BrowserStateTargetSource,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): MagicBrowseObserveResult {
  const descriptors = buildMemoryFieldTargetDescriptors(state);
  const actionTargets = buildActionTargetDescriptors(state);
  const submitTargets = buildSubmitTargetDescriptors(state);
  const safeDescriptors = redactionProfiles
    ? redactOrchestrationDescriptorValue(descriptors, redactionProfiles)
    : descriptors;
  const safeActionTargets = redactionProfiles
    ? redactOrchestrationDescriptorValue(actionTargets, redactionProfiles)
    : actionTargets;
  const safeSubmitTargets = redactionProfiles
    ? redactOrchestrationDescriptorValue(submitTargets, redactionProfiles)
    : submitTargets;

  return {
    plannerView,
    orchestration: {
      fillableTargets: {
        count: descriptors.length,
        summary: buildFillableTargetsSummary(descriptors.length),
        descriptors: safeDescriptors,
      },
      actionTargets: {
        count: actionTargets.length,
        summary: buildActionTargetsSummary(actionTargets.length),
        descriptors: safeActionTargets,
      },
      submitTargets: safeSubmitTargets,
    },
  };
}

function redactOrchestrationDescriptorValue<T>(
  value: T,
  redactionProfiles: ExactValueRedactionProfiles
): T {
  return redactOrchestrationDescriptorEntry(value, redactionProfiles, new WeakSet()) as T;
}

function redactOrchestrationDescriptorEntry(
  value: unknown,
  redactionProfiles: ExactValueRedactionProfiles,
  seen: WeakSet<object>
): unknown {
  if (
    value === null ||
    typeof value === 'undefined' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value, { redactionProfiles });
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) =>
      redactOrchestrationDescriptorEntry(entry, redactionProfiles, seen)
    );
    seen.delete(value);
    return output;
  }

  const output = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactOrchestrationDescriptorEntry(entry, redactionProfiles, seen),
    ])
  );
  seen.delete(value);
  return output;
}
