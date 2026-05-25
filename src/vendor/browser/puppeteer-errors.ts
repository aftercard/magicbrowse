const TRANSIENT_PUPPETEER_CONTEXT_ERROR_PATTERNS = [
  'attempted to use detached frame',
  'execution context was destroyed',
  'frame was detached',
  'navigating frame was detached',
  'cannot find context with specified id',
];

export function isTransientPuppeteerContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return TRANSIENT_PUPPETEER_CONTEXT_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern));
}
