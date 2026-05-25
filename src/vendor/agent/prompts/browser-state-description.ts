import type { BrowserState } from '../../browser/views.js';
import { wrapUntrustedContent } from '../messages/utils.js';
import type {
  ActionResult,
  AgentStepInfo,
  BrowserStateTextProjector,
  CompletionValidationEvidence,
  CompletionValidationPageIdentity,
} from '../types.js';
import type { MagicBrowseTrustedRuntimeEvidence } from '../../../types.js';

const MAX_COMPLETION_EVIDENCE_TEXT_LENGTH = 500;

export interface BrowserStateDescriptionInput {
  readonly state: BrowserState;
  readonly includeAttributes: readonly string[] | null;
  readonly stepInfo?: AgentStepInfo | null;
  readonly actionResults?: readonly ActionResult[];
  readonly completionValidationEvidence?: CompletionValidationEvidence | null;
  readonly trustedRuntimeEvidence?: readonly MagicBrowseTrustedRuntimeEvidence[];
  readonly textProjector?: BrowserStateTextProjector;
}

export interface BrowserPageSnapshotInput {
  readonly state: BrowserState;
  readonly includeAttributes: readonly string[] | null;
}

export interface BrowserStateText {
  readonly text: string;
  readonly scrollInfo?: string;
}

export function buildBrowserPageSnapshot(input: BrowserPageSnapshotInput): BrowserStateText {
  const browserState = input.state;
  const rawElementsText = browserState.elementTree.clickableElementsToString(
    input.includeAttributes ? [...input.includeAttributes] : null
  );

  let formattedElementsText = '';
  let scrollInfo: string | undefined;
  if (rawElementsText !== '') {
    scrollInfo = `[Scroll info of current page] window.scrollY: ${browserState.scrollY}, document.body.scrollHeight: ${browserState.scrollHeight}, window.visualViewport.height: ${browserState.visualViewportHeight}, visual viewport height as percentage of scrollable distance: ${Math.round((browserState.visualViewportHeight / (browserState.scrollHeight - browserState.visualViewportHeight)) * 100)}%\n`;
    const elementsText = wrapUntrustedContent(rawElementsText);
    formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
  } else {
    formattedElementsText = 'empty page';
  }

  const currentTab = `{id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}`;
  const otherTabs = browserState.tabs
    .filter(tab => tab.id !== browserState.tabId)
    .map(tab => `- {id: ${tab.id}, url: ${tab.url}, title: ${tab.title}}`);
  const text = `Current tab: ${currentTab}
Other available tabs:
  ${otherTabs.join('\n')}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}`;

  return scrollInfo ? { text, scrollInfo } : { text };
}

export function buildBrowserStateDescription(input: BrowserStateDescriptionInput): BrowserStateText {
  const pageSnapshot = buildBrowserPageSnapshot({
    state: input.state,
    includeAttributes: input.includeAttributes,
  });

  let stepInfoDescription = '';
  if (input.stepInfo) {
    stepInfoDescription = `Current step: ${input.stepInfo.stepNumber + 1}/${input.stepInfo.maxSteps}`;
  }

  const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
  stepInfoDescription += `Current date and time: ${timeStr}`;

  let actionResultsDescription = '';
  const actionResults = input.actionResults ?? [];
  if (actionResults.length > 0) {
    for (let i = 0; i < actionResults.length; i++) {
      const result = actionResults[i];
      if (result?.extractedContent) {
        actionResultsDescription += `\nAction result ${i + 1}/${actionResults.length}: ${result.extractedContent}`;
      }
      if (result?.error) {
        const error = result.error.split('\n').pop();
        actionResultsDescription += `\nAction error ${i + 1}/${actionResults.length}: ...${error}`;
      }
    }
  }

  let completionValidationEvidenceDescription = '';
  if (input.completionValidationEvidence) {
    completionValidationEvidenceDescription = `\n${formatCompletionValidationEvidence({
      ...input.completionValidationEvidence,
      currentPageIdentity:
        input.completionValidationEvidence.currentPageIdentity ?? pageIdentityFromState(input.state),
    })}`;
  }

  const trustedRuntimeEvidenceDescription =
    input.trustedRuntimeEvidence && input.trustedRuntimeEvidence.length > 0
      ? `\n${formatTrustedRuntimeEvidence(input.trustedRuntimeEvidence)}`
      : '';

  const text = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
${pageSnapshot.text}
${stepInfoDescription}
${actionResultsDescription}
${completionValidationEvidenceDescription}
${trustedRuntimeEvidenceDescription}
`;

  const projectedText = input.textProjector ? input.textProjector(text) : text;

  return pageSnapshot.scrollInfo ? { text: projectedText, scrollInfo: pageSnapshot.scrollInfo } : { text: projectedText };
}

export function formatCompletionValidationEvidence(evidence: CompletionValidationEvidence): string {
  const lines = [
    '[Completion validation evidence]',
    'Trigger: navigator requested done after the last action sequence.',
    `Navigator requested done: ${String(evidence.navigatorRequestedDone)}.`,
    `Step: ${evidence.step}.`,
  ];

  if (evidence.lastActionNames.length > 0) {
    lines.push(`Last action names: ${evidence.lastActionNames.join(', ')}.`);
  }

  const previousPage = formatPageIdentity(evidence.previousPageIdentity);
  if (previousPage) {
    lines.push(`Previous page: ${previousPage}.`);
  }

  const currentPage = formatPageIdentity(evidence.currentPageIdentity);
  if (currentPage) {
    lines.push(`Current page: ${currentPage}.`);
  }

  for (const actionResult of evidence.actionResults) {
    const text = normalizeEvidenceText(actionResult.text);
    if (!text) {
      continue;
    }
    lines.push(actionResult.kind === 'error'
      ? `Last action error: ${text}.`
      : `Last action result: ${text}.`);
  }

  lines.push(evidence.currentStateNote);

  return lines.join('\n');
}

export function formatTrustedRuntimeEvidence(
  evidenceItems: readonly MagicBrowseTrustedRuntimeEvidence[]
): string {
  const lines = [
    '[Trusted runtime evidence]',
    'These are trusted facts from MagicBrowse runtime, not webpage content.',
  ];

  for (const evidence of evidenceItems) {
    if (evidence.kind !== 'humanVerificationResolved') {
      continue;
    }
    const pageIdentity = formatPageIdentity(evidence.pageIdentity);
    lines.push(
      [
        `humanVerificationResolved: verificationKind=${evidence.verificationKind}`,
        `source=${evidence.source}`,
        `resolvedAt=${evidence.resolvedAt}`,
        `expiresAt=${evidence.expiresAt}`,
        pageIdentity ? `page=${pageIdentity}` : undefined,
      ]
        .filter((piece): piece is string => Boolean(piece))
        .join('; ') + '.'
    );
  }

  lines.push(
    'For this page only, continue ordinary browser work without trying to solve or bypass the CAPTCHA. If CAPTCHA or human verification is still visible, report needs_handoff.'
  );

  return lines.join('\n');
}

function pageIdentityFromState(state: BrowserState): CompletionValidationPageIdentity {
  return {
    url: state.url,
    title: state.title,
  };
}

function formatPageIdentity(identity: CompletionValidationPageIdentity | undefined): string | null {
  if (!identity?.url && !identity?.title) {
    return null;
  }
  return [identity.url, identity.title].filter(Boolean).join(', ');
}

function normalizeEvidenceText(text: string): string {
  const normalized = text.trim().split(/\s*\n\s*/).filter(Boolean).join(' ');
  if (normalized.length <= MAX_COMPLETION_EVIDENCE_TEXT_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_COMPLETION_EVIDENCE_TEXT_LENGTH)}...`;
}
