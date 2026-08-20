import { createHash, randomUUID } from 'node:crypto';

import type {
  MagicBrowseActionTargetDescriptor,
  MagicBrowseFillableTargetDescriptor,
} from '../types.js';
import type { FormMutationSummary, FrameMutationWindow } from '../browser/form-mutation-journal.js';
import { DOMElementNode, type DOMState } from '../vendor/browser/dom/views.js';

export type MutationLeaseAction = 'click' | 'fill' | 'type' | 'select';

export interface TargetInteractionScope {
  readonly documentRef: string;
  readonly targetNodeId: string;
  readonly targetAncestorNodeIds: readonly string[];
  readonly formOwnerNodeIds: readonly string[];
  readonly modalOwnerNodeIds: readonly string[];
  readonly contributingLabelNodeIds: readonly string[];
  readonly optionOwnerNodeIds: readonly string[];
  readonly frameOwnerNodeIds: readonly string[];
}

export interface TargetObservationLease {
  readonly leaseRef: string;
  readonly observationRef: string;
  readonly pageRef: string;
  readonly documentRef: string;
  readonly observedEpoch: number;
  readonly descriptorSignature: string;
  readonly action: MutationLeaseAction;
  readonly targetRef: string;
  readonly scope: TargetInteractionScope;
  readonly consumed?: boolean;
}

export type TargetObservationLeaseValidation =
  | { readonly status: 'valid' }
  | {
      readonly status: 'blocked';
      readonly cause: 'relevant_dom_mutation' | 'mutation_history_unavailable';
    };

const MAX_SCOPE_CATEGORY = 32;
const MAX_SCOPE_TOTAL = 96;

export function createTargetObservationLease(input: {
  readonly state: DOMState & { readonly tabId: number };
  readonly element: DOMElementNode;
  readonly descriptor: MagicBrowseFillableTargetDescriptor | MagicBrowseActionTargetDescriptor;
  readonly action: MutationLeaseAction;
  readonly observationRef: string;
}): TargetObservationLease | undefined {
  const scope = buildTargetInteractionScope(input.state, input.element);
  if (!scope) return undefined;
  const frame = input.state.formMutationFrames?.find(
    (candidate) => candidate.checkpoint?.documentRef === scope.documentRef
  );
  if (!frame?.checkpoint || frame.missing) return undefined;
  return {
    leaseRef: randomUUID(),
    observationRef: input.observationRef,
    pageRef: `tab:${input.state.tabId}`,
    documentRef: scope.documentRef,
    observedEpoch: frame.checkpoint.epoch,
    descriptorSignature: targetDescriptorSignature(input.descriptor, input.action),
    action: input.action,
    targetRef: input.descriptor.ref,
    scope,
  };
}

export function targetDescriptorSignature(
  descriptor: MagicBrowseFillableTargetDescriptor | MagicBrowseActionTargetDescriptor,
  action: MutationLeaseAction
): string {
  const selector = descriptor.context.selector;
  const form = descriptor.context.form;
  return createHash('sha256')
    .update(
      JSON.stringify({
        action,
        pageRef: descriptor.pageRef,
        kind: descriptor.kind,
        tagName: descriptor.tagName?.toLowerCase(),
        role: descriptor.role,
        inputName: descriptor.inputName,
        inputType: descriptor.inputType?.toLowerCase(),
        autocomplete: 'autocomplete' in descriptor ? descriptor.autocomplete : undefined,
        selectorRoot: descriptor.selectorRoot,
        selector: {
          id: selector.id,
          name: selector.name,
          role: selector.role,
          xpath: selector.xpath,
          css: selector.css,
        },
        form: form
          ? { tagName: form.tagName?.toLowerCase(), id: form.id, name: form.name }
          : undefined,
      })
    )
    .digest('hex');
}

export function validateTargetObservationLease(input: {
  readonly lease: TargetObservationLease;
  readonly currentElement: DOMElementNode;
  readonly currentDescriptor:
    | MagicBrowseFillableTargetDescriptor
    | MagicBrowseActionTargetDescriptor;
  readonly action: MutationLeaseAction;
  readonly mutationWindow?: FrameMutationWindow;
}): TargetObservationLeaseValidation {
  const { lease, currentElement, currentDescriptor, action, mutationWindow } = input;
  if (
    lease.consumed ||
    lease.action !== action ||
    lease.pageRef !== currentDescriptor.pageRef ||
    lease.documentRef !== currentElement.documentRef ||
    lease.scope.targetNodeId !== currentElement.internalNodeId ||
    lease.descriptorSignature !== targetDescriptorSignature(currentDescriptor, action)
  ) {
    return { status: 'blocked', cause: 'relevant_dom_mutation' };
  }
  if (
    !mutationWindow ||
    mutationWindow.checkpoint.documentRef !== lease.documentRef ||
    (!mutationWindow.coverageAvailable && mutationWindow.checkpoint.epoch > lease.observedEpoch) ||
    mutationWindow.checkpoint.oldestRetainedEpoch > lease.observedEpoch + 1
  ) {
    return { status: 'blocked', cause: 'mutation_history_unavailable' };
  }
  return mutationWindow.summaries.some(
    (summary) =>
      summary.epoch > lease.observedEpoch && mutationIntersectsScope(summary, lease.scope)
  )
    ? { status: 'blocked', cause: 'relevant_dom_mutation' }
    : { status: 'valid' };
}

export function mutationIntersectsScope(
  summary: FormMutationSummary,
  scope: TargetInteractionScope
): boolean {
  const relevant = new Set([
    scope.targetNodeId,
    ...scope.targetAncestorNodeIds,
    ...scope.formOwnerNodeIds,
    ...scope.modalOwnerNodeIds,
    ...scope.contributingLabelNodeIds,
    ...scope.optionOwnerNodeIds,
    ...scope.frameOwnerNodeIds,
  ]);
  return [...summary.affectedNodeIds, ...summary.affectedOwnerNodeIds].some((id) =>
    relevant.has(id)
  );
}

export function buildTargetInteractionScope(
  state: DOMState,
  element: DOMElementNode
): TargetInteractionScope | undefined {
  if (!element.internalNodeId || !element.documentRef) return undefined;
  const ancestors: DOMElementNode[] = [];
  for (let cursor = element.parent; cursor; cursor = cursor.parent) ancestors.push(cursor);
  const labels = findContributingLabels(state.elementTree, element);
  const formOwners = ancestors.filter((node) => node.tagName?.toLowerCase() === 'form');
  const modalOwners = ancestors.filter((node) => {
    const tag = node.tagName?.toLowerCase();
    return tag === 'dialog' || node.attributes.role === 'dialog';
  });
  const optionOwners = ancestors.filter((node) => {
    const tag = node.tagName?.toLowerCase();
    return tag === 'select' || node.attributes.role === 'listbox';
  });
  const frameOwners = ancestors.filter((node) => node.tagName?.toLowerCase() === 'iframe');
  const scope: TargetInteractionScope = {
    documentRef: element.documentRef,
    targetNodeId: element.internalNodeId,
    targetAncestorNodeIds: ids(ancestors),
    formOwnerNodeIds: ids(formOwners),
    modalOwnerNodeIds: ids(modalOwners),
    contributingLabelNodeIds: ids(labels),
    optionOwnerNodeIds: ids(optionOwners),
    frameOwnerNodeIds: ids(frameOwners),
  };
  const categories = [
    scope.targetAncestorNodeIds,
    scope.formOwnerNodeIds,
    scope.modalOwnerNodeIds,
    scope.contributingLabelNodeIds,
    scope.optionOwnerNodeIds,
    scope.frameOwnerNodeIds,
  ];
  const total = 1 + categories.reduce((count, category) => count + category.length, 0);
  return categories.some((category) => category.length > MAX_SCOPE_CATEGORY) ||
    total > MAX_SCOPE_TOTAL
    ? undefined
    : scope;
}

function findContributingLabels(root: DOMElementNode, target: DOMElementNode): DOMElementNode[] {
  const labels: DOMElementNode[] = [];
  const targetId = target.attributes.id;
  const ariaIds = new Set(
    (target.attributes['aria-labelledby'] ?? '').split(/\s+/u).filter(Boolean)
  );
  walk(root, (node) => {
    const tag = node.tagName?.toLowerCase();
    if (
      (tag === 'label' && targetId && node.attributes.for === targetId) ||
      (node.attributes.id && ariaIds.has(node.attributes.id)) ||
      (tag === 'label' && isAncestor(node, target))
    ) {
      labels.push(node);
    }
  });
  return labels;
}

function walk(node: DOMElementNode, visit: (node: DOMElementNode) => void): void {
  visit(node);
  for (const child of node.children) if (child instanceof DOMElementNode) walk(child, visit);
}

function isAncestor(candidate: DOMElementNode, node: DOMElementNode): boolean {
  for (let cursor = node.parent; cursor; cursor = cursor.parent)
    if (cursor === candidate) return true;
  return false;
}

function ids(nodes: readonly DOMElementNode[]): string[] {
  return Array.from(
    new Set(nodes.map((node) => node.internalNodeId).filter((id): id is string => Boolean(id)))
  );
}
