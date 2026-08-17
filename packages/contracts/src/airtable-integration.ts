import { z } from 'zod';

export const airtableIntegrationAreaKeySchema = z.enum([
  'people', 'submissions', 'sessions', 'schedule', 'tasks'
]);
export type AirtableIntegrationAreaKey = z.infer<typeof airtableIntegrationAreaKeySchema>;

export const airtableAreaDirectionSchema = z.enum([
  'not_connected', 'keep_airtable_updated', 'work_from_airtable'
]);
export type AirtableAreaDirection = z.infer<typeof airtableAreaDirectionSchema>;

export const airtableIntegrationViewSchema = z.object({
  state: z.enum([
    'not_connected', 'provisioning', 'current', 'pending', 'needs_review',
    'delayed', 'catching_up', 'paused', 'needs_reconnect'
  ]),
  setupStage: z.enum(['choose_base', 'adding_tables']).optional(),
  baseName: z.string().min(1).max(160).optional(),
  baseUrl: z.url().optional(),
  accountLabel: z.string().min(1).max(400).optional(),
  lastOutbound: z.string().min(1).max(160).optional(),
  lastInbound: z.string().min(1).max(160).optional(),
  lastFullCheck: z.string().min(1).max(160).optional(),
  lastFullCheckSummary: z.string().min(1).max(500).optional(),
  supportCode: z.string().min(1).max(160).optional(),
  areas: z.array(z.object({
    key: airtableIntegrationAreaKeySchema,
    label: z.string().min(1).max(160),
    direction: airtableAreaDirectionSchema,
    sharedFields: z.number().int().nonnegative().max(1_000),
    editableFields: z.number().int().nonnegative().max(1_000),
    requestFields: z.number().int().nonnegative().max(1_000)
  })).max(20),
  attention: z.array(z.object({
    id: z.string().min(1).max(160),
    kind: z.enum(['conflict', 'request', 'reconnect']),
    title: z.string().min(1).max(500),
    href: z.string().startsWith('/app/').max(2_048),
    actionLabel: z.string().min(1).max(80)
  })).max(200),
  history: z.array(z.object({
    id: z.string().min(1).max(160),
    kind: z.enum(['applied', 'refused', 'sharing', 'connection']),
    summary: z.string().min(1).max(1_000),
    occurredAt: z.iso.datetime({ offset: true }),
    actorLabel: z.string().min(1).max(320).optional(),
    before: z.string().max(2_000).optional(),
    after: z.string().max(2_000).optional(),
    revertLabel: z.string().min(1).max(500).optional()
  })).max(200)
});
export type AirtableIntegrationView = z.infer<typeof airtableIntegrationViewSchema>;

export const airtableSelectableBaseSchema = z.object({
  id: z.string().min(3).max(128),
  name: z.string().min(1).max(160),
  permissionLevel: z.enum(['none', 'read', 'comment', 'edit', 'create'])
});
export type AirtableSelectableBase = z.infer<typeof airtableSelectableBaseSchema>;

export const airtableSharingChangeSchema = z.strictObject({
  areaKey: airtableIntegrationAreaKeySchema,
  direction: airtableAreaDirectionSchema
});

export const airtableActivationInputSchema = z.strictObject({
  baseId: z.string().min(3).max(128),
  directions: z.array(airtableSharingChangeSchema).min(1).max(20)
}).superRefine((value, context) => {
  if (new Set(value.directions.map((item) => item.areaKey)).size !== value.directions.length) {
    context.addIssue({ code: 'custom', message: 'airtable_direction_duplicate' });
  }
});
export type AirtableActivationInput = z.infer<typeof airtableActivationInputSchema>;
