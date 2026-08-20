import type { MagicBrowseObserveResult } from '../types.js';
import type { MagicBrowseFlowDefinition } from './flow-schema.js';
import { parseFlowDefinition } from './flow-schema.js';

// Flow derivation: turn a persisted agent step history (see
// MAGICBROWSE_EXPERIMENTAL_STEP_HISTORY in adapter/storage-stubs.ts) into a
// DRAFT flow document. Drafts are always status "disabled" with a TODO verify
// contract; promotion is a human/gate decision. Steps whose descriptors
// cannot be backfilled become scoped agent blocks carrying the recorded
// intent, so a draft is replayable immediately and marks its own gaps.

export interface PersistedStepHistory {
  readonly taskId?: string;
  readonly task?: string;
  readonly storedAt?: string;
  readonly history: { readonly history: readonly StepHistoryItem[] };
}

interface StepHistoryItem {
  readonly modelOutput?: string | { action?: readonly Record<string, ActionPayload>[] };
  readonly state?: { readonly url?: string };
}

interface ActionPayload {
  readonly intent?: string;
  readonly index?: number;
  readonly text?: string;
  readonly url?: string;
}

export interface DerivedStepSkeleton {
  readonly action: 'fill' | 'click' | 'select';
  readonly recordedIndex: number | undefined;
  readonly intent: string | undefined;
  readonly value?: string;
}

export interface DerivedFlowSkeleton {
  readonly entryUrl: string;
  readonly finalUrl: string;
  readonly steps: DerivedStepSkeleton[];
  readonly variables: Record<string, string>;
  readonly taskId: string;
  readonly task: string;
  readonly recordedAt: string;
}

function slugifyIntent(intent: string | undefined, fallbackIndex: number): string {
  const slug = (intent ?? '')
    .toLowerCase()
    .replace(/fill |click |the |field/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return slug || `value_${fallbackIndex}`;
}

export function deriveFlowSkeleton(record: PersistedStepHistory): DerivedFlowSkeleton {
  const items = record.history?.history ?? [];
  if (items.length === 0) {
    throw new Error('step history is empty');
  }
  const steps: DerivedStepSkeleton[] = [];
  const variables: Record<string, string> = {};
  let varCounter = 0;
  let entryUrl = items[0]?.state?.url;
  let finalUrl = entryUrl;

  for (const item of items) {
    finalUrl = item.state?.url ?? finalUrl;
    let modelOutput = item.modelOutput;
    if (typeof modelOutput === 'string') {
      try {
        modelOutput = JSON.parse(modelOutput) as Exclude<typeof modelOutput, string>;
      } catch {
        continue;
      }
    }
    for (const action of modelOutput?.action ?? []) {
      const [name] = Object.keys(action);
      const payload = (name ? action[name] : undefined) ?? {};
      if (name === 'go_to_url' && payload.url) {
        entryUrl = payload.url;
        steps.length = 0; // deeper navigation becomes the recording's entry
      } else if (name === 'input_text') {
        varCounter += 1;
        let varName = slugifyIntent(payload.intent, varCounter);
        while (varName in variables && variables[varName] !== (payload.text ?? '')) {
          varCounter += 1;
          varName = `${varName}_${varCounter}`;
        }
        variables[varName] = payload.text ?? '';
        steps.push({
          action: 'fill',
          recordedIndex: payload.index,
          intent: payload.intent,
          value: `{{${varName}}}`,
        });
      } else if (name === 'click_element') {
        steps.push({ action: 'click', recordedIndex: payload.index, intent: payload.intent });
      } else if (name === 'select_dropdown_option') {
        steps.push({
          action: 'select',
          recordedIndex: payload.index,
          intent: payload.intent,
          value: payload.text ?? '',
        });
      }
    }
  }
  if (!entryUrl || steps.length === 0) {
    throw new Error('no replayable steps could be derived from the history');
  }
  // The agent sometimes retries an identical action (double-submit); a
  // recording should keep one occurrence.
  const deduped = steps.filter((step, index) => {
    const prev = steps[index - 1];
    return !(
      prev &&
      prev.action === step.action &&
      prev.recordedIndex === step.recordedIndex &&
      prev.value === step.value
    );
  });
  return {
    entryUrl,
    finalUrl: finalUrl ?? entryUrl,
    steps: deduped,
    variables,
    taskId: record.taskId ?? 'task',
    task: record.task ?? '',
    recordedAt: (record.storedAt ?? '').slice(0, 10),
  };
}

/**
 * Map recorded element indexes to semantic descriptors using a structured
 * observation of the entry page taken while it still matches the recording.
 */
export function buildDraftFlow(
  skeleton: DerivedFlowSkeleton,
  observation?: MagicBrowseObserveResult
): { flow: MagicBrowseFlowDefinition; backfilled: number; agentBlocks: number } {
  const fillables = observation?.orchestration?.fillableTargets?.descriptors ?? [];
  const clickables = [
    ...(observation?.orchestration?.actionTargets?.descriptors ?? []),
    ...((observation?.orchestration?.submitTargets ?? []) as unknown as typeof fillables),
  ];
  let backfilled = 0;
  const steps = skeleton.steps.map((step) => {
    const pool = step.action === 'click' ? clickables : fillables;
    const candidate = pool.find((descriptor) => descriptor.index === step.recordedIndex);
    const attrs: Record<string, string> = {};
    if (candidate) {
      if ('inputName' in candidate && candidate.inputName) attrs.name = candidate.inputName;
      if ('inputType' in candidate && candidate.inputType) attrs.type = candidate.inputType;
      if ('href' in candidate && candidate.href) attrs.href = candidate.href;
      // A bare type (e.g. button[type=submit]) is too weak to be unique;
      // anchor weak descriptors with the accessible label when one exists.
      const weak = !attrs.name && !attrs.href;
      if (weak && candidate.label) attrs.label = candidate.label;
    }
    if (candidate && Object.keys(attrs).length > 0) {
      backfilled += 1;
      return {
        action: step.action,
        target: { tag: candidate.tagName.toLowerCase(), attrs },
        ...(step.value !== undefined ? { value: step.value } : {}),
      };
    }
    return {
      action: 'agent' as const,
      goal: `${step.intent ?? `${step.action} the recorded element`}${step.value !== undefined ? ` with value ${step.value}` : ''}. Then stop.`,
      maxSteps: 4,
    };
  });

  const flow = parseFlowDefinition({
    schemaVersion: 1,
    id: `draft-${skeleton.taskId.replace(/[^\w-]/g, '')}`,
    version: 1,
    status: 'disabled',
    host: new URL(skeleton.entryUrl).hostname,
    taskClass: 'draft',
    description: skeleton.task,
    entry: { url: skeleton.entryUrl },
    variables: skeleton.variables,
    steps,
    verify: {
      urlIncludes: new URL(skeleton.finalUrl).hostname,
      $comment: 'TODO: replace with the real terminal contract before enabling',
    },
    recordedAt: skeleton.recordedAt || undefined,
    recordedFrom: [skeleton.taskId],
  });
  return { flow, backfilled, agentBlocks: steps.length - backfilled };
}
