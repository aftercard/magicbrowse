import type { BrowserState } from '../vendor/browser/views.js';
import { DOMElementNode } from '../vendor/browser/dom/views.js';
import type {
  MagicBrowseActionTargetDescriptor,
  MagicBrowseActionTargetKind,
  MagicBrowseSubmitTargetDescriptor,
  MagicBrowseSubmitTargetKind,
} from '../types.js';
import type { ResolveFieldTargetDescriptor } from './resolve-field.js';

export type ResolveFieldTargetKind = 'input' | 'textarea' | 'select' | 'select-like';

export interface ResolveFieldTargetSignals {
  readonly ref: string;
  readonly index: number;
  readonly selectorMapIndex: number;
  readonly kind: ResolveFieldTargetKind;
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
}

export interface ResolveFieldTargetSourceContext {
  readonly kind: 'selectorMap';
  readonly ref: string;
  readonly index: number;
  readonly highlightIndex?: number;
  readonly snapshotScoped: true;
}

export interface ResolveFieldTargetSelectorContext {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
  readonly xpath?: string;
  readonly css?: string;
}

export interface ResolveFieldTargetStateContext {
  readonly readonly: boolean;
  readonly popupBacked: boolean;
  readonly disabled: boolean;
  readonly required: boolean;
  readonly expanded?: string;
}

export interface ResolveFieldTargetFormContext {
  readonly tagName: string;
  readonly id?: string;
  readonly name?: string;
  readonly label?: string;
}

export interface ResolveFieldTargetContext {
  readonly source: ResolveFieldTargetSourceContext;
  readonly selector: ResolveFieldTargetSelectorContext;
  readonly state: ResolveFieldTargetStateContext;
  readonly form?: ResolveFieldTargetFormContext;
}

export type BrowserStateResolveFieldTargetDescriptor = ResolveFieldTargetDescriptor &
  ResolveFieldTargetSignals & {
    readonly pageRef?: string;
    readonly host?: string;
    readonly context: ResolveFieldTargetContext;
  };

export type BrowserStateTargetSource = Pick<
  BrowserState,
  'elementTree' | 'selectorMap' | 'tabId' | 'url'
>;

export interface ExtractResolveFieldTargetSignalsInput {
  readonly state?: Pick<BrowserStateTargetSource, 'elementTree'>;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}

const TARGET_REF_PREFIX = 'selector:';
const NON_FIELD_INPUT_TYPES = new Set(['hidden', 'button', 'submit', 'reset', 'image', 'file']);
const SELECT_LIKE_ROLES = new Set(['combobox', 'listbox']);
const SELECT_LIKE_HASPOPUP_VALUES = new Set(['true', 'listbox']);
const POPUP_HASPOPUP_VALUES = new Set(['true', 'listbox', 'menu', 'tree', 'grid', 'dialog']);
const SUBMIT_TEXT_RE =
  /\b(submit|continue|sign in|log in|pay|buy|book|reserve|checkout|next|done)\b|оплат|войти|далее/i;

/**
 * Builds snapshot-scoped field descriptors from the current browser state.
 * Descriptor refs intentionally point back to this state's selectorMap index;
 * future fill code must revalidate them against a fresh state before acting.
 */
export function buildResolveFieldTargetDescriptors(
  state: BrowserStateTargetSource
): readonly BrowserStateResolveFieldTargetDescriptor[] {
  const descriptors: BrowserStateResolveFieldTargetDescriptor[] = [];

  for (const [selectorMapIndex, element] of state.selectorMap.entries()) {
    const descriptor = createResolveFieldTargetDescriptor({
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

  return descriptors;
}

export function createResolveFieldTargetDescriptor(input: {
  readonly state: BrowserStateTargetSource;
  readonly element: DOMElementNode;
  readonly selectorMapIndex: number;
}): BrowserStateResolveFieldTargetDescriptor | null {
  const signals = extractResolveFieldTargetSignals(input);
  if (!signals) {
    return null;
  }

  const context = buildResolveFieldTargetContext(input.element, signals);
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
    displayLabel: firstDefined(label, text, inputName, href, readAttribute(input.element, 'id')),
    text,
    href,
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
        readonly: isReadonlyControl(input.element),
        popupBacked: isPopupBackedControl(input.element),
        disabled,
        required:
          hasBooleanAttribute(input.element, 'required') ||
          readAttribute(input.element, 'aria-required') === 'true',
        expanded: readAttribute(input.element, 'aria-expanded'),
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

export function extractResolveFieldTargetSignals(
  input: ExtractResolveFieldTargetSignalsInput
): ResolveFieldTargetSignals | null {
  const kind = resolveFieldTargetKind(input.element);
  if (!kind) {
    return null;
  }

  const tagName = normalizeTagName(input.element);
  const role = readRole(input.element);
  const text = extractTextSignal(input.element, kind);
  const label = extractLabelSignal(input.element, input.state);
  const placeholder = readAttribute(input.element, 'placeholder');
  const inputName = readAttribute(input.element, 'name');
  const inputType = kind === 'input' ? (readAttribute(input.element, 'type') ?? 'text') : undefined;
  const autocomplete = readAttribute(input.element, 'autocomplete');
  const selectorRoot = safeSelectorRoot(input.element);
  const isReadonly = isReadonlyControl(input.element);
  const popupBacked = isPopupBackedControl(input.element);
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
  };
}

export function isResolveFieldTargetElement(element: DOMElementNode): boolean {
  return resolveFieldTargetKind(element) !== null;
}

export function resolveSelectorMapElementForTarget(
  state: Pick<BrowserStateTargetSource, 'selectorMap'>,
  target: Pick<ResolveFieldTargetDescriptor, 'ref' | 'selectorMapIndex'>
): DOMElementNode | undefined {
  const index = target.selectorMapIndex ?? parseSelectorMapTargetRef(target.ref);
  return index === null ? undefined : state.selectorMap.get(index);
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

function resolveFieldTargetKind(element: DOMElementNode): ResolveFieldTargetKind | null {
  const tagName = normalizeTagName(element);
  if (tagName === 'textarea') {
    return isReadonlyControl(element) ? null : 'textarea';
  }
  if (tagName === 'select') {
    return 'select';
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

function buildResolveFieldTargetContext(
  element: DOMElementNode,
  signals: ResolveFieldTargetSignals
): ResolveFieldTargetContext {
  const selector: ResolveFieldTargetSelectorContext = omitUndefined({
    id: readAttribute(element, 'id'),
    name: signals.inputName,
    role: signals.role,
    xpath: normalizeText(element.xpath),
    css: signals.selectorRoot,
  });
  const state: ResolveFieldTargetStateContext = omitUndefined({
    readonly: signals.isReadonly,
    popupBacked: signals.popupBacked,
    disabled:
      hasBooleanAttribute(element, 'disabled') ||
      readAttribute(element, 'aria-disabled') === 'true',
    required:
      hasBooleanAttribute(element, 'required') ||
      readAttribute(element, 'aria-required') === 'true',
    expanded: readAttribute(element, 'aria-expanded'),
  });
  const form = nearestFormContext(element);
  const source: ResolveFieldTargetSourceContext = {
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

function isSelectLikeControl(element: DOMElementNode): boolean {
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
  return label ? nodeText(label) : undefined;
}

function wrappingLabelText(element: DOMElementNode): string | undefined {
  let current = element.parent;
  while (current) {
    if (normalizeTagName(current) === 'label') {
      return nodeText(current);
    }
    current = current.parent;
  }

  return undefined;
}

function extractTextSignal(
  element: DOMElementNode,
  kind: ResolveFieldTargetKind
): string | undefined {
  if (kind === 'input' || kind === 'textarea') {
    return undefined;
  }

  return nodeText(element);
}

function nodeText(element: DOMElementNode): string | undefined {
  return normalizeText(element.getAllTextTillNextClickableElement());
}

function nearestFormContext(element: DOMElementNode): ResolveFieldTargetFormContext | undefined {
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
  return (
    expected.ref === actual.ref &&
    expected.selectorMapIndex === actual.selectorMapIndex &&
    expected.kind === actual.kind &&
    sameString(expected.tagName, actual.tagName, { normalizeCase: true }) &&
    sameOptionalString(expected.label, actual.label) &&
    sameOptionalString(expected.displayLabel, actual.displayLabel) &&
    sameOptionalString(expected.text, actual.text) &&
    sameOptionalString(expected.href, actual.href) &&
    sameOptionalString(expected.inputName, actual.inputName) &&
    sameOptionalString(expected.inputType, actual.inputType, { normalizeCase: true }) &&
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
    sameOptionalString(expected.context.form?.label, actual.context.form?.label)
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
    sameOptionalString(expected.inputType, actual.inputType, { normalizeCase: true }) &&
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
