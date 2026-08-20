import { z } from 'zod';

// Recorded-flow document schema v1. See
// docs/plans/2026-07-08-site-hints-knowledge-base-plan.md ("Flow document
// format v1"). Kept deliberately small: every field added here is a field a
// future auto-recorder must learn to emit.

export const flowTargetQuerySchema = z
  .object({
    tag: z.string().optional(),
    attrs: z.record(z.string()).optional(),
    textIncludes: z.string().optional(),
    valueStartsWith: z.string().optional(),
  })
  .strict();

const stepCommon = {
  optional: z.boolean().optional(),
  reobserve: z.boolean().optional(),
  waitMs: z.number().int().min(0).max(60000).optional(),
  healMaxSteps: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).optional(),
};

export const flowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), target: flowTargetQuerySchema, ...stepCommon }).strict(),
  z
    .object({
      action: z.literal('fill'),
      target: flowTargetQuerySchema,
      value: z.string(),
      ...stepCommon,
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      target: flowTargetQuerySchema,
      value: z.string(),
      ...stepCommon,
    })
    .strict(),
  z
    .object({
      action: z.literal('select'),
      target: flowTargetQuerySchema,
      value: z.string(),
      ...stepCommon,
    })
    .strict(),
  z.object({ action: z.literal('press'), keys: z.string(), ...stepCommon }).strict(),
  z
    .object({
      action: z.literal('agent'),
      goal: z.string(),
      maxSteps: z.number().int().min(1).max(40).optional(),
      ...stepCommon,
    })
    .strict(),
]);

export const flowVerifySchema = z
  .object({
    urlIncludes: z.string().optional(),
    textIncludes: z.array(z.string()).optional(),
    requiredTargets: z.array(flowTargetQuerySchema).optional(),
    requiredValues: z.array(flowTargetQuerySchema).optional(),
    $comment: z.string().optional(),
  })
  .strict();

export const flowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    id: z.string().min(1),
    version: z.number().int().min(1).optional(),
    status: z.enum(['enabled', 'needs_rerecord', 'disabled']).optional(),
    host: z.string().optional(),
    taskClass: z.string().optional(),
    description: z.string().optional(),
    entry: z
      .object({
        url: z.string().min(1),
        precondition: z
          .object({ textIncludes: z.array(z.string()) })
          .strict()
          .optional(),
      })
      .strict(),
    variables: z.record(z.string()).default({}),
    steps: z.array(flowStepSchema).min(1),
    verify: flowVerifySchema,
    recordedAt: z.string().optional(),
    recordedFrom: z.array(z.string()).optional(),
    $comment: z.string().optional(),
  })
  .strict();

export type MagicBrowseFlowTargetQuery = z.infer<typeof flowTargetQuerySchema>;
export type MagicBrowseFlowStep = z.infer<typeof flowStepSchema>;
export type MagicBrowseFlowDefinition = z.infer<typeof flowDefinitionSchema>;

/**
 * Parse an untrusted flow document. Accepts the bench prototype shape
 * (top-level `url` + `scenarioId`) and normalizes it to the v1 schema.
 */
export function parseFlowDefinition(raw: unknown): MagicBrowseFlowDefinition {
  if (raw && typeof raw === 'object') {
    const value = raw as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...value };
    if (normalized.id === undefined && typeof normalized.scenarioId === 'string') {
      normalized.id = normalized.scenarioId;
    }
    delete normalized.scenarioId;
    if (normalized.entry === undefined && typeof normalized.url === 'string') {
      normalized.entry = { url: normalized.url };
    }
    delete normalized.url;
    return flowDefinitionSchema.parse(normalized);
  }
  return flowDefinitionSchema.parse(raw);
}
