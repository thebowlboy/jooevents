import { z } from 'zod';
import { gatewayAuthorityProjectionSchema } from './gateway-authority';

export const safeUserSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  primaryEmail: z.email().optional(),
  avatarAssetId: z.string().optional()
});

export const safeMembershipSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  status: z.enum(['invited', 'pending_review', 'active', 'suspended', 'deactivated']),
  version: z.number().int().nonnegative()
});

export const safeWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1)
});

export const accessContextSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('anonymous') }),
  z.strictObject({
    state: z.literal('provisioning'),
    retryAfterSeconds: z.number().int().positive(),
    correlationId: z.string().min(1)
  }),
  z.strictObject({
    state: z.literal('pending_review'),
    user: safeUserSchema,
    membership: safeMembershipSchema.extend({ status: z.literal('pending_review') }),
    workspace: safeWorkspaceSchema
  }),
  z.strictObject({
    state: z.literal('active'),
    user: safeUserSchema,
    workspace: safeWorkspaceSchema,
    // Deployments without configured gateway key profiles omit this projection.
    // Browser persistence treats absence as unavailable and never derives a fallback.
    gatewayAuthority: gatewayAuthorityProjectionSchema.optional()
  }),
  z.strictObject({
    state: z.literal('blocked'),
    code: z.enum(['suspended', 'deactivated', 'not_admitted'])
  })
]);

export type SafeUser = z.infer<typeof safeUserSchema>;
export type SafeMembership = z.infer<typeof safeMembershipSchema>;
export type SafeWorkspace = z.infer<typeof safeWorkspaceSchema>;
export type AccessContext = z.infer<typeof accessContextSchema>;

export const accessScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('event'), eventId: z.string().min(1) })
]);

export const createAccessReservationSchema = z.object({
  workspaceId: z.string().min(1),
  email: z.email(),
  expiresAt: z.iso.datetime().optional(),
  roleAssignments: z.array(z.object({ roleId: z.string().min(1), scope: accessScopeSchema })),
  permissionOverrides: z.array(z.object({
    permissionId: z.string().min(1),
    effect: z.enum(['grant', 'deny']),
    scope: accessScopeSchema,
    reason: z.string().trim().min(1).max(500)
  })).default([])
});

export const decideMembershipSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  decisionNote: z.string().trim().max(1000).optional(),
  roleAssignments: z.array(z.object({ roleId: z.string().min(1), scope: accessScopeSchema })).default([]),
  permissionOverrides: z.array(z.object({
    permissionId: z.string().min(1),
    effect: z.enum(['grant', 'deny']),
    scope: accessScopeSchema,
    reason: z.string().trim().min(1).max(500)
  })).default([])
});

export const suspendMembershipSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000)
});

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  correlationId: z.string().min(1),
  retryable: z.boolean()
});
