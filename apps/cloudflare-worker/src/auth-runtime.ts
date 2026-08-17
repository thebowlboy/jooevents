import { createProvisioningService } from '@jooevents/application';
import { createCloudflareAuthHttpApp } from './auth-http';
import { createD1Auth } from './d1-auth';
import { createD1AuthPrincipalReader } from './d1-principal-reader';
import { createD1ProvisioningStore } from './d1-provisioning-store';
import {
  loadCloudflareAuthRuntimeConfiguration,
  type CloudflareAuthBindings
} from './auth-config';

export type CloudflareAuthEnvironment = CloudflareAuthBindings & { readonly DB: D1Database };

/** Builds the request-local auth runtime only after every deployment duty validates. */
export function createConfiguredCloudflareAuthRuntime(environment: CloudflareAuthEnvironment) {
  const config = loadCloudflareAuthRuntimeConfiguration(environment);
  const auth = createD1Auth(environment.DB, config);
  return config.keys.withWorkspaceInvitationLookupKeys((workspaceInvitationLookupKeyBytes) =>
    createCloudflareAuthHttpApp({
      auth,
      baseUrl: config.baseUrl,
      workspaceId: config.workspaceId,
      accessContext: createProvisioningService({
        principals: createD1AuthPrincipalReader(environment.DB, {
          issuerOrigin: new URL(config.baseUrl).origin
        }),
        store: createD1ProvisioningStore(environment.DB, {
          workspaceInvitationLookupKeyBytes
        }),
        admission: {
          mode: config.admissionMode,
          ...(config.googleHostedDomain ? { hostedDomain: config.googleHostedDomain } : {})
        }
      })
    })
  );
}
