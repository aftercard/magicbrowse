import type { Browser, Page as PuppeteerPage } from 'puppeteer-core';

import { DEFAULT_GENERAL_SETTINGS } from '../adapter/storage-stubs.js';
import { BrowserContext } from '../browser/browser-context.js';
import {
  buildActionTargetDescriptors,
  buildResolveFieldTargetDescriptors,
  buildSubmitTargetDescriptors,
  type BrowserStateTargetSource,
} from '../resolution/targets.js';
import { readPageIdentity } from '../transport/page-resolver.js';
import type { MagicBrowseActivePageIdentity, MagicBrowseObserveResult } from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import { redactSensitiveText, type ProtectedRedactionProfiles } from '../redaction.js';
import { buildBrowserPageSnapshot } from '../vendor/agent/prompts/browser-state-description.js';
import { DEFAULT_AGENT_OPTIONS } from '../vendor/agent/types.js';

export interface ExecuteMagicBrowseObserveInput {
  readonly browser: Browser;
  readonly page: PuppeteerPage;
  readonly displayHighlights: boolean;
  readonly includeOrchestration?: boolean;
  readonly viewportExpansion?: number;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly observeId?: string;
  readonly protectedRedactionProfiles?: ProtectedRedactionProfiles;
}

export interface ExecuteMagicBrowseObserveResult {
  readonly result: MagicBrowseObserveResult;
  readonly activePageIdentity: MagicBrowseActivePageIdentity;
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
    const rawPlannerView = buildBrowserPageSnapshot({
      state,
      includeAttributes: DEFAULT_AGENT_OPTIONS.includeAttributes,
    }).text;
    const plannerView = redactPlannerViewForOutput(
      rawPlannerView,
      input.protectedRedactionProfiles
    );
    const finalPage = await ctx.getCurrentPuppeteerPage();
    const activePageIdentity = await readPageIdentity(finalPage);
    const result: MagicBrowseObserveResult = input.includeOrchestration
      ? buildObservedResultWithOrchestration(plannerView, state, input.protectedRedactionProfiles)
      : { plannerView };

    return {
      result,
      activePageIdentity,
    };
  } finally {
    await ctx.cleanup();
  }
}

function redactPlannerViewForOutput(
  plannerView: string,
  protectedRedactionProfiles: ProtectedRedactionProfiles | undefined
): string {
  if (!protectedRedactionProfiles) {
    return plannerView;
  }

  return redactSensitiveText(plannerView, { protectedRedactionProfiles });
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
  protectedRedactionProfiles: ProtectedRedactionProfiles | undefined
): MagicBrowseObserveResult {
  const descriptors = buildResolveFieldTargetDescriptors(state);
  const actionTargets = buildActionTargetDescriptors(state);
  const submitTargets = buildSubmitTargetDescriptors(state);
  const safeDescriptors = protectedRedactionProfiles
    ? redactOrchestrationDescriptorValue(descriptors, protectedRedactionProfiles)
    : descriptors;
  const safeActionTargets = protectedRedactionProfiles
    ? redactOrchestrationDescriptorValue(actionTargets, protectedRedactionProfiles)
    : actionTargets;
  const safeSubmitTargets = protectedRedactionProfiles
    ? redactOrchestrationDescriptorValue(submitTargets, protectedRedactionProfiles)
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
  protectedRedactionProfiles: ProtectedRedactionProfiles
): T {
  return redactOrchestrationDescriptorEntry(value, protectedRedactionProfiles, new WeakSet()) as T;
}

function redactOrchestrationDescriptorEntry(
  value: unknown,
  protectedRedactionProfiles: ProtectedRedactionProfiles,
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
    return redactSensitiveText(value, { protectedRedactionProfiles });
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
      redactOrchestrationDescriptorEntry(entry, protectedRedactionProfiles, seen)
    );
    seen.delete(value);
    return output;
  }

  const output = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactOrchestrationDescriptorEntry(entry, protectedRedactionProfiles, seen),
    ])
  );
  seen.delete(value);
  return output;
}
