import { z } from 'zod';
import { programVocabularyIdSchema, programVocabularyScopeSchema } from './program-vocabulary';

export const scheduleBreakIdSchema = programVocabularyIdSchema;
export const scheduleBreakVersionSchema = z.number().int().positive().safe();
export const scheduleBreakScopeSchema = programVocabularyScopeSchema;
export const scheduleBreakLabelSchema = z.string().min(1).max(80).refine(
  (value) => value === value.trim(),
  'break label must use its canonical trimmed form'
);
export const scheduleBreakDayKeySchema = z.iso.date();
export const scheduleBreakMinuteSchema = z.number().int().min(0).max(1_440);
export const scheduleBreakStatusSchema = z.enum(['active', 'removed']);

export const scheduleBreakHeadSchema = z.strictObject({
  id: scheduleBreakIdSchema,
  label: scheduleBreakLabelSchema,
  dayKey: scheduleBreakDayKeySchema,
  roomId: scheduleBreakIdSchema,
  startMin: scheduleBreakMinuteSchema,
  endMin: scheduleBreakMinuteSchema,
  status: scheduleBreakStatusSchema,
  version: scheduleBreakVersionSchema
}).refine((head) => head.startMin < head.endMin, {
  path: ['endMin'],
  message: 'break end must follow its start'
});

export const scheduleBreakActiveHeadSchema = scheduleBreakHeadSchema.refine(
  (head) => head.status === 'active',
  { path: ['status'], message: 'snapshot breaks must be active' }
);

const expectedBreakSchema = z.strictObject({
  id: scheduleBreakIdSchema,
  expectedVersion: scheduleBreakVersionSchema
});

const breakIntervalFields = {
  expectedScheduleVersion: scheduleBreakVersionSchema,
  label: scheduleBreakLabelSchema,
  dayKey: scheduleBreakDayKeySchema,
  startMin: scheduleBreakMinuteSchema,
  endMin: scheduleBreakMinuteSchema
} as const;

export const scheduleBreakAuthorInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('break_add'),
    ...breakIntervalFields,
    roomIds: z.array(scheduleBreakIdSchema).min(1).max(100)
  }),
  z.strictObject({
    action: z.literal('break_remove'),
    expectedScheduleVersion: scheduleBreakVersionSchema,
    breaks: z.array(expectedBreakSchema).min(1).max(100)
  }),
  z.strictObject({
    action: z.literal('break_restore'),
    expectedScheduleVersion: scheduleBreakVersionSchema,
    breaks: z.array(expectedBreakSchema).min(1).max(100)
  })
]).superRefine((input, context) => {
  if (input.action === 'break_add') {
    if (input.startMin >= input.endMin) {
      context.addIssue({ code: 'custom', path: ['endMin'], message: 'break end must follow its start' });
    }
    unique(input.roomIds, context, ['roomIds'], 'room ids must be unique');
  } else {
    unique(input.breaks.map((entry) => entry.id), context, ['breaks'], 'break ids must be unique');
  }
});

export const scheduleBreakPlanningInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('break_add'),
    scope: scheduleBreakScopeSchema,
    ...breakIntervalFields,
    breaks: z.array(z.strictObject({
      id: scheduleBreakIdSchema,
      roomId: scheduleBreakIdSchema
    })).min(1).max(100)
  }),
  z.strictObject({
    action: z.literal('break_remove'),
    scope: scheduleBreakScopeSchema,
    expectedScheduleVersion: scheduleBreakVersionSchema,
    breaks: z.array(expectedBreakSchema).min(1).max(100)
  }),
  z.strictObject({
    action: z.literal('break_restore'),
    scope: scheduleBreakScopeSchema,
    expectedScheduleVersion: scheduleBreakVersionSchema,
    breaks: z.array(expectedBreakSchema).min(1).max(100)
  })
]).superRefine((input, context) => {
  if (input.action === 'break_add') {
    if (input.startMin >= input.endMin) {
      context.addIssue({ code: 'custom', path: ['endMin'], message: 'break end must follow its start' });
    }
    unique(input.breaks.map((entry) => entry.id), context, ['breaks'], 'break ids must be unique');
    unique(input.breaks.map((entry) => entry.roomId), context, ['breaks'], 'room ids must be unique');
  } else {
    unique(input.breaks.map((entry) => entry.id), context, ['breaks'], 'break ids must be unique');
  }
});

export const scheduleBreakPlanSchema = z.strictObject({
  input: scheduleBreakPlanningInputSchema,
  before: z.array(scheduleBreakHeadSchema).max(100),
  after: z.array(scheduleBreakHeadSchema).max(100),
  scheduleVersion: z.strictObject({
    before: scheduleBreakVersionSchema,
    after: scheduleBreakVersionSchema
  }),
  vocabularySetVersion: scheduleBreakVersionSchema,
  eventGuard: z.strictObject({
    version: scheduleBreakVersionSchema,
    startDate: scheduleBreakDayKeySchema,
    endDate: scheduleBreakDayKeySchema
  })
}).superRefine((plan, context) => {
  if (plan.scheduleVersion.after !== plan.scheduleVersion.before + 1) {
    context.addIssue({ code: 'custom', path: ['scheduleVersion', 'after'], message: 'schedule version must advance once' });
  }
  if (plan.eventGuard.startDate > plan.eventGuard.endDate) {
    context.addIssue({ code: 'custom', path: ['eventGuard', 'endDate'], message: 'event end date must follow its start' });
  }
  const action = plan.input.action;
  const coherent = action === 'break_add'
    ? plan.before.length === 0 && plan.after.length === plan.input.breaks.length
    : plan.before.length === plan.input.breaks.length && plan.after.length === plan.before.length;
  if (!coherent) context.addIssue({ code: 'custom', message: 'break plan images must match its action' });
  if (action === 'break_remove' && plan.after.some((head) => head.status !== 'removed')) {
    context.addIssue({ code: 'custom', path: ['after'], message: 'removed break images must be removed' });
  }
  if ((action === 'break_add' || action === 'break_restore')
      && plan.after.some((head) => head.status !== 'active')) {
    context.addIssue({ code: 'custom', path: ['after'], message: 'active break images must be active' });
  }
});

export const scheduleBreakResultSchema = z.strictObject({
  action: z.enum(['break_add', 'break_remove', 'break_restore']),
  scheduleVersion: scheduleBreakVersionSchema,
  breaks: z.array(scheduleBreakHeadSchema).min(1).max(100)
});

function unique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string
): void {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path, message });
}

export type ScheduleBreakHeadDto = z.infer<typeof scheduleBreakHeadSchema>;
export type ScheduleBreakAuthorInput = z.infer<typeof scheduleBreakAuthorInputSchema>;
export type ScheduleBreakPlanningInput = z.infer<typeof scheduleBreakPlanningInputSchema>;
export type ScheduleBreakPlanDto = z.infer<typeof scheduleBreakPlanSchema>;
export type ScheduleBreakResult = z.infer<typeof scheduleBreakResultSchema>;
