import type { Dialog, Page } from 'puppeteer-core';

import { redactSensitiveText, type ExactValueRedactionProfiles } from '../redaction.js';
import type { MagicBrowseRunRecorder } from '../transport/run-store.js';
import type {
  MagicBrowseBrowserDialogHandled,
  MagicBrowseBrowserDialogSnapshot,
  MagicBrowseBrowserDialogType,
} from '../types.js';

export interface NativeBrowserDialogGuard {
  readonly lastDialog: () => MagicBrowseBrowserDialogSnapshot | undefined;
  readonly blockingDialog: () => MagicBrowseBrowserDialogSnapshot | undefined;
  readonly settle: () => Promise<void>;
  readonly detach: () => void;
}

export interface AttachNativeBrowserDialogGuardOptions {
  readonly runRecorder?: MagicBrowseRunRecorder;
  readonly actId?: string;
  readonly redactionProfiles?: ExactValueRedactionProfiles;
  readonly omitMessage?: boolean;
}

export function attachNativeBrowserDialogGuard(
  page: Page,
  options: AttachNativeBrowserDialogGuardOptions = {}
): NativeBrowserDialogGuard {
  let lastDialog: MagicBrowseBrowserDialogSnapshot | undefined;
  let blockingDialog: MagicBrowseBrowserDialogSnapshot | undefined;
  const pending = new Set<Promise<void>>();

  const onDialog = (dialog: Dialog) => {
    const task = handleDialog(dialog, options)
      .then((snapshot) => {
        lastDialog = snapshot;
        if (isBlockingNativeBrowserDialog(snapshot)) {
          blockingDialog = snapshot;
        }
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  };

  page.on('dialog', onDialog);

  return {
    lastDialog: () => lastDialog,
    blockingDialog: () => blockingDialog,
    async settle() {
      await Promise.all([...pending]);
    },
    detach() {
      page.off('dialog', onDialog);
    },
  };
}

export function isBlockingNativeBrowserDialog(
  dialog: MagicBrowseBrowserDialogSnapshot | undefined
): boolean {
  if (!dialog) {
    return false;
  }
  return !(dialog.type === 'alert' && dialog.handled === 'accepted');
}

async function handleDialog(
  dialog: Dialog,
  options: AttachNativeBrowserDialogGuardOptions
): Promise<MagicBrowseBrowserDialogSnapshot> {
  const type = normalizeDialogType(dialog.type());
  const message = options.omitMessage
    ? undefined
    : redactDialogMessage(dialog.message(), options.redactionProfiles);
  const handled = await handleDialogByType(dialog, type);
  const snapshot: MagicBrowseBrowserDialogSnapshot = {
    type,
    ...(message ? { message } : {}),
    handled,
  };

  await options.runRecorder
    ?.append({
      type: 'browser.dialog',
      level: isBlockingNativeBrowserDialog(snapshot) ? 'warn' : 'info',
      actId: options.actId,
      data: snapshot,
    })
    .catch(() => undefined);

  return snapshot;
}

async function handleDialogByType(
  dialog: Dialog,
  type: MagicBrowseBrowserDialogType
): Promise<MagicBrowseBrowserDialogHandled> {
  try {
    if (type === 'alert') {
      await dialog.accept();
      return 'accepted';
    }
    await dialog.dismiss();
    return 'dismissed';
  } catch {
    return 'failed';
  }
}

function normalizeDialogType(type: string): MagicBrowseBrowserDialogType {
  switch (type) {
    case 'alert':
    case 'confirm':
    case 'prompt':
    case 'beforeunload':
      return type;
    default:
      return 'unknown';
  }
}

function redactDialogMessage(
  message: string,
  redactionProfiles: ExactValueRedactionProfiles | undefined
): string | undefined {
  const redacted = redactSensitiveText(message, { redactionProfiles }).trim();
  return redacted.length > 0 ? redacted : undefined;
}
