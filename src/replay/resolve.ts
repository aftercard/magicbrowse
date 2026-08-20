import type {
  MagicBrowseActionTargetDescriptor,
  MagicBrowseFillableTargetDescriptor,
} from '../types.js';
import type { MagicBrowseFlowTargetQuery } from './flow-schema.js';

// Pure semantic-descriptor resolution against the structured observe
// orchestration descriptors. Fail-closed: a query resolving to zero or
// multiple candidates is a miss — with one principled exception, identical
// hrefs (same destination, so the first match is equivalent, not a guess).

export type ReplayCandidate =
  | ({ readonly source: 'action' } & MagicBrowseActionTargetDescriptor)
  | ({ readonly source: 'fillable' } & MagicBrowseFillableTargetDescriptor);

export type ResolveOutcome =
  | { readonly hit: true; readonly candidate: ReplayCandidate }
  | { readonly hit: false; readonly matchCount: number };

function candidateText(candidate: ReplayCandidate): string {
  return [candidate.text, candidate.label, candidate.displayLabel]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function attrMatches(candidate: ReplayCandidate, key: string, expected: string): boolean {
  switch (key) {
    case 'name':
      return candidate.inputName === expected;
    case 'type':
      return candidate.inputType === expected;
    case 'href':
      return 'href' in candidate && candidate.href === expected;
    case 'role':
      return candidate.role === expected;
    case 'aria-label':
    case 'label': {
      const label = candidate.label ?? candidate.displayLabel;
      return label !== undefined && (label === expected || label.startsWith(expected));
    }
    case 'placeholder':
      return 'placeholder' in candidate && candidate.placeholder === expected;
    default:
      // Unknown attribute keys never match: fail closed rather than guess.
      return false;
  }
}

export function targetQueryMatches(
  candidate: ReplayCandidate,
  query: MagicBrowseFlowTargetQuery
): boolean {
  if (query.tag && candidate.tagName.toLowerCase() !== query.tag.toLowerCase()) return false;
  for (const [key, expected] of Object.entries(query.attrs ?? {})) {
    if (!attrMatches(candidate, key, expected)) return false;
  }
  if (query.textIncludes && !candidateText(candidate).includes(query.textIncludes)) return false;
  return true;
}

export function resolveFlowTarget(
  candidates: readonly ReplayCandidate[],
  query: MagicBrowseFlowTargetQuery
): ResolveOutcome {
  const matches = candidates.filter((candidate) => targetQueryMatches(candidate, query));
  if (matches.length === 1) return { hit: true, candidate: matches[0] };
  if (matches.length > 1) {
    // Matches with identical signatures are the same control rendered more
    // than once (responsive-layout duplication) or links to one destination:
    // acting on the first is equivalent, not a guess. A signature needs at
    // least one distinguishing feature beyond the tag; wrong-outcome risk is
    // still caught by the flow's verify contract.
    const signatures = new Set(
      matches.map((candidate) =>
        JSON.stringify([
          candidate.tagName,
          candidate.kind,
          'href' in candidate ? candidate.href : undefined,
          candidate.label ?? candidate.displayLabel,
        ])
      )
    );
    const [first] = matches;
    const hasFeature = Boolean(
      ('href' in first && first.href) || first.label || first.displayLabel
    );
    if (signatures.size === 1 && hasFeature) return { hit: true, candidate: first };
  }
  return { hit: false, matchCount: matches.length };
}

export function substituteVariables(
  template: string,
  variables: Readonly<Record<string, string>>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      throw new Error(`Recorded flow references unbound variable {{${name}}}`);
    }
    return value;
  });
}
