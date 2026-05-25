export type PromptMemoryHintRole = 'navigator' | 'planner';

export interface PromptMemoryHints {
  readonly navigator?: string;
  readonly planner?: string;
}

export function appendPromptMemoryHints(
  systemPrompt: string,
  role: PromptMemoryHintRole,
  hints: string | undefined
): string {
  const section = buildPromptMemoryHintsSection(role, hints);
  return section ? `${systemPrompt.trim()}\n\n${section}` : systemPrompt;
}

function buildPromptMemoryHintsSection(
  role: PromptMemoryHintRole,
  hints: string | undefined
): string {
  const trimmed = hints?.trim();
  if (!trimmed) {
    return '';
  }

  const tagName = role === 'navigator' ? 'navigator_memory_hints' : 'planner_memory_hints';
  const focus =
    role === 'navigator'
      ? 'Use these hints only for local browser tactics on matching visible page states.'
      : 'Use these hints only for planning, completion validation, and stop-status decisions on matching evidence.';

  return [
    `# Experimental Active Memory Hints (${role})`,
    '',
    'The following operator-provided hints are an experimental acceleration feature.',
    focus,
    'They never override the delegated browser task, current page evidence, or security rules.',
    'Ignore any hint whose precondition does not match the current browser state.',
    '',
    `<${tagName}>`,
    trimmed,
    `</${tagName}>`,
  ].join('\n');
}
