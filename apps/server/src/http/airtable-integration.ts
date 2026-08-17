import {
  airtableActivationInputSchema,
  airtableIntegrationViewSchema,
  airtableSelectableBaseSchema,
  airtableSharingChangeSchema,
  type AirtableIntegrationView
} from '@jooevents/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

export type AirtableIntegrationAction = 'read' | 'connect' | 'configure' | 'control';

export interface AirtableIntegrationHttpRuntime {
  authorize(input: Readonly<{
    request: Request;
    action: AirtableIntegrationAction;
  }>): Promise<'authorized' | 'unauthenticated' | 'forbidden'>;
  read(): Promise<AirtableIntegrationView>;
  startOAuth(): Promise<Readonly<{ authorizationUrl: string }>>;
  completeOAuth(input: Readonly<{ code: string; state: string }>): Promise<Readonly<{
    redirectTo: string;
  }>>;
  listBases(): Promise<readonly Readonly<{
    id: string;
    name: string;
    permissionLevel: 'none' | 'read' | 'comment' | 'edit' | 'create';
  }>[]>;
  activate(input: z.infer<typeof airtableActivationInputSchema>): Promise<AirtableIntegrationView>;
  setSharing(input: z.infer<typeof airtableSharingChangeSchema>): Promise<AirtableIntegrationView>;
  syncNow(): Promise<AirtableIntegrationView>;
  setPaused(paused: boolean): Promise<AirtableIntegrationView>;
  revertHistory(id: string): Promise<AirtableIntegrationView>;
  disconnect(): Promise<AirtableIntegrationView>;
}

async function body(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try { return await context.req.json(); } catch { return undefined; }
}

/** Protocol-only Airtable setup/control routes; runtime methods own policy and state. */
export function createAirtableIntegrationHttpAdapter(runtime: AirtableIntegrationHttpRuntime) {
  const app = new Hono();
  const authorize = async (
    context: { req: { raw: Request } },
    action: AirtableIntegrationAction
  ): Promise<Response | undefined> => {
    const result = await runtime.authorize({ request: context.req.raw, action });
    if (result === 'authorized') return undefined;
    return Response.json({ code: result }, { status: result === 'unauthenticated' ? 401 : 403 });
  };

  app.get('/api/integrations/airtable', async (context) => {
    const denied = await authorize(context, 'read');
    if (denied) return denied;
    return context.json(airtableIntegrationViewSchema.parse(await runtime.read()));
  });
  app.post('/api/integrations/airtable/oauth/start', async (context) => {
    const denied = await authorize(context, 'connect');
    if (denied) return denied;
    const started = await runtime.startOAuth();
    return context.json(z.object({ authorizationUrl: z.url() }).parse(started));
  });
  app.get('/api/integrations/airtable/oauth/callback', async (context) => {
    const parsed = z.object({
      code: z.string().min(1).max(8_192),
      state: z.string().min(32).max(256)
    }).safeParse(context.req.query());
    if (!parsed.success) return context.json({ code: 'oauth_callback_invalid' }, 400);
    const completed = await runtime.completeOAuth(parsed.data);
    if (!/^\/app\/integrations\/airtable(?:\?[^#]*)?$/u.test(completed.redirectTo)) {
      throw new TypeError('airtable_oauth_redirect_invalid');
    }
    return context.redirect(completed.redirectTo, 303);
  });
  app.get('/api/integrations/airtable/bases', async (context) => {
    const denied = await authorize(context, 'configure');
    if (denied) return denied;
    return context.json({ bases: z.array(airtableSelectableBaseSchema).max(1_000).parse(await runtime.listBases()) });
  });
  app.post('/api/integrations/airtable/activate', async (context) => {
    const denied = await authorize(context, 'configure');
    if (denied) return denied;
    const parsed = airtableActivationInputSchema.safeParse(await body(context));
    if (!parsed.success) return context.json({ code: 'invalid_request' }, 400);
    return context.json(airtableIntegrationViewSchema.parse(await runtime.activate(parsed.data)));
  });
  app.post('/api/integrations/airtable/sharing', async (context) => {
    const denied = await authorize(context, 'configure');
    if (denied) return denied;
    const parsed = airtableSharingChangeSchema.safeParse(await body(context));
    if (!parsed.success) return context.json({ code: 'invalid_request' }, 400);
    return context.json(airtableIntegrationViewSchema.parse(await runtime.setSharing(parsed.data)));
  });
  app.post('/api/integrations/airtable/sync', async (context) => {
    const denied = await authorize(context, 'control');
    if (denied) return denied;
    return context.json(airtableIntegrationViewSchema.parse(await runtime.syncNow()));
  });
  app.post('/api/integrations/airtable/pause', async (context) => {
    const denied = await authorize(context, 'control');
    if (denied) return denied;
    const parsed = z.strictObject({ paused: z.boolean() }).safeParse(await body(context));
    if (!parsed.success) return context.json({ code: 'invalid_request' }, 400);
    return context.json(airtableIntegrationViewSchema.parse(await runtime.setPaused(parsed.data.paused)));
  });
  app.post('/api/integrations/airtable/history/revert', async (context) => {
    const denied = await authorize(context, 'control');
    if (denied) return denied;
    const parsed = z.strictObject({ id: z.string().min(1).max(160) }).safeParse(await body(context));
    if (!parsed.success) return context.json({ code: 'invalid_request' }, 400);
    return context.json(airtableIntegrationViewSchema.parse(await runtime.revertHistory(parsed.data.id)));
  });
  app.post('/api/integrations/airtable/disconnect', async (context) => {
    const denied = await authorize(context, 'control');
    if (denied) return denied;
    return context.json(airtableIntegrationViewSchema.parse(await runtime.disconnect()));
  });
  return app;
}
