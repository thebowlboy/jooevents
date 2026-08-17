import {
  WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS,
  createJooEventsAuth,
  type WorkspaceMagicLinkComposition
} from '@jooevents/auth';
import type { SQLiteBetterAuthDatabase } from '@jooevents/persistence';
import type { ServerConfig } from '../config';

export { WORKSPACE_SIGN_IN_LINK_EXPIRES_IN_SECONDS };
export type { WorkspaceMagicLinkComposition };

/** The reviewed Better Auth composition. Domain admission remains outside this object. */
export function createAuth(
  config: ServerConfig,
  database: SQLiteBetterAuthDatabase,
  options?: { readonly magicLink?: WorkspaceMagicLinkComposition }
) {
  return createJooEventsAuth(config, database, options);
}

export type JooEventsAuth = ReturnType<typeof createAuth>;
