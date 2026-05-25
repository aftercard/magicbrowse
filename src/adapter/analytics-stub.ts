// Stub for nanobrowser's `services/analytics`. The chrome extension reports
// task usage to PostHog/etc; the CLI/library doesn't and shouldn't.

const noop = (..._args: unknown[]): void => {};

export const analytics = {
  trackTaskStart: noop,
  trackTaskComplete: noop,
  trackTaskFailed: noop,
  trackTaskCancelled: noop,
  trackDomainVisit: noop,
  trackError: noop,
  categorizeError: (_err: unknown): string => 'unknown',
};
