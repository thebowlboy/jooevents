import { z } from 'zod';
import {
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from './operations';
import {
  eventDateSchema,
  eventIdSchema,
  eventNameSchema,
  eventTimezoneSchema
} from './event';

export const workspaceShellEventSummarySchema = z.strictObject({
  id: eventIdSchema,
  name: eventNameSchema,
  timezone: eventTimezoneSchema,
  startDate: eventDateSchema,
  endDate: eventDateSchema
}).refine((event) => event.endDate >= event.startDate, {
  path: ['endDate'],
  message: 'end date must not precede start date'
});

export const workspaceShellSummaryProjectionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspace: z.strictObject({
    id: z.uuid(),
    name: z.string().min(1).max(200).refine((value) => value.trim() === value)
  }),
  event: workspaceShellEventSummarySchema.nullable()
});

/** Current workspace and authority are resolved from verified invocation evidence. */
export const workspaceShellSummaryReadInputSchema = z.strictObject({});

export const workspaceShellSummaryCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: workspaceShellSummaryProjectionSchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const workspaceShellSummaryReadResultSchema =
  createReadOperationResultSchema(workspaceShellSummaryProjectionSchema);

export const WORKSPACE_SHELL_SUMMARY_OPERATION_SCHEMA_REFS = Object.freeze({
  read: createOperationSchemaManifestRefs({
    inputKey: 'schema.workspace.shell.summary.read.input',
    inputSchema: workspaceShellSummaryReadInputSchema,
    resultKey: 'schema.workspace.shell.summary.read.operator-result',
    resultSchema: workspaceShellSummaryReadResultSchema
  })
});

export type WorkspaceShellEventSummary = z.infer<typeof workspaceShellEventSummarySchema>;
export type WorkspaceShellSummaryProjection = z.infer<
  typeof workspaceShellSummaryProjectionSchema
>;
export type WorkspaceShellSummaryReadInput = z.infer<typeof workspaceShellSummaryReadInputSchema>;
export type WorkspaceShellSummaryCanonicalResult = z.infer<
  typeof workspaceShellSummaryCanonicalResultSchema
>;
export type WorkspaceShellSummaryReadResult = z.infer<
  typeof workspaceShellSummaryReadResultSchema
>;
