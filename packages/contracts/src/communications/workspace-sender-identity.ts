import { parseInstant } from '@jooevents/kernel';
import { z } from 'zod';
import {
  createEffectfulOperationResultSchema,
  createOperationSchemaManifestRefs,
  createReadOperationResultSchema,
  structuredOutcomeSchema
} from '../operations';
import { providerOpaqueIdSchema, providerPositiveVersionSchema } from './provider';

/**
 * Workspace-editable outbound sender presentation: display name and reply-to
 * only. The from-address stays per-installation configuration — moving it per
 * workspace breaks SPF/DKIM alignment — so it appears here as read-only
 * effective context and can never be written.
 *
 * Update input is deliberately permissive-but-bounded rather than shape-strict:
 * the header-safety rules are a security decision the operation states as a
 * structured refusal with a code the surface can render, never a transport
 * parse error that says only "invalid request".
 */

const instantSchema = z.string().refine((value) => {
  try { return parseInstant(value) === value; } catch { return false; }
}, { message: 'Expected a canonical UTC instant.' });

/** Bounds the wire value only; header acceptance is the operation's structured refusal. */
const submittedTextSchema = z.string().max(1_024);

export const workspaceSenderDisplayNameSchema = z.string().min(1).max(200);
export const workspaceSenderReplyToAddressSchema = z.string().min(3).max(320);

export const workspaceSenderIdentitySourceSchema = z.enum(['installation', 'workspace']);

/** The presentation the next send will compose, from-address included. */
export const workspaceSenderIdentityEffectiveSchema = z.strictObject({
  fromAddress: z.string().min(3).max(320),
  fromDisplayName: workspaceSenderDisplayNameSchema.nullable(),
  replyToAddress: workspaceSenderReplyToAddressSchema.nullable(),
  source: workspaceSenderIdentitySourceSchema
});

export const workspaceSenderIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: providerOpaqueIdSchema,
  /** Starts at 1 for a never-edited workspace and advances once per committed update. */
  headVersion: providerPositiveVersionSchema,
  displayName: workspaceSenderDisplayNameSchema.nullable(),
  replyToAddress: workspaceSenderReplyToAddressSchema.nullable(),
  effective: workspaceSenderIdentityEffectiveSchema,
  updatedAt: instantSchema.nullable()
}).superRefine((identity, context) => {
  if (identity.headVersion === 1 && identity.updatedAt !== null) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'an unedited sender identity carries no update instant'
    });
  }
  if (identity.displayName !== null
      && identity.effective.fromDisplayName !== identity.displayName) {
    context.addIssue({
      code: 'custom',
      path: ['effective', 'fromDisplayName'],
      message: 'a set workspace display name is the effective display name'
    });
  }
  if (identity.replyToAddress !== null
      && identity.effective.replyToAddress !== identity.replyToAddress) {
    context.addIssue({
      code: 'custom',
      path: ['effective', 'replyToAddress'],
      message: 'a set workspace reply-to is the effective reply-to'
    });
  }
  const overridden = identity.displayName !== null || identity.replyToAddress !== null;
  if ((identity.effective.source === 'workspace') !== overridden) {
    context.addIssue({
      code: 'custom',
      path: ['effective', 'source'],
      message: 'the effective source must name where the presentation came from'
    });
  }
});

export const workspaceSenderIdentityReadInputSchema = z.strictObject({});

/** `null` clears a field back to the installation value; a string proposes one. */
export const workspaceSenderIdentityUpdateInputSchema = z.strictObject({
  expectedHeadVersion: providerPositiveVersionSchema,
  displayName: submittedTextSchema.nullable(),
  replyToAddress: submittedTextSchema.nullable()
});

export const WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES = [
  'display_name_empty',
  'display_name_too_long',
  'display_name_control_character',
  'display_name_bidi_or_zero_width',
  'display_name_unpaired_surrogate',
  'display_name_address_syntax',
  'reply_to_empty',
  'reply_to_too_long',
  'reply_to_control_character',
  'reply_to_bidi_or_zero_width',
  'reply_to_multiple_addresses',
  'reply_to_not_one_address'
] as const;

export const workspaceSenderIdentityRefusalDetailSchema = z.strictObject({
  field: z.enum(['display_name', 'reply_to_address']),
  code: z.enum(WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES)
}).superRefine((detail, context) => {
  const expected = detail.field === 'display_name' ? 'display_name_' : 'reply_to_';
  if (!detail.code.startsWith(expected)) {
    context.addIssue({
      code: 'custom',
      path: ['code'],
      message: 'the refusal code must name the field it refused'
    });
  }
});

export const workspaceSenderIdentityStaleDetailSchema = z.strictObject({
  code: z.literal('head_version_changed'),
  headVersion: providerPositiveVersionSchema
});

export const workspaceSenderIdentityCanonicalResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), data: workspaceSenderIdentitySchema }),
  z.strictObject({ kind: z.literal('outcome'), outcome: structuredOutcomeSchema })
]);

export const workspaceSenderIdentityReadResultSchema =
  createReadOperationResultSchema(workspaceSenderIdentitySchema);
export const workspaceSenderIdentityUpdateResultSchema =
  createEffectfulOperationResultSchema(workspaceSenderIdentitySchema);

export const WORKSPACE_SENDER_IDENTITY_OPERATION_SCHEMA_REFS = Object.freeze({
  read: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.sender-identity.read.input',
    inputSchema: workspaceSenderIdentityReadInputSchema,
    resultKey: 'schema.communication.sender-identity.read.operator-result',
    resultSchema: workspaceSenderIdentityReadResultSchema
  }),
  update: createOperationSchemaManifestRefs({
    inputKey: 'schema.communication.sender-identity.update.input',
    inputSchema: workspaceSenderIdentityUpdateInputSchema,
    resultKey: 'schema.communication.sender-identity.update.operator-result',
    resultSchema: workspaceSenderIdentityUpdateResultSchema
  })
});

export type WorkspaceSenderIdentityDto = z.infer<typeof workspaceSenderIdentitySchema>;
export type WorkspaceSenderIdentityEffective = z.infer<
  typeof workspaceSenderIdentityEffectiveSchema
>;
export type WorkspaceSenderIdentityReadInput = z.infer<
  typeof workspaceSenderIdentityReadInputSchema
>;
export type WorkspaceSenderIdentityUpdateInput = z.infer<
  typeof workspaceSenderIdentityUpdateInputSchema
>;
export type WorkspaceSenderIdentityRefusalDetail = z.infer<
  typeof workspaceSenderIdentityRefusalDetailSchema
>;
export type WorkspaceSenderIdentityRefusalCode =
  (typeof WORKSPACE_SENDER_IDENTITY_REFUSAL_CODES)[number];
export type WorkspaceSenderIdentityReadResult = z.infer<
  typeof workspaceSenderIdentityReadResultSchema
>;
export type WorkspaceSenderIdentityUpdateResult = z.infer<
  typeof workspaceSenderIdentityUpdateResultSchema
>;
