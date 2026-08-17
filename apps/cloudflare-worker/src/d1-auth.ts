import {
  createJooEventsAuth,
  type JooEventsAuthConfiguration,
  type WorkspaceMagicLinkComposition
} from '@jooevents/auth';
import { BETTER_AUTH_SCHEMA } from '@jooevents/persistence/better-auth-schema-definition';
import { drizzle } from 'drizzle-orm/d1';

/** Composes the shared auth policy with Cloudflare's D1 Drizzle driver. */
export function createD1Auth(
  database: D1Database,
  config: JooEventsAuthConfiguration,
  options?: { readonly magicLink?: WorkspaceMagicLinkComposition }
) {
  const orm = drizzle(database, { schema: BETTER_AUTH_SCHEMA });
  return createJooEventsAuth(config, orm, options);
}

export type D1JooEventsAuth = ReturnType<typeof createD1Auth>;
