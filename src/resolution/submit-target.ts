import type {
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseSubmitFormTargetBlockedReason,
  MagicBrowseSubmitFormTargetOptions,
  MagicBrowseSubmitFormTargetResult,
} from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type BrowserPage from '../vendor/browser/page.js';
import { executeMagicBrowseClickAction } from './deterministic-actions.js';

export interface SubmitFormTargetExecutionInput extends MagicBrowseSubmitFormTargetOptions {
  readonly page: Pick<BrowserPage, 'getState' | 'clickElementNode'>;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly pageRef?: string;
  readonly readPageIdentity?: () => Promise<{ url?: string; title?: string }>;
}

export async function submitFormTarget(
  input: SubmitFormTargetExecutionInput
): Promise<MagicBrowseSubmitFormTargetResult> {
  await appendSubmitEvent(input, 'submit_target.start', {
    status: 'started',
    targetRef: input.target.ref,
  });

  if (input.target.isDisabled) {
    return block(input, 'target_disabled');
  }

  const actionResult = await executeMagicBrowseClickAction({
    sessionId: input.sessionId,
    target: input.target,
    page: input.page,
  });
  if (actionResult.status === 'blocked') {
    return block(input, mapClickActionBlockedReason(actionResult.reason));
  }

  const identity = await input.readPageIdentity?.();
  const result: MagicBrowseSubmitFormTargetResult = {
    status: 'submitted',
    targetRef: input.target.ref,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    ...(identity?.url ? { url: identity.url } : {}),
    ...(identity?.title ? { title: identity.title } : {}),
    summary: buildSummary('submitted', input.target.ref),
  };

  await appendSubmitEvent(input, 'submit_target.complete', {
    status: result.status,
    targetRef: result.targetRef,
    pageRef: result.pageRef,
    url: result.url,
    title: result.title,
  });
  return result;
}

function mapClickActionBlockedReason(
  reason: MagicBrowseDeterministicActionBlockedReason | undefined
): MagicBrowseSubmitFormTargetBlockedReason {
  switch (reason) {
    case 'click_failed':
      return 'click_failed';
    case 'target_disabled':
      return 'target_disabled';
    case 'unsupported_target':
      return 'not_submit_target';
    case 'target_not_found':
    case 'stale_target':
    case undefined:
    default:
      return 'stale_target';
  }
}

function block(
  input: SubmitFormTargetExecutionInput,
  reason: MagicBrowseSubmitFormTargetBlockedReason
): MagicBrowseSubmitFormTargetResult {
  const result: MagicBrowseSubmitFormTargetResult = {
    status: 'blocked',
    reason,
    targetRef: input.target.ref,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    summary: buildSummary('blocked', input.target.ref, reason),
  };
  void appendSubmitEvent(input, 'submit_target.blocked', {
    status: result.status,
    reason,
    targetRef: input.target.ref,
    pageRef: input.pageRef,
  });
  return result;
}

function buildSummary(
  status: MagicBrowseSubmitFormTargetResult['status'],
  targetRef: string,
  reason?: MagicBrowseSubmitFormTargetBlockedReason
): string {
  return reason
    ? `submit_target ${status} target=${targetRef} reason=${reason}`
    : `submit_target ${status} target=${targetRef}`;
}

async function appendSubmitEvent(
  input: SubmitFormTargetExecutionInput,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  await input.runRecorder?.append({
    type,
    data,
  });
}
