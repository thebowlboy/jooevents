import { z } from 'zod';

export const createAccountLinkIntentSchema = z.object({
  provider: z.literal('google'),
  email: z.email()
});

export const accountLinkIntentAcceptedSchema = z.object({
  accepted: z.literal(true),
  message: z.string()
});

export const confirmAccountLinkEmailSchema = z.object({ token: z.string().min(32).max(512) });

export const accountLinkStatusSchema = z.object({
  id: z.string().min(1),
  state: z.enum([
    'email_confirmation_pending',
    'existing_session_required',
    'google_ceremony_required',
    'ready_to_link',
    'linked',
    'expired',
    'cancelled',
    'failed'
  ]),
  expiresAt: z.iso.datetime()
});
