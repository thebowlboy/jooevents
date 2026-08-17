import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import { parseContractVersion, type WorkspaceId } from '@jooevents/kernel';

export const ACCELEVENTS_EXPORT_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program.export.accelevents', version: parseContractVersion(1)
});
export const ACCELEVENTS_EXPORT_CONFIG_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.program.export.accelevents-config', version: parseContractVersion(1)
});

export const ACCELEVENTS_EXPORT_VIEW_PATH = '/api/events/current/integrations/accelevents';
export const ACCELEVENTS_EXPORT_CONFIG_PATH = '/api/events/current/integrations/accelevents/configuration';
export const ACCELEVENTS_EXPORT_LOCATIONS_PREPARE_PATH = '/api/events/current/integrations/accelevents/locations/prepare';
export const ACCELEVENTS_EXPORT_PACKAGE_PREPARE_PATH = '/api/events/current/integrations/accelevents/package/prepare';
export const ACCELEVENTS_EXPORT_LOCATIONS_DOWNLOAD_PATH = '/api/events/current/integrations/accelevents/locations.csv';
export const ACCELEVENTS_EXPORT_PACKAGE_DOWNLOAD_PATH = '/api/events/current/integrations/accelevents/package.zip';

export interface AcceleventsExportCurrentEventSource {
  resolveCurrentEvent(workspaceId: WorkspaceId):
    | { readonly eventId?: string; readonly evidenceIds: readonly string[] }
    | Promise<{ readonly eventId?: string; readonly evidenceIds: readonly string[] }>;
}
