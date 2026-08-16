import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import { parseContractVersion, type WorkspaceId } from '@jooevents/kernel';

export const RELEASE_CHANGE_DRAFT_OPERATION = Object.freeze({
  name: 'release.change.draft', version: 1
});
export const RELEASE_CHANGE_DRAFT_PATH = '/api/events/current/releases/drafts';
export const RELEASE_DRAFT_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.release.draft', version: parseContractVersion(1)
});
export const RELEASE_DRAFT_PERMISSION_ID = 'publication.manage' as const;

export interface ReleaseCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    | { readonly eventId?: string; readonly evidenceIds: readonly string[] }
    | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}
