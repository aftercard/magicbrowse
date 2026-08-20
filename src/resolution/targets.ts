import type { BrowserState } from '../vendor/browser/views.js';
import { DOMElementNode, DOMTextNode } from '../vendor/browser/dom/views.js';
import type {
  MagicBrowseActionTargetDescriptor,
  MagicBrowseActionTargetKind,
  MagicBrowseSubmitTargetDescriptor,
  MagicBrowseSubmitTargetKind,
} from '../types.js';

export type MemoryFieldTargetKind = 'input' | 'textarea' | 'select' | 'select-like';

export type MemoryFieldControlKind = 'select' | 'radio' | 'checkbox' | 'toggle';

export interface MemoryFieldControlOption {
  readonly value: string;
  readonly text: string;
  readonly disabled?: boolean;
  /** Runtime-only stable DOM identity used to revalidate a choice after re-observation. */
  readonly bindingKey?: string;
  /** Runtime-only target binding for radio and popup-backed choices. */
  readonly targetRef?: string;
  /** Runtime-only semantic label/wrapper fallback for a choice action. */
  readonly fallbackTargetRef?: string;
  /** Runtime-only mutable state. It is never forwarded to the form compiler. */
  readonly checked?: boolean;
}

export interface MemoryFieldTargetDescriptor {
  readonly ref: string;
  readonly index?: number;
  readonly selectorMapIndex?: number;
  readonly pageRef?: string;
  readonly kind?: string;
  readonly tagName?: string;
  readonly role?: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly text?: string;
  readonly placeholder?: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly selectorRoot?: string;
  readonly isReadonly?: boolean;
  readonly popupBacked?: boolean;
  readonly controlKind?: MemoryFieldControlKind;
  readonly options?: readonly MemoryFieldControlOption[];
  /** Runtime-only mutable state. It is never forwarded to the form compiler. */
  readonly checked?: boolean;
  readonly hasValue?: boolean;
  readonly allowedActions?: readonly string[];
  readonly host?: string;
  readonly context?: unknown;
}

export interface MemoryFieldTargetSignals {
  readonly ref: string;
  readonly index: number;
  readonly selectorMapIndex: number;
  readonly kind: MemoryFieldTargetKind;
  readonly tagName: string;
  readonly role?: string;
  readonly label?: string;
  readonly displayLabel?: string;
  readonly text?: string;
  readonly placeholder?: string;
  readonly inputName?: string;
  readonly inputType?: string;
  readonly autocomplete?: string;
  readonly selectorRoot?: string;
  readonly isReadonly: boolean;
  readonly popupBacked: boolean;
  readonly controlKind?: MemoryFieldControlKind;
  readonly options?: readonly MemoryFieldControlOption[];
  readonly checked?: boolean;
  readonly hasValue?: boolean;
  /** Privacy-safe structural mask for expiry controls (digits become `#`). */
  readonly valueShape?: string;
}

export interface MemoryFieldTargetSourceContext {
  readonly kind: 'selectorMap';
  readonly ref: string;
  readonly index: number;
  readonly highlightIndex?: number;
  readonly snapshotScoped: true;
}

export interface MemoryFieldTargetSelectorContext {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
  readonly xpath?: string;
  readonly css?: string;
}

export interface MemoryFieldTargetStateContext {
  readonly readonly: boolean;
  readonly popupBacked: boolean;
  readonly disabled: boolean;
  readonly required: boolean;
  readonly withinActiveModal?: boolean;
  readonly withinEmbeddedFrame?: boolean;
  readonly ariaInvalid?: boolean;
  readonly validationMessage?: string;
  readonly expanded?: string;
  readonly checked?: boolean;
  readonly valuePresent?: boolean;
  readonly valueShape?: string;
}

export interface MemoryFieldTargetFormContext {
  readonly tagName: string;
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
}

export interface MemoryFieldTargetContext {
  readonly source: MemoryFieldTargetSourceContext;
  readonly selector: MemoryFieldTargetSelectorContext;
  readonly state: MemoryFieldTargetStateContext;
  readonly form?: MemoryFieldTargetFormContext;
}

export type BrowserStateMemoryFieldTargetDescriptor = MemoryFieldTargetDescriptor &
  MemoryFieldTargetSignals & {
    readonly pageRef?: string;
    readonly host?: string;
    readonly context: MemoryFieldTargetContext;
  };

export type BrowserStateTargetSource = Pick<
  BrowserState,
  'elementTree' | 'selectorMap' | 'tabId' | 'url'
>;

export interface ExtractMemoryFieldTargetSignalsInput {
  readonly state?: Pick<BrowserStateTargetSource, 'elementTree'>;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}

const TARGET_REF_PREFIX = 'selector:';
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image', 'file']);
const MAX_CONTROL_OPTIONS = 128;
const MAX_CONTROL_OPTION_TEXT_LENGTH = 160;
const MAX_LABEL_TEXT_LENGTH = 160;
const SELECT_LIKE_ROLES = new Set(['combobox', 'listbox']);
const SELECT_LIKE_HASPOPUP_VALUES = new Set(['true', 'listbox']);
const MAX_SELECT_LIKE_OWNER_DEPTH = 3;
const MAX_EQUIVALENT_CONTROL_DESCENDANT_DEPTH = 5;
const SELECT_LIKE_CUSTOM_ELEMENT_PARTS = new Set(['combobox', 'dropdown', 'picker', 'select']);
const POPUP_HASPOPUP_VALUES = new Set(['true', 'listbox', 'menu', 'tree', 'grid', 'dialog']);
const SUBMIT_TEXT_RE =
  /\b(submit|continue|sign in|log in|pay|buy|book|reserve|checkout|next|done)\b|оплат|войти|далее/i;

/**
 * Builds snapshot-scoped field descriptors from the current browser state.
 * Descriptor refs intentionally point back to this state's selectorMap index;
 * future fill code must revalidate them against a fresh state before acting.
 */
export function buildMemoryFieldTargetDescriptors(
  state: BrowserStateTargetSource
): readonly BrowserStateMemoryFieldTargetDescriptor[] {
  const descriptors: BrowserStateMemoryFieldTargetDescriptor[] = [];
  const handledRadioGroups = new Set<string>();

  for (const [selectorMapIndex, element] of state.selectorMap.entries()) {
    const radioGroup = radioGroupForElement(state, element);
    if (radioGroup) {
      if (handledRadioGroups.has(radioGroup.key)) {
        continue;
      }
      handledRadioGroups.add(radioGroup.key);
    }
    const descriptor = createMemoryFieldTargetDescriptor({
      state,
      element,
      selectorMapIndex,
    });
    if (descriptor) {
      descriptors.push(
        radioGroup
          ? {
              ...descriptor,
              ...(radioGroup.label
                ? { label: radioGroup.label, displayLabel: radioGroup.label }
                : {}),
              controlKind: 'radio',
              options: radioGroup.options,
            }
          : descriptor
      );
    }
  }

  return collapseNestedEquivalentSelectTargets(descriptors, state);
}

function collapseNestedEquivalentSelectTargets(
  descriptors: readonly BrowserStateMemoryFieldTargetDescriptor[],
  state: BrowserStateTargetSource
): readonly BrowserStateMemoryFieldTargetDescriptor[] {
  return descriptors.filter((candidate) => {
    if (candidate.kind !== 'select-like' || candidate.controlKind !== 'select') {
      return true;
    }
    const candidateElement = resolveSelectorMapElementForTarget(state, candidate);
    const candidateLabel = equivalentControlLabel(candidate);
    if (!candidateElement || !candidateLabel) {
      return true;
    }

    return !descriptors.some((other) => {
      if (
        other.ref === candidate.ref ||
        other.kind !== 'select-like' ||
        other.controlKind !== 'select' ||
        equivalentControlLabel(other) !== candidateLabel
      ) {
        return false;
      }
      const otherElement = resolveSelectorMapElementForTarget(state, other);
      return Boolean(
        otherElement &&
          isDescendantWithin(
            otherElement,
            candidateElement,
            MAX_EQUIVALENT_CONTROL_DESCENDANT_DEPTH
          )
      );
    });
  });
}

function equivalentControlLabel(descriptor: {
  readonly displayLabel?: string;
  readonly label?: string;
  readonly placeholder?: string;
  readonly inputName?: string;
}): string | undefined {
  return normalizeText(
    firstDefined(
      descriptor.displayLabel,
      descriptor.label,
      descriptor.placeholder,
      descriptor.inputName
    )
  )?.toLowerCase();
}

function isDescendantWithin(
  descendant: DOMElementNode,
  ancestor: DOMElementNode,
  maxDepth: number
): boolean {
  let current = descendant.parent;
  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function buildSubmitTargetDescriptors(
  state: BrowserStateTargetSource
): readonly MagicBrowseSubmitTargetDescriptor[] {
  const descriptors: MagicBrowseSubmitTargetDescriptor[] = [];

  for (const [selectorMapIndex, element] of state.selectorMap.entries()) {
    const descriptor = createSubmitTargetDescriptor({
      state,
      element,
      selectorMapIndex,
    });
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }

  return descriptors;
}

export function buildActionTargetDescriptors(
  state: BrowserStateTargetSource
): readonly MagicBrowseActionTargetDescriptor[] {
  const descriptors: MagicBrowseActionTargetDescriptor[] = [];

  for (const [selectorMapIndex, element] of state.selectorMap.entries()) {
    const descriptor = createActionTargetDescriptor({
      state,
      element,
      selectorMapIndex,
    });
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }

  return collapseNestedEquivalentActionTargets(descriptors, state);
}

function collapseNestedEquivalentActionTargets(
  descriptors: readonly MagicBrowseActionTargetDescriptor[],
  state: BrowserStateTargetSource
): readonly MagicBrowseActionTargetDescriptor[] {
  return descriptors.filter((candidate) => {
    if (candidate.kind !== 'select-like') {
      return true;
    }
    const candidateElement = resolveSelectorMapElementForTarget(state, candidate);
    const candidateLabel = equivalentControlLabel(candidate);
    if (!candidateElement || !candidateLabel) {
      return true;
    }

    return !descriptors.some((other) => {
      if (
        other.ref === candidate.ref ||
        other.kind !== 'select-like' ||
        equivalentControlLabel(other) !== candidateLabel
      ) {
        return false;
      }
      const otherElement = resolveSelectorMapElementForTarget(state, other);
      return Boolean(
        otherElement &&
          isDescendantWithin(
            otherElement,
            candidateElement,
            MAX_EQUIVALENT_CONTROL_DESCENDANT_DEPTH
          )
      );
    });
  });
}

export function createMemoryFieldTargetDescriptor(input: {
  readonly state: BrowserStateTargetSource;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}): BrowserStateMemoryFieldTargetDescriptor | null {
  const signals = extractMemoryFieldTargetSignals(input);
  if (!signals) {
    return null;
  }

  const context = buildMemoryFieldTargetContext(input.element, signals);
  const pageRef = `tab:${input.state.tabId}`;
  const host = hostFromUrl(input.state.url);

  return {
    ref: signals.ref,
    index: signals.index,
    selectorMapIndex: signals.selectorMapIndex,
    pageRef,
    kind: signals.kind,
    tagName: signals.tagName,
    role: signals.role,
    label: signals.label,
    displayLabel: signals.displayLabel,
    text: signals.text,
    placeholder: signals.placeholder,
    inputName: signals.inputName,
    inputType: signals.inputType,
    autocomplete: signals.autocomplete,
    selectorRoot: signals.selectorRoot,
    isReadonly: signals.isReadonly,
    popupBacked: signals.popupBacked,
    controlKind: signals.controlKind,
    options: signals.options,
    checked: signals.checked,
    hasValue: signals.hasValue,
    host,
    context,
  };
}

export function createActionTargetDescriptor(input: {
  readonly state: BrowserStateTargetSource;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}): MagicBrowseActionTargetDescriptor | null {
  const kind = resolveActionTargetKind(input.element);
  if (!kind) {
    return null;
  }

  const tagName = normalizeTagName(input.element);
  const role = readRole(input.element);
  const text = nodeText(input.element);
  const href = kind === 'link' ? readAttribute(input.element, 'href') : undefined;
  const label = firstDefined(
    readAttribute(input.element, 'aria-label'),
    nativeLabelText(input.element),
    explicitLabelText(input.element, input.state),
    wrappingLabelText(input.element),
    text,
    readAttribute(input.element, 'title')
  );
  const inputName = readAttribute(input.element, 'name');
  const inputType =
    tagName === 'input' || tagName === 'button'
      ? (readAttribute(input.element, 'type') ?? (tagName === 'button' ? 'submit' : undefined))
      : undefined;
  const selectorRoot = safeSelectorRoot(input.element);
  const form = nearestFormContext(input.element);
  const bindingKey = isChoiceActionElement(input.element)
    ? controlOptionBindingKey(input.element, nearestFormElement(input.element))
    : undefined;
  const ref = createSelectorMapTargetRef(input.selectorMapIndex);
  const disabled =
    hasBooleanAttribute(input.element, 'disabled') ||
    readAttribute(input.element, 'aria-disabled') === 'true';

  return {
    ref,
    index: input.selectorMapIndex,
    selectorMapIndex: input.selectorMapIndex,
    kind,
    tagName,
    role,
    label,
    displayLabel: firstDefined(label, text, inputName, href, readAttribute(input.element, 'id')),
    text,
    href,
    inputName,
    inputType,
    selectorRoot,
    bindingKey,
    ...(input.element.internalNodeId ? { internalNodeId: input.element.internalNodeId } : {}),
    isDisabled: disabled,
    pageRef: `tab:${input.state.tabId}`,
    host: hostFromUrl(input.state.url),
    context: {
      source: {
        kind: 'selectorMap',
        ref,
        index: input.selectorMapIndex,
        highlightIndex: input.element.highlightIndex ?? undefined,
        snapshotScoped: true,
      },
      selector: omitUndefined({
        id: readAttribute(input.element, 'id'),
        name: inputName,
        role,
        xpath: normalizeText(input.element.xpath),
        css: selectorRoot,
      }),
      state: omitUndefined({
        readonly: isReadonlyControl(input.element),
        popupBacked: isPopupBackedControl(input.element),
        disabled,
        required:
          hasBooleanAttribute(input.element, 'required') ||
          readAttribute(input.element, 'aria-required') === 'true',
        expanded: controlExpandedState(input.element),
      }),
      ...(form ? { form } : {}),
    },
  };
}

export function createSubmitTargetDescriptor(input: {
  readonly state: BrowserStateTargetSource;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}): MagicBrowseSubmitTargetDescriptor | null {
  const kind = resolveSubmitTargetKind(input.element);
  if (!kind) {
    return null;
  }

  const tagName = normalizeTagName(input.element);
  const role = readRole(input.element);
  const text = nodeText(input.element);
  const label = firstDefined(
    readAttribute(input.element, 'aria-label'),
    nativeLabelText(input.element),
    explicitLabelText(input.element, input.state),
    wrappingLabelText(input.element),
    text,
    readAttribute(input.element, 'title')
  );
  const inputName = readAttribute(input.element, 'name');
  const inputType =
    tagName === 'input' || tagName === 'button'
      ? (readAttribute(input.element, 'type') ?? (tagName === 'button' ? 'submit' : undefined))
      : undefined;
  const selectorRoot = safeSelectorRoot(input.element);
  const form = nearestFormContext(input.element);
  const ref = createSelectorMapTargetRef(input.selectorMapIndex);
  const disabled =
    hasBooleanAttribute(input.element, 'disabled') ||
    readAttribute(input.element, 'aria-disabled') === 'true';

  return {
    ref,
    index: input.selectorMapIndex,
    selectorMapIndex: input.selectorMapIndex,
    kind,
    tagName,
    role,
    label,
    displayLabel: firstDefined(label, text, inputName, readAttribute(input.element, 'id')),
    text,
    inputName,
    inputType,
    selectorRoot,
    isDisabled: disabled,
    pageRef: `tab:${input.state.tabId}`,
    host: hostFromUrl(input.state.url),
    context: {
      source: {
        kind: 'selectorMap',
        ref,
        index: input.selectorMapIndex,
        highlightIndex: input.element.highlightIndex ?? undefined,
        snapshotScoped: true,
      },
      selector: omitUndefined({
        id: readAttribute(input.element, 'id'),
        name: inputName,
        role,
        xpath: normalizeText(input.element.xpath),
        css: selectorRoot,
      }),
      state: omitUndefined({
        readonly: false,
        popupBacked: false,
        disabled,
        required: false,
        expanded: readAttribute(input.element, 'aria-expanded'),
      }),
      ...(form ? { form } : {}),
    },
  };
}

export function extractMemoryFieldTargetSignals(
  input: ExtractMemoryFieldTargetSignalsInput
): MemoryFieldTargetSignals | null {
  const kind = memoryFieldTargetKind(input.element);
  if (!kind) {
    return null;
  }

  const tagName = normalizeTagName(input.element);
  const role = readRole(input.element);
  const text = extractTextSignal(input.element, kind);
  const label = extractLabelSignal(input.element, input.state);
  const placeholder = readAttribute(input.element, 'placeholder');
  const inputName = readAttribute(input.element, 'name');
  const controlKind = memoryFieldControlKind(input.element, kind);
  const inputType =
    controlKind === 'checkbox' || controlKind === 'radio' || controlKind === 'toggle'
      ? controlKind
      : kind === 'input'
        ? (readAttribute(input.element, 'type') ?? 'text')
        : undefined;
  const autocomplete = readAttribute(input.element, 'autocomplete');
  const selectorRoot = safeSelectorRoot(input.element);
  const isReadonly = isReadonlyControl(input.element);
  const popupBacked = isPopupBackedControl(input.element);
  const options = extractControlOptions(input, controlKind);
  const checked = readCheckedState(input.element);
  const hasValue = memoryFieldValuePresent(input.element);
  const valueShape = memoryFieldValueShape(input.element, autocomplete);
  const ref = createSelectorMapTargetRef(input.selectorMapIndex);

  return {
    ref,
    index: input.selectorMapIndex,
    selectorMapIndex: input.selectorMapIndex,
    kind,
    tagName,
    role,
    label,
    displayLabel: firstDefined(
      label,
      placeholder,
      inputName,
      autocomplete,
      text,
      readAttribute(input.element, 'id')
    ),
    text,
    placeholder,
    inputName,
    inputType,
    autocomplete,
    selectorRoot,
    isReadonly,
    popupBacked,
    controlKind,
    ...(options.length > 0 ? { options } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(hasValue !== undefined ? { hasValue } : {}),
    ...(valueShape ? { valueShape } : {}),
  };
}

function memoryFieldValuePresent(element: DOMElementNode): boolean | undefined {
  const value = readAttribute(element, 'value');
  if (value !== undefined) {
    return value.length > 0;
  }
  if (normalizeTagName(element) === 'textarea') {
    return Boolean(normalizeText(nodeText(element)));
  }
  return undefined;
}

function memoryFieldValueShape(
  element: DOMElementNode,
  autocomplete: string | undefined
): string | undefined {
  if (!['cc-exp', 'cc-exp-month', 'cc-exp-year'].includes(autocomplete?.toLowerCase() ?? '')) {
    return undefined;
  }
  const value = readAttribute(element, 'value');
  if (!value) {
    return undefined;
  }
  return value.replace(/[0-9]/g, '#');
}

export function isMemoryFieldTargetElement(element: DOMElementNode): boolean {
  return memoryFieldTargetKind(element) !== null;
}

/**
 * Resolve the element a target names, surviving a renumbered selector map.
 *
 * A selector-map index is a dense rank over whatever was captured, so any
 * element entering or leaving the capture shifts every later index: opening a
 * date picker on Google Flights moves the Departure input from 14 to 12, and a
 * caller holding 14 then acts on an unrelated `<div>`. nanobrowser avoids this
 * by identifying an element from its own structure rather than its position
 * (`HistoryTreeProcessor`, which hashes parent tag path + attributes + xpath).
 * This is that identity applied to the deterministic path, compared directly
 * instead of hashed so the lookup can stay synchronous.
 *
 * The xpath is only trusted when the target carries one, and only to *improve*
 * the answer: a moved element is re-found by identity, but an ambiguous or
 * absent match falls back to the element at the index so the callers' existing
 * checks still report why it was rejected (`stale_target`) rather than
 * flattening every mismatch into "not found". Acting on the wrong element is
 * still prevented — downstream descriptor validation rejects it — this only
 * keeps the diagnosis specific.
 */
export function resolveSelectorMapElementForTarget(
  state: Pick<BrowserStateTargetSource, 'selectorMap'>,
  target: Pick<MemoryFieldTargetDescriptor, 'ref' | 'selectorMapIndex'> & {
    readonly context?: { readonly selector?: { readonly xpath?: string } };
  }
): DOMElementNode | undefined {
  const index = target.selectorMapIndex ?? parseSelectorMapTargetRef(target.ref);
  const elementAtIndex = index === null ? undefined : state.selectorMap.get(index);

  const expectedXpath = target.context?.selector?.xpath;
  if (!expectedXpath) {
    return elementAtIndex;
  }

  if (elementAtIndex?.xpath === expectedXpath) {
    return elementAtIndex;
  }

  const matches: DOMElementNode[] = [];
  for (const candidate of state.selectorMap.values()) {
    if (candidate.xpath === expectedXpath) {
      matches.push(candidate);
    }
  }

  return matches.length === 1 ? matches[0] : elementAtIndex;
}

export function resolveFreshSubmitTargetElement(
  state: BrowserStateTargetSource,
  target: MagicBrowseSubmitTargetDescriptor
): DOMElementNode | undefined {
  const element = resolveSelectorMapElementForTarget(state, target);
  if (!element) {
    return undefined;
  }

  const current = createSubmitTargetDescriptor({
    state,
    element,
    selectorMapIndex: target.selectorMapIndex,
  });

  return current && submitDescriptorsMatch(target, current) ? element : undefined;
}

export function createSelectorMapTargetRef(index: number): string {
  return `${TARGET_REF_PREFIX}${index}`;
}

export function parseSelectorMapTargetRef(ref: string): number | null {
  if (!ref.startsWith(TARGET_REF_PREFIX)) {
    return null;
  }

  const value = Number(ref.slice(TARGET_REF_PREFIX.length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function memoryFieldTargetKind(element: DOMElementNode): MemoryFieldTargetKind | null {
  const tagName = normalizeTagName(element);
  const role = readRole(element)?.toLowerCase();
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    return isReadonlyControl(element) ? null : 'input';
  }
  if (tagName === 'textarea') {
    return isReadonlyControl(element) ? null : 'textarea';
  }
  if (tagName === 'select') {
    return 'select';
  }
  if (tagName === 'input' && isSelectLikeControl(element)) {
    return 'select-like';
  }
  if (tagName === 'input') {
    const inputType = readAttribute(element, 'type')?.toLowerCase() ?? 'text';
    return NON_FIELD_INPUT_TYPES.has(inputType) || isReadonlyControl(element) ? null : 'input';
  }
  if (isSelectLikeControl(element)) {
    return 'select-like';
  }

  return null;
}

function memoryFieldControlKind(
  element: DOMElementNode,
  kind: MemoryFieldTargetKind
): MemoryFieldControlKind | undefined {
  const inputType = readAttribute(element, 'type')?.toLowerCase();
  const role = readRole(element)?.toLowerCase();
  if (inputType === 'radio' || role === 'radio') {
    return 'radio';
  }
  if (role === 'switch') {
    return 'toggle';
  }
  if (inputType === 'checkbox' || role === 'checkbox') {
    return 'checkbox';
  }
  if (kind === 'select' || kind === 'select-like') {
    return 'select';
  }
  return undefined;
}

function extractControlOptions(
  input: ExtractMemoryFieldTargetSignalsInput,
  controlKind: MemoryFieldControlKind | undefined
): MemoryFieldControlOption[] {
  if (controlKind !== 'select') {
    return [];
  }

  const optionElements = selectOptionElements(input.element, input.state?.elementTree);
  return uniqueControlOptions(
    optionElements.slice(0, MAX_CONTROL_OPTIONS).flatMap((option) => {
      const text = boundedControlOptionText(
        firstDefined(
          readAttribute(option, 'aria-label'),
          nodeText(option),
          readAttribute(option, 'label')
        )
      );
      const value = boundedControlOptionText(readAttribute(option, 'value') ?? text);
      if (!text || !value) {
        return [];
      }
      const targetRef = selectorMapTargetRefForElement(input, option);
      return [
        {
          value,
          text,
          bindingKey: controlOptionBindingKey(option, nearestFormElement(option)),
          ...(isDisabledOption(option) ? { disabled: true } : {}),
          ...(targetRef ? { targetRef } : {}),
          ...(readCheckedState(option) !== undefined ? { checked: readCheckedState(option) } : {}),
        },
      ];
    })
  );
}

function selectOptionElements(element: DOMElementNode, root?: DOMElementNode): DOMElementNode[] {
  const tagName = normalizeTagName(element);
  if (tagName === 'select') {
    return descendantElements(element, (candidate) => normalizeTagName(candidate) === 'option');
  }

  const controlledIds = uniqueStrings([
    readAttribute(element, 'aria-controls'),
    readAttribute(element, 'aria-owns'),
  ]).flatMap((entry) => entry.split(/\s+/).filter(Boolean));
  const controlledRoots = root
    ? controlledIds.flatMap((id) => {
        const controlled = findElementById(root, id);
        return controlled ? [controlled] : [];
      })
    : [];
  const selectorMapControlledOptions =
    controlledIds.length > 0 && root
      ? selectorMapForElement(root)
          .map(([, candidate]) => candidate)
          .filter(
            (candidate) =>
              isControlledChoiceOptionElement(candidate) &&
              controlledIds.some((id) => hasAncestorWithId(candidate, id))
          )
      : [];
  const owner = nearestSelectLikeOwner(element);
  const roots = controlledRoots.length > 0 ? controlledRoots : owner ? [owner] : [element];
  return uniqueElementNodes([
    ...selectorMapControlledOptions,
    ...roots.flatMap((candidateRoot) =>
      descendantElements(
        candidateRoot,
        controlledRoots.includes(candidateRoot)
          ? isControlledChoiceOptionElement
          : isChoiceOptionElement
      )
    ),
  ]);
}

function selectorMapForElement(root: DOMElementNode): readonly [number, DOMElementNode][] {
  const entries: [number, DOMElementNode][] = [];
  const visit = (element: DOMElementNode): void => {
    if (element.highlightIndex !== null && element.highlightIndex !== undefined) {
      entries.push([element.highlightIndex, element]);
    }
    for (const child of element.children) {
      if (child instanceof DOMElementNode) {
        visit(child);
      }
    }
  };
  visit(root);
  return entries;
}

function hasAncestorWithId(element: DOMElementNode, id: string): boolean {
  let current: DOMElementNode | null = element;
  while (current) {
    if (readAttribute(current, 'id') === id) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function uniqueElementNodes(elements: readonly DOMElementNode[]): DOMElementNode[] {
  return [...new Set(elements)];
}

function isChoiceOptionElement(element: DOMElementNode): boolean {
  return normalizeTagName(element) === 'option' || readRole(element)?.toLowerCase() === 'option';
}

function isControlledChoiceOptionElement(element: DOMElementNode): boolean {
  return (
    isChoiceOptionElement(element) ||
    (normalizeTagName(element) === 'li' &&
      element.highlightIndex !== null &&
      element.highlightIndex !== undefined &&
      Boolean(normalizeText(nodeText(element))))
  );
}

function descendantElements(
  root: DOMElementNode,
  predicate: (element: DOMElementNode) => boolean
): DOMElementNode[] {
  const matches: DOMElementNode[] = [];
  const visit = (element: DOMElementNode): void => {
    for (const child of element.children) {
      if (!(child instanceof DOMElementNode)) {
        continue;
      }
      if (predicate(child)) {
        matches.push(child);
      }
      if (matches.length < MAX_CONTROL_OPTIONS) {
        visit(child);
      }
    }
  };
  visit(root);
  return matches.slice(0, MAX_CONTROL_OPTIONS);
}

function selectorMapTargetRefForElement(
  input: ExtractMemoryFieldTargetSignalsInput,
  element: DOMElementNode
): string | undefined {
  if (element === input.element) {
    return createSelectorMapTargetRef(input.selectorMapIndex);
  }
  return element.highlightIndex !== null && element.highlightIndex !== undefined
    ? createSelectorMapTargetRef(element.highlightIndex)
    : undefined;
}

function isDisabledOption(element: DOMElementNode): boolean {
  if (
    hasBooleanAttribute(element, 'disabled') ||
    readAttribute(element, 'aria-disabled') === 'true'
  ) {
    return true;
  }
  let current = element.parent;
  while (current) {
    if (normalizeTagName(current) === 'optgroup') {
      return hasBooleanAttribute(current, 'disabled');
    }
    current = current.parent;
  }
  return false;
}

function readCheckedState(element: DOMElementNode): boolean | undefined {
  const ariaSelected = readAttribute(element, 'aria-selected')?.toLowerCase();
  if (ariaSelected === 'true' || ariaSelected === 'false') {
    return ariaSelected === 'true';
  }
  const ariaChecked = readAttribute(element, 'aria-checked')?.toLowerCase();
  if (ariaChecked === 'true' || ariaChecked === 'false') {
    return ariaChecked === 'true';
  }
  const dataState = readAttribute(element, 'data-state')?.toLowerCase();
  if (dataState === 'checked' || dataState === 'unchecked') {
    return dataState === 'checked';
  }
  const inputType = readAttribute(element, 'type')?.toLowerCase();
  const role = readRole(element)?.toLowerCase();
  if (normalizeTagName(element) === 'option') {
    return hasBooleanAttribute(element, 'selected');
  }
  if (
    inputType === 'checkbox' ||
    inputType === 'radio' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch'
  ) {
    return hasBooleanAttribute(element, 'checked');
  }
  return undefined;
}

function radioGroupForElement(
  state: BrowserStateTargetSource,
  element: DOMElementNode
):
  | {
      readonly key: string;
      readonly label?: string;
      readonly options: readonly MemoryFieldControlOption[];
    }
  | undefined {
  if (memoryFieldControlKind(element, memoryFieldTargetKind(element) ?? 'input') !== 'radio') {
    return undefined;
  }
  const name = readAttribute(element, 'name');
  if (!name) {
    return undefined;
  }
  const form = nearestFormElement(element);
  const key = JSON.stringify([form?.xpath ?? 'document', name]);
  const options = ensureUniqueControlOptionValues(
    uniqueControlOptions(
      [...state.selectorMap.entries()].flatMap(([selectorMapIndex, candidate]) => {
        if (
          readAttribute(candidate, 'name') !== name ||
          nearestFormElement(candidate) !== form ||
          memoryFieldControlKind(candidate, memoryFieldTargetKind(candidate) ?? 'input') !== 'radio'
        ) {
          return [];
        }
        const text = boundedControlOptionText(
          firstDefined(
            extractLabelSignal(candidate, state),
            readAttribute(candidate, 'aria-label'),
            readAttribute(candidate, 'value')
          )
        );
        const value = boundedControlOptionText(readAttribute(candidate, 'value') ?? text);
        if (!text || !value) {
          return [];
        }
        const fallbackTargetRef = choiceLabelActionTargetRef(state, candidate);
        return [
          {
            value,
            text,
            bindingKey: controlOptionBindingKey(candidate, form),
            targetRef: createSelectorMapTargetRef(selectorMapIndex),
            ...(fallbackTargetRef ? { fallbackTargetRef } : {}),
            ...(isDisabledOption(candidate) ? { disabled: true } : {}),
            ...(readCheckedState(candidate) !== undefined
              ? { checked: readCheckedState(candidate) }
              : {}),
          },
        ];
      })
    )
  );
  const label = radioGroupLabel(form, name);
  return options.length > 0 ? { key, options, ...(label ? { label } : {}) } : undefined;
}

function choiceLabelActionTargetRef(
  state: BrowserStateTargetSource,
  choice: DOMElementNode
): string | undefined {
  const label = choiceLabelElement(state.elementTree, choice);
  if (!label || !resolveActionTargetKind(label)) {
    return undefined;
  }
  for (const [selectorMapIndex, candidate] of state.selectorMap.entries()) {
    if (candidate === label) {
      return createSelectorMapTargetRef(selectorMapIndex);
    }
  }
  return undefined;
}

function choiceLabelElement(
  root: DOMElementNode,
  choice: DOMElementNode
): DOMElementNode | undefined {
  let current = choice.parent;
  while (current) {
    if (normalizeTagName(current) === 'label') {
      return current;
    }
    current = current.parent;
  }
  const id = readAttribute(choice, 'id');
  return id
    ? findElement(
        root,
        (candidate) =>
          normalizeTagName(candidate) === 'label' && readAttribute(candidate, 'for') === id
      )
    : undefined;
}

function radioGroupLabel(form: DOMElementNode | undefined, name: string): string | undefined {
  if (form) {
    const legend = form.children.find(
      (child): child is DOMElementNode =>
        child instanceof DOMElementNode && normalizeTagName(child) === 'legend'
    );
    const label = firstDefined(
      readAttribute(form, 'aria-label'),
      legend ? nodeText(legend) : undefined,
      readAttribute(form, 'title')
    );
    if (label) {
      return boundedControlOptionText(label);
    }
  }
  const normalized = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`.slice(
        0,
        MAX_CONTROL_OPTION_TEXT_LENGTH
      )
    : undefined;
}

function nearestFormElement(element: DOMElementNode): DOMElementNode | undefined {
  let current = element.parent;
  while (current) {
    const tagName = normalizeTagName(current);
    if (tagName === 'form' || tagName === 'fieldset') {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function uniqueControlOptions(
  options: readonly MemoryFieldControlOption[]
): MemoryFieldControlOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const key = JSON.stringify([option.value, option.text]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [option];
  });
}

function ensureUniqueControlOptionValues(
  options: readonly MemoryFieldControlOption[]
): MemoryFieldControlOption[] {
  const valueCounts = new Map<string, number>();
  const textCounts = new Map<string, number>();
  for (const option of options) {
    valueCounts.set(option.value, (valueCounts.get(option.value) ?? 0) + 1);
    textCounts.set(option.text, (textCounts.get(option.text) ?? 0) + 1);
  }

  return options.map((option, index) => {
    if ((valueCounts.get(option.value) ?? 0) === 1) {
      return option;
    }
    const uniqueValue =
      (textCounts.get(option.text) ?? 0) === 1 ? option.text : `${option.value}#${index + 1}`;
    return { ...option, value: uniqueValue };
  });
}

function boundedControlOptionText(value: string | undefined): string | undefined {
  return normalizeText(value)?.slice(0, MAX_CONTROL_OPTION_TEXT_LENGTH);
}

function controlOptionBindingKey(
  option: DOMElementNode,
  owner: DOMElementNode | undefined
): string {
  const identity = JSON.stringify({
    ownerXpath: owner?.xpath,
    optionXpath: option.xpath,
    tagName: normalizeTagName(option),
    id: readAttribute(option, 'id'),
    name: readAttribute(option, 'name'),
    type: readAttribute(option, 'type'),
    role: readRole(option),
  });
  return `choice_${stableControlToken(identity)}`;
}

function stableControlToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!value || seen.has(value)) {
      return [];
    }
    seen.add(value);
    return [value];
  });
}

function resolveActionTargetKind(element: DOMElementNode): MagicBrowseActionTargetKind | null {
  const tagName = normalizeTagName(element);
  const role = readRole(element)?.toLowerCase();

  if (tagName === 'a' || role === 'link') {
    return 'link';
  }
  if (isSelectLikeControl(element)) {
    return 'select-like';
  }
  if (tagName === 'button') {
    return 'button';
  }
  if (tagName === 'input') {
    return 'input';
  }
  if (tagName === 'textarea') {
    return 'textarea';
  }
  if (tagName === 'select') {
    return 'select';
  }
  if (role === 'button') {
    return 'role-button';
  }
  if (!tagName) {
    return null;
  }
  return 'generic';
}

function resolveSubmitTargetKind(element: DOMElementNode): MagicBrowseSubmitTargetKind | null {
  const tagName = normalizeTagName(element);
  const role = readRole(element)?.toLowerCase();
  const inputType = readAttribute(element, 'type')?.toLowerCase();

  if (tagName === 'button') {
    return isSubmitLikeElement(element) ? 'button' : null;
  }

  if (
    tagName === 'input' &&
    (inputType === 'submit' || inputType === 'button' || inputType === 'image')
  ) {
    return isSubmitLikeElement(element) ? 'input' : null;
  }

  if (role === 'button') {
    return isSubmitLikeElement(element) ? 'role-button' : null;
  }

  return null;
}

function isSubmitLikeElement(element: DOMElementNode): boolean {
  const tagName = normalizeTagName(element);
  const inputType = readAttribute(element, 'type')?.toLowerCase();
  if (tagName === 'button' && (!inputType || inputType === 'submit')) {
    return true;
  }
  if (tagName === 'input' && (inputType === 'submit' || inputType === 'image')) {
    return true;
  }

  return SUBMIT_TEXT_RE.test(
    [
      nodeText(element),
      readAttribute(element, 'value'),
      readAttribute(element, 'aria-label'),
      readAttribute(element, 'title'),
      readAttribute(element, 'name'),
      readAttribute(element, 'id'),
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
  );
}

function buildMemoryFieldTargetContext(
  element: DOMElementNode,
  signals: MemoryFieldTargetSignals
): MemoryFieldTargetContext {
  const validationMessage = visibleValidationMessage(element);
  const selector: MemoryFieldTargetSelectorContext = omitUndefined({
    id: readAttribute(element, 'id'),
    name: signals.inputName,
    role: signals.role,
    xpath: normalizeText(element.xpath),
    css: signals.selectorRoot,
  });
  const state: MemoryFieldTargetStateContext = omitUndefined({
    readonly: signals.isReadonly,
    popupBacked: signals.popupBacked,
    disabled:
      hasBooleanAttribute(element, 'disabled') ||
      readAttribute(element, 'aria-disabled') === 'true',
    required:
      hasBooleanAttribute(element, 'required') ||
      readAttribute(element, 'aria-required') === 'true',
    ...(isWithinActiveModal(element) ? { withinActiveModal: true } : {}),
    ...(isWithinEmbeddedFrame(element) ? { withinEmbeddedFrame: true } : {}),
    ...(readAttribute(element, 'aria-invalid') === 'true' ? { ariaInvalid: true } : {}),
    ...(validationMessage ? { validationMessage } : {}),
    expanded: controlExpandedState(element),
    ...(signals.checked !== undefined ? { checked: signals.checked } : {}),
    ...(signals.hasValue !== undefined ? { valuePresent: signals.hasValue } : {}),
    ...(signals.valueShape ? { valueShape: signals.valueShape } : {}),
  });
  const form = nearestFormContext(element);
  const source: MemoryFieldTargetSourceContext = {
    kind: 'selectorMap',
    ref: signals.ref,
    index: signals.selectorMapIndex,
    highlightIndex: element.highlightIndex ?? undefined,
    snapshotScoped: true,
  };

  return {
    source,
    selector,
    state,
    ...(form ? { form } : {}),
  };
}

function isWithinActiveModal(element: DOMElementNode): boolean {
  let current = element.parent;
  while (current) {
    const tagName = normalizeTagName(current);
    if (
      readAttribute(current, 'aria-modal') === 'true' ||
      (tagName === 'dialog' && hasBooleanAttribute(current, 'open'))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isWithinEmbeddedFrame(element: DOMElementNode): boolean {
  let current = element.parent;
  while (current) {
    if (normalizeTagName(current) === 'iframe') {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const VALIDATION_ERROR_CLASS_RE = /(?:^|[\s_-])(?:error|invalid)(?:$|[\s_-])/i;

function visibleValidationMessage(element: DOMElementNode): string | undefined {
  const hasErrorSignal =
    readAttribute(element, 'aria-invalid') === 'true' ||
    readAttribute(element, 'data-invalid') === 'true' ||
    VALIDATION_ERROR_CLASS_RE.test(readAttribute(element, 'class') ?? '') ||
    VALIDATION_ERROR_CLASS_RE.test(
      element.parent ? (readAttribute(element.parent, 'class') ?? '') : ''
    );
  if (!hasErrorSignal) {
    return undefined;
  }

  let current = element.parent;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const message = nearbyNonInteractiveText(current, element);
    if (message) {
      return message.slice(0, MAX_LABEL_TEXT_LENGTH);
    }
    current = current.parent;
  }
  return undefined;
}

function nearbyNonInteractiveText(
  root: DOMElementNode,
  excluded: DOMElementNode
): string | undefined {
  const textParts: string[] = [];
  const collect = (node: DOMElementNode | DOMTextNode): void => {
    if (!node.isVisible || node === excluded) {
      return;
    }
    if (node instanceof DOMTextNode) {
      textParts.push(node.text);
      return;
    }
    if (
      node !== root &&
      (node.isInteractive ||
        hasBooleanAttribute(node, 'hidden') ||
        hasBooleanAttribute(node, 'inert'))
    ) {
      return;
    }
    for (const child of node.children) {
      if (child instanceof DOMElementNode || child instanceof DOMTextNode) {
        collect(child);
      }
    }
  };
  collect(root);
  return normalizeText(textParts.join(' '))?.slice(0, MAX_LABEL_TEXT_LENGTH);
}

function hasDirectSelectLikeSemantics(element: DOMElementNode): boolean {
  const role = readRole(element);
  if (role && SELECT_LIKE_ROLES.has(role)) {
    return true;
  }

  const hasPopup = readAttribute(element, 'aria-haspopup')?.toLowerCase();
  if (hasPopup && SELECT_LIKE_HASPOPUP_VALUES.has(hasPopup)) {
    return true;
  }

  return (
    readAttribute(element, 'data-toggle') === 'dropdown' || hasClass(element, 'dropdown-toggle')
  );
}

function isSelectLikeControl(element: DOMElementNode): boolean {
  if (hasDirectSelectLikeSemantics(element)) {
    return true;
  }
  return normalizeTagName(element) === 'input' && nearestSelectLikeOwner(element) !== undefined;
}

function nearestSelectLikeOwner(element: DOMElementNode): DOMElementNode | undefined {
  let current = element.parent;
  for (
    let depth = 0;
    current && depth < MAX_SELECT_LIKE_OWNER_DEPTH;
    depth += 1, current = current.parent
  ) {
    if (hasDirectSelectLikeSemantics(current) || isSelectLikeCustomElement(current)) {
      return current;
    }
    const tagName = normalizeTagName(current);
    if (tagName === 'form' || tagName === 'body') {
      break;
    }
  }
  return undefined;
}

function controlExpandedState(element: DOMElementNode): string | undefined {
  const direct = readAttribute(element, 'aria-expanded');
  if (direct !== undefined) {
    return direct;
  }

  let current = element.parent;
  for (
    let depth = 0;
    current && depth < MAX_SELECT_LIKE_OWNER_DEPTH;
    depth += 1, current = current.parent
  ) {
    if (hasDirectSelectLikeSemantics(current) || isSelectLikeCustomElement(current)) {
      const inherited = readAttribute(current, 'aria-expanded');
      if (inherited !== undefined) {
        return inherited;
      }
    }
    const tagName = normalizeTagName(current);
    if (tagName === 'form' || tagName === 'body') {
      break;
    }
  }
  return undefined;
}

function isSelectLikeCustomElement(element: DOMElementNode): boolean {
  const tagName = normalizeTagName(element);
  if (!tagName.includes('-')) {
    return false;
  }
  return tagName.split('-').some((part) => SELECT_LIKE_CUSTOM_ELEMENT_PARTS.has(part));
}

function isPopupBackedControl(element: DOMElementNode): boolean {
  const tagName = normalizeTagName(element);
  const hasPopup = readAttribute(element, 'aria-haspopup')?.toLowerCase();
  return (
    tagName === 'select' ||
    isSelectLikeControl(element) ||
    (hasPopup !== undefined && POPUP_HASPOPUP_VALUES.has(hasPopup))
  );
}

function extractLabelSignal(
  element: DOMElementNode,
  state?: Pick<BrowserStateTargetSource, 'elementTree'>
): string | undefined {
  return firstDefined(
    labelledByText(element, state),
    readAttribute(element, 'aria-label'),
    nativeLabelText(element),
    explicitLabelText(element, state),
    wrappingLabelText(element),
    readAttribute(element, 'title')
  );
}

function labelledByText(
  element: DOMElementNode,
  state?: Pick<BrowserStateTargetSource, 'elementTree'>
): string | undefined {
  const labelledBy = readAttribute(element, 'aria-labelledby');
  if (!labelledBy || !state) {
    return undefined;
  }

  const labels = labelledBy
    .split(/\s+/)
    .map((id) => findElementById(state.elementTree, id))
    .map((node) => (node ? nodeText(node) : undefined))
    .filter((value): value is string => value !== undefined);
  return normalizeText(labels.join(' '));
}

function explicitLabelText(
  element: DOMElementNode,
  state?: Pick<BrowserStateTargetSource, 'elementTree'>
): string | undefined {
  const id = readAttribute(element, 'id');
  if (!id || !state) {
    return undefined;
  }

  const label = findElement(
    state.elementTree,
    (node) => normalizeTagName(node) === 'label' && readAttribute(node, 'for') === id
  );
  return label ? nativeLabelText(label) : undefined;
}

function wrappingLabelText(element: DOMElementNode): string | undefined {
  let current = element.parent;
  while (current) {
    if (normalizeTagName(current) === 'label') {
      return nativeLabelText(current);
    }
    current = current.parent;
  }

  return undefined;
}

/**
 * Native label text is an ownership signal, so it remains meaningful even when
 * the browser snapshot marks a nested tooltip or input as separately
 * interactive. The normal compact text reader intentionally stops at those
 * descendants; native labels need the bounded visible text of the full label.
 */
function nativeLabelText(element: DOMElementNode): string | undefined {
  if (normalizeTagName(element) !== 'label') {
    return undefined;
  }

  const textParts: string[] = [];
  const collectVisibleText = (node: DOMElementNode | DOMTextNode): void => {
    if (!node.isVisible) {
      return;
    }
    if (node instanceof DOMTextNode) {
      textParts.push(node.text);
      return;
    }
    if (
      node !== element &&
      (hasBooleanAttribute(node, 'hidden') || hasBooleanAttribute(node, 'inert'))
    ) {
      return;
    }
    for (const child of node.children) {
      if (child instanceof DOMElementNode || child instanceof DOMTextNode) {
        collectVisibleText(child);
      }
    }
  };

  collectVisibleText(element);
  return normalizeText(textParts.join(' '))?.slice(0, MAX_LABEL_TEXT_LENGTH);
}

function extractTextSignal(
  element: DOMElementNode,
  kind: MemoryFieldTargetKind
): string | undefined {
  if (kind === 'input' || kind === 'textarea') {
    return undefined;
  }

  return nodeText(element);
}

function nodeText(element: DOMElementNode): string | undefined {
  return normalizeText(element.getAllTextTillNextClickableElement());
}

function nearestFormContext(element: DOMElementNode): MemoryFieldTargetFormContext | undefined {
  let current = element.parent;
  while (current) {
    const tagName = normalizeTagName(current);
    if (tagName === 'form' || tagName === 'fieldset') {
      return omitUndefined({
        tagName,
        id: readAttribute(current, 'id'),
        name: readAttribute(current, 'name'),
        label: firstDefined(readAttribute(current, 'aria-label'), readAttribute(current, 'title')),
      });
    }
    current = current.parent;
  }

  return undefined;
}

function findElementById(root: DOMElementNode, id: string): DOMElementNode | undefined {
  return findElement(root, (node) => readAttribute(node, 'id') === id);
}

function findElement(
  root: DOMElementNode,
  predicate: (node: DOMElementNode) => boolean
): DOMElementNode | undefined {
  if (predicate(root)) {
    return root;
  }

  for (const child of root.children) {
    if (child instanceof DOMElementNode) {
      const match = findElement(child, predicate);
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

function safeSelectorRoot(element: DOMElementNode): string | undefined {
  try {
    return normalizeText(element.getEnhancedCssSelector());
  } catch {
    return undefined;
  }
}

function readRole(element: DOMElementNode): string | undefined {
  return readAttribute(element, 'role') ?? readAttribute(element, 'aria-role');
}

function readAttribute(element: DOMElementNode, name: string): string | undefined {
  return normalizeText(element.attributes[name]);
}

function hasBooleanAttribute(element: DOMElementNode, name: string): boolean {
  const value = element.attributes[name];
  return value !== undefined && (value === '' || value.toLowerCase() === 'true' || value === name);
}

function isReadonlyControl(element: DOMElementNode): boolean {
  return (
    hasBooleanAttribute(element, 'readonly') || readAttribute(element, 'aria-readonly') === 'true'
  );
}

function hasClass(element: DOMElementNode, className: string): boolean {
  return Boolean(readAttribute(element, 'class')?.split(/\s+/).includes(className));
}

function normalizeTagName(element: DOMElementNode): string {
  return (element.tagName ?? '').toLowerCase();
}

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

export function actionDescriptorsMatch(
  expected: MagicBrowseActionTargetDescriptor,
  actual: MagicBrowseActionTargetDescriptor
): boolean {
  const stableIdentityMatches =
    expected.ref === actual.ref &&
    expected.selectorMapIndex === actual.selectorMapIndex &&
    expected.kind === actual.kind &&
    sameString(expected.tagName, actual.tagName, { normalizeCase: true }) &&
    sameOptionalString(expected.href, actual.href) &&
    sameOptionalString(expected.inputName, actual.inputName) &&
    sameOptionalString(expected.inputType, actual.inputType, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.selectorRoot, actual.selectorRoot) &&
    expected.isDisabled === actual.isDisabled &&
    sameOptionalString(expected.context.selector.id, actual.context.selector.id) &&
    sameOptionalString(expected.context.selector.name, actual.context.selector.name) &&
    sameOptionalString(expected.context.selector.role, actual.context.selector.role) &&
    sameOptionalString(expected.context.selector.xpath, actual.context.selector.xpath) &&
    sameOptionalString(expected.context.selector.css, actual.context.selector.css) &&
    expected.context.state.readonly === actual.context.state.readonly &&
    expected.context.state.popupBacked === actual.context.state.popupBacked &&
    expected.context.state.disabled === actual.context.state.disabled &&
    expected.context.state.required === actual.context.state.required &&
    sameOptionalString(expected.context.state.expanded, actual.context.state.expanded) &&
    sameOptionalString(expected.context.form?.tagName, actual.context.form?.tagName, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.context.form?.id, actual.context.form?.id) &&
    sameOptionalString(expected.context.form?.name, actual.context.form?.name) &&
    sameOptionalString(expected.context.form?.label, actual.context.form?.label);
  if (!stableIdentityMatches) {
    return false;
  }

  const presentationMatches =
    sameOptionalString(expected.label, actual.label) &&
    sameOptionalString(expected.displayLabel, actual.displayLabel) &&
    sameOptionalString(expected.text, actual.text);
  return (
    presentationMatches || Boolean(expected.bindingKey && expected.bindingKey === actual.bindingKey)
  );
}

function isChoiceActionElement(element: DOMElementNode): boolean {
  const inputType = readAttribute(element, 'type')?.toLowerCase();
  const role = readRole(element)?.toLowerCase();
  return (
    normalizeTagName(element) === 'option' ||
    normalizeTagName(element) === 'li' ||
    inputType === 'radio' ||
    role === 'radio' ||
    role === 'option'
  );
}

function submitDescriptorsMatch(
  expected: MagicBrowseSubmitTargetDescriptor,
  actual: MagicBrowseSubmitTargetDescriptor
): boolean {
  return (
    expected.ref === actual.ref &&
    expected.selectorMapIndex === actual.selectorMapIndex &&
    expected.kind === actual.kind &&
    sameString(expected.tagName, actual.tagName, { normalizeCase: true }) &&
    sameOptionalString(expected.label, actual.label) &&
    sameOptionalString(expected.displayLabel, actual.displayLabel) &&
    sameOptionalString(expected.text, actual.text) &&
    sameOptionalString(expected.inputName, actual.inputName) &&
    sameOptionalString(expected.inputType, actual.inputType, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.selectorRoot, actual.selectorRoot) &&
    expected.isDisabled === actual.isDisabled &&
    sameOptionalString(expected.context.selector.id, actual.context.selector.id) &&
    sameOptionalString(expected.context.selector.name, actual.context.selector.name) &&
    sameOptionalString(expected.context.selector.role, actual.context.selector.role) &&
    sameOptionalString(expected.context.selector.xpath, actual.context.selector.xpath) &&
    sameOptionalString(expected.context.selector.css, actual.context.selector.css) &&
    expected.context.state.disabled === actual.context.state.disabled &&
    sameOptionalString(expected.context.state.expanded, actual.context.state.expanded) &&
    sameOptionalString(expected.context.form?.tagName, actual.context.form?.tagName, {
      normalizeCase: true,
    }) &&
    sameOptionalString(expected.context.form?.id, actual.context.form?.id) &&
    sameOptionalString(expected.context.form?.name, actual.context.form?.name) &&
    sameOptionalString(expected.context.form?.label, actual.context.form?.label)
  );
}

function sameOptionalString(
  expected: string | undefined,
  actual: string | undefined,
  options: { readonly normalizeCase?: boolean } = {}
): boolean {
  if (expected === undefined) {
    return true;
  }
  return sameString(expected, actual, options);
}

function sameString(
  expected: string,
  actual: string | undefined,
  options: { readonly normalizeCase?: boolean } = {}
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (options.normalizeCase) {
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return expected === actual;
}

function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}
