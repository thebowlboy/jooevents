import { z } from 'zod';
import { engagementIdInputSchema } from './engagements';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema
} from './operations';
import { portalEngagementSchema, portalSnapshotSchema } from './participant-portal';

/**
 * Wire contracts for the participant-lane (`participant_http`) operations: the
 * portal snapshot read and the engagement response act.
 *
 * The respond input is deliberately narrow. Attribution (`self` versus
 * `co_speaker`) is never a wire field: the server resolves it from the
 * authenticated participant against each engaged person, so no request body
 * can assert whose act a confirmation records. The strict shape refuses any
 * attempt to smuggle an attribution, person, or version claim.
 */

export const portalSnapshotReadInputSchema = z.strictObject({});

export const portalSnapshotReadResultSchema = createReadOperationResultSchema(portalSnapshotSchema);

export const portalEngagementResponseSchema = z.enum(['confirm', 'decline']);

export const portalEngagementRespondInputSchema = z.strictObject({
  engagementId: engagementIdInputSchema,
  response: portalEngagementResponseSchema
});

/**
 * A successful response answers with the acting participant's refreshed
 * engagement projection — the same shape the snapshot serves.
 */
export const portalEngagementRespondResultSchema =
  createEffectfulOperationResultSchema(portalEngagementSchema);

export const PARTICIPANT_PORTAL_OPERATION_SCHEMA_REFS = Object.freeze({
  snapshotRead: createOperationSchemaManifestRefs({
    inputKey: 'schema.portal.snapshot-read.input',
    inputSchema: portalSnapshotReadInputSchema,
    resultKey: 'schema.portal.snapshot-read.participant-result',
    resultSchema: portalSnapshotReadResultSchema
  }),
  engagementRespond: createOperationSchemaManifestRefs({
    inputKey: 'schema.portal.engagement-respond.input',
    inputSchema: portalEngagementRespondInputSchema,
    resultKey: 'schema.portal.engagement-respond.participant-result',
    resultSchema: portalEngagementRespondResultSchema
  })
});

export type PortalSnapshotReadInput = z.infer<typeof portalSnapshotReadInputSchema>;
export type PortalEngagementResponse = z.infer<typeof portalEngagementResponseSchema>;
export type PortalEngagementRespondInput = z.infer<typeof portalEngagementRespondInputSchema>;
