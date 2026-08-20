import type { Frame } from 'puppeteer-core';

export const FORM_MUTATION_JOURNAL_SOURCE_VERSION = '1';
export const FORM_MUTATION_JOURNAL_LIMIT = 256;
export const FORM_MUTATION_REFERENCE_LIMIT = 32;

export type FormMutationKind =
  | 'control_structure'
  | 'owner_structure'
  | 'identity_attribute'
  | 'meaning_attribute'
  | 'actionability_attribute'
  | 'option_structure'
  | 'contributing_label_text';

export interface FrameMutationCheckpoint {
  readonly documentRef: string;
  readonly epoch: number;
  readonly oldestRetainedEpoch: number;
  readonly overflowed: boolean;
}

export interface FormMutationSummary {
  readonly epoch: number;
  readonly kind: FormMutationKind;
  readonly affectedNodeIds: readonly string[];
  readonly affectedOwnerNodeIds: readonly string[];
  readonly attributeName?: string;
}

export interface FrameMutationWindow {
  readonly checkpoint: FrameMutationCheckpoint;
  readonly summaries: readonly FormMutationSummary[];
  readonly coverageAvailable: boolean;
}

interface PageJournalState {
  readonly sourceVersion: string;
  readonly documentRef: string;
  epoch: number;
  oldestRetainedEpoch: number;
  overflowed: boolean;
  referenceOverflowEpochs: number[];
  entries: FormMutationSummary[];
  observers: MutationObserver[];
  observedRoots: WeakSet<Node>;
  disconnect(): void;
}

interface FormMutationJournalWindow extends Window {
  __magicBrowseFormMutationJournal?: PageJournalState;
  __aftercardMagicBrowseDomNodeCounter?: number;
}

export function classifyFormMutationAttribute(attributeName: string): FormMutationKind | undefined {
  const name = attributeName.toLowerCase();
  if (IDENTITY_ATTRIBUTES.has(name)) return 'identity_attribute';
  if (MEANING_ATTRIBUTES.has(name)) return 'meaning_attribute';
  if (ACTIONABILITY_ATTRIBUTES.has(name)) return 'actionability_attribute';
  if (OPTION_ATTRIBUTES.has(name)) return 'option_structure';
  return undefined;
}

const IDENTITY_ATTRIBUTES = new Set(['id', 'name', 'form', 'type', 'role', 'autocomplete', 'for']);
const MEANING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'placeholder',
  'title',
]);
const ACTIONABILITY_ATTRIBUTES = new Set([
  'disabled',
  'readonly',
  'aria-disabled',
  'aria-readonly',
  'hidden',
  'inert',
  'aria-expanded',
]);
const OPTION_ATTRIBUTES = new Set(['selected', 'aria-selected', 'aria-checked']);
const OBSERVED_ATTRIBUTES = [
  ...IDENTITY_ATTRIBUTES,
  ...MEANING_ATTRIBUTES,
  ...ACTIONABILITY_ATTRIBUTES,
  ...OPTION_ATTRIBUTES,
];

export async function installFormMutationJournal(
  frame: Frame,
  sourceVersion = FORM_MUTATION_JOURNAL_SOURCE_VERSION
): Promise<FrameMutationCheckpoint> {
  return frame.evaluate(
    ({ version, limit, referenceLimit, observedAttributes }) => {
      const runtime = window as FormMutationJournalWindow;
      const current = runtime.__magicBrowseFormMutationJournal;
      if (current?.sourceVersion === version) {
        return checkpoint(current);
      }
      current?.disconnect();

      const state: PageJournalState = {
        sourceVersion: version,
        documentRef: randomRef(),
        epoch: 0,
        oldestRetainedEpoch: 1,
        overflowed: false,
        referenceOverflowEpochs: [],
        entries: [],
        observers: [],
        observedRoots: new WeakSet<Node>(),
        disconnect() {
          for (const observer of this.observers) observer.disconnect();
          this.observers.length = 0;
        },
      };

      const nodeId = (node: Node | null): string | undefined => {
        if (!(node instanceof Element)) return undefined;
        const property = '__aftercardMagicBrowseDomNodeId';
        const existing = (node as unknown as Record<string, unknown>)[property];
        return typeof existing === 'string' && existing.length > 0 ? existing : undefined;
      };

      const elementAndDescendants = (node: Node): Element[] => {
        if (!(node instanceof Element)) return [];
        return [node, ...Array.from(node.querySelectorAll('*'))];
      };
      const isControl = (element: Element) =>
        element.matches(
          'input, textarea, select, button, [contenteditable], [role="combobox"], [role="textbox"], [role="option"]'
        );
      const isOwner = (element: Element) =>
        element.matches('form, fieldset, dialog, [role="dialog"], [role="listbox"]');
      const isOption = (element: Element) =>
        element.matches('option, optgroup, [role="option"], [role="listbox"]');
      const ownersFor = (element: Element): Element[] => {
        const owners: Element[] = [];
        const form = element.closest('form');
        const modal = element.closest('dialog, [role="dialog"]');
        const optionOwner = element.closest('select, [role="listbox"]');
        for (const owner of [form, modal, optionOwner]) {
          if (owner && !owners.includes(owner)) owners.push(owner);
        }
        return owners;
      };
      const linkedLabel = (node: Node): HTMLLabelElement | undefined => {
        const label =
          node instanceof HTMLLabelElement
            ? node
            : (node.parentElement?.closest('label') ?? undefined);
        if (!label) return undefined;
        if (label.htmlFor && document.getElementById(label.htmlFor)) return label;
        return label.querySelector('input, textarea, select, button') ? label : undefined;
      };
      const record = (
        kind: FormMutationKind,
        nodes: readonly Element[],
        owners: readonly Element[],
        attributeName?: string
      ) => {
        const affectedNodeIds = unique(nodes.map(nodeId).filter(isString));
        const affectedOwnerNodeIds = unique(owners.map(nodeId).filter(isString));
        state.epoch += 1;
        const missingIdentity =
          affectedNodeIds.length < nodes.length || affectedOwnerNodeIds.length < owners.length;
        if (
          missingIdentity ||
          affectedNodeIds.length > referenceLimit ||
          affectedOwnerNodeIds.length > referenceLimit
        ) {
          state.overflowed = true;
          state.referenceOverflowEpochs.push(state.epoch);
        }
        const summary: FormMutationSummary = {
          epoch: state.epoch,
          kind,
          affectedNodeIds: affectedNodeIds.slice(0, referenceLimit),
          affectedOwnerNodeIds: affectedOwnerNodeIds.slice(0, referenceLimit),
          ...(attributeName ? { attributeName } : {}),
        };
        state.entries.push(summary);
        if (state.entries.length > limit) {
          state.entries.shift();
          state.overflowed = true;
        }
        state.oldestRetainedEpoch = state.entries[0]?.epoch ?? state.epoch + 1;
      };
      const observeRoot = (root: Node) => {
        if (state.observedRoots.has(root)) return;
        state.observedRoots.add(root);
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
              const name = mutation.attributeName?.toLowerCase();
              if (!name || !observedAttributes.includes(name)) continue;
              const kind = classifyAttributeInPage(name);
              if (!kind || !(mutation.target instanceof Element)) continue;
              record(kind, [mutation.target], ownersFor(mutation.target), name);
              continue;
            }
            if (mutation.type === 'characterData') {
              const label = linkedLabel(mutation.target);
              if (label) record('contributing_label_text', [label], ownersFor(label));
              continue;
            }
            const label = linkedLabel(mutation.target);
            const textOnlyChange = [...mutation.addedNodes, ...mutation.removedNodes].every(
              (node) => node.nodeType === Node.TEXT_NODE
            );
            if (label && textOnlyChange) {
              record('contributing_label_text', [label], ownersFor(label));
              continue;
            }
            const changed = [...mutation.addedNodes, ...mutation.removedNodes].flatMap(
              elementAndDescendants
            );
            if (changed.length === 0) continue;
            const target = mutation.target instanceof Element ? mutation.target : undefined;
            const all = target ? [target, ...changed] : changed;
            const containsRelevantStructure = all.some(
              (element) =>
                isOption(element) ||
                isControl(element) ||
                isOwner(element) ||
                Boolean(linkedLabel(element))
            );
            if (!containsRelevantStructure) continue;
            const kind: FormMutationKind = all.some(isOption)
              ? 'option_structure'
              : all.some(isControl)
                ? 'control_structure'
                : all.some(isOwner)
                  ? 'owner_structure'
                  : 'owner_structure';
            const owners = uniqueElements(all.flatMap(ownersFor));
            record(kind, changed, owners);
            for (const element of changed) {
              if (element.shadowRoot) observeRoot(element.shadowRoot);
              for (const shadowHost of Array.from(element.querySelectorAll('*'))) {
                if (shadowHost.shadowRoot) observeRoot(shadowHost.shadowRoot);
              }
            }
          }
        });
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: observedAttributes,
        });
        state.observers.push(observer);
      };

      for (const element of Array.from(document.querySelectorAll('*'))) {
        if (element.shadowRoot) observeRoot(element.shadowRoot);
      }
      observeRoot(document);
      runtime.__magicBrowseFormMutationJournal = state;
      return checkpoint(state);

      function classifyAttributeInPage(name: string): FormMutationKind | undefined {
        if (['id', 'name', 'form', 'type', 'role', 'autocomplete', 'for'].includes(name))
          return 'identity_attribute';
        if (
          ['aria-label', 'aria-labelledby', 'aria-describedby', 'placeholder', 'title'].includes(
            name
          )
        )
          return 'meaning_attribute';
        if (
          [
            'disabled',
            'readonly',
            'aria-disabled',
            'aria-readonly',
            'hidden',
            'inert',
            'aria-expanded',
          ].includes(name)
        )
          return 'actionability_attribute';
        if (['selected', 'aria-selected', 'aria-checked'].includes(name)) return 'option_structure';
        return undefined;
      }
      function checkpoint(value: PageJournalState): FrameMutationCheckpoint {
        return {
          documentRef: value.documentRef,
          epoch: value.epoch,
          oldestRetainedEpoch: value.oldestRetainedEpoch,
          overflowed: value.overflowed,
        };
      }
      function randomRef(): string {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      }
      function unique(values: readonly string[]): string[] {
        return Array.from(new Set(values));
      }
      function uniqueElements(values: readonly Element[]): Element[] {
        return Array.from(new Set(values));
      }
      function isString(value: string | undefined): value is string {
        return typeof value === 'string';
      }
    },
    {
      version: sourceVersion,
      limit: FORM_MUTATION_JOURNAL_LIMIT,
      referenceLimit: FORM_MUTATION_REFERENCE_LIMIT,
      observedAttributes: OBSERVED_ATTRIBUTES,
    }
  );
}

export async function readFormMutationWindow(
  frame: Frame,
  sinceEpoch: number
): Promise<FrameMutationWindow> {
  return frame.evaluate((since) => {
    const state = (window as FormMutationJournalWindow).__magicBrowseFormMutationJournal;
    if (!state) throw new Error('form_mutation_journal_missing');
    const coverageAvailable =
      since >= state.oldestRetainedEpoch - 1 &&
      !state.referenceOverflowEpochs.some((epoch) => epoch > since);
    return {
      checkpoint: {
        documentRef: state.documentRef,
        epoch: state.epoch,
        oldestRetainedEpoch: state.oldestRetainedEpoch,
        overflowed: state.overflowed,
      },
      summaries: state.entries.filter((entry) => entry.epoch > since),
      coverageAvailable,
    };
  }, sinceEpoch);
}

export async function disposeFormMutationJournal(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const runtime = window as FormMutationJournalWindow;
    runtime.__magicBrowseFormMutationJournal?.disconnect();
    delete runtime.__magicBrowseFormMutationJournal;
  });
}
