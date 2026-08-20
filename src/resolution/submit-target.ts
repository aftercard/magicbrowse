import type {
  MagicBrowseDeterministicActionBlockedReason,
  MagicBrowseBrowserDialogSnapshot,
  MagicBrowseSubmitFormTargetBlockedReason,
  MagicBrowseSubmitFormTargetOptions,
  MagicBrowseSubmitFormTargetResult,
} from '../types.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type { NativeBrowserDialogGuard } from '../runtime/native-dialogs.js';
import type BrowserPage from '../vendor/browser/page.js';
import { executeMagicBrowseClickAction } from './deterministic-actions.js';

export interface SubmitFormTargetExecutionInput extends MagicBrowseSubmitFormTargetOptions {
  readonly page: Pick<BrowserPage, 'getState' | 'clickElementNode'>;
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly pageRef?: string;
  readonly readPageIdentity?: () => Promise<{ url?: string; title?: string }>;
  readonly nativeDialog?: Pick<
    NativeBrowserDialogGuard,
    'lastDialog' | 'blockingDialog' | 'settle'
  >;
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
    runRecorder: input.runRecorder,
    nativeDialog: input.nativeDialog,
  });
  if (actionResult.status === 'blocked') {
    return block(input, mapClickActionBlockedReason(actionResult.reason), actionResult.dialog);
  }

  const identity = await input.readPageIdentity?.();
  const result: MagicBrowseSubmitFormTargetResult = {
    status: 'submitted',
    targetRef: input.target.ref,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    ...(identity?.url ? { url: identity.url } : {}),
    ...(identity?.title ? { title: identity.title } : {}),
    ...(actionResult.dialog ? { dialog: actionResult.dialog } : {}),
    summary: buildSummary('submitted', input.target.ref),
  };

  await appendSubmitEvent(input, 'submit_target.complete', {
    status: result.status,
    targetRef: result.targetRef,
    pageRef: result.pageRef,
    url: result.url,
    title: result.title,
    dialog: result.dialog,
  });
  return result;
}

function mapClickActionBlockedReason(
  reason: MagicBrowseDeterministicActionBlockedReason | undefined
): MagicBrowseSubmitFormTargetBlockedReason {
  switch (reason) {
    case 'click_failed':
      return 'click_failed';
    case 'browser_dialog_open':
      return 'browser_dialog_open';
    case 'target_disabled':
      return 'target_disabled';
    case 'unsupported_target':
      return 'not_submit_target';
    case 'target_not_found':
    case 'stale_target':
    case undefined:
      return 'stale_target';
  }
  return 'stale_target';
}

function block(
  input: SubmitFormTargetExecutionInput,
  reason: MagicBrowseSubmitFormTargetBlockedReason,
  dialog?: MagicBrowseBrowserDialogSnapshot
): MagicBrowseSubmitFormTargetResult {
  const result: MagicBrowseSubmitFormTargetResult = {
    status: 'blocked',
    reason,
    targetRef: input.target.ref,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    ...(dialog ? { dialog } : {}),
    summary: buildSummary('blocked', input.target.ref, reason),
  };
  void appendSubmitEvent(input, 'submit_target.blocked', {
    status: result.status,
    reason,
    targetRef: input.target.ref,
    pageRef: input.pageRef,
    dialog,
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
