import type { Database } from 'bun:sqlite';
import {
  failure,
  success,
  type AdapterOutcome,
  type ExternalIdentityClaims
} from '@jooevents/identity-access';
import type { AuthPrincipalEvidenceReader } from '@jooevents/application';

interface PrincipalRow {
  readonly auth_user_id: string;
  readonly account_id: string;
  readonly provider_id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly name: string;
  readonly image: string | null;
  readonly updated_at: number;
}

interface EmailPrincipalRow {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly name: string;
  readonly updated_at: number;
  readonly account_count: number;
}

/**
 * Maps Better Auth's already-validated principal to provider-neutral claims.
 * Two credential shapes exist: the Google account, and the first-party
 * email-proof (magic link) principal, which has NO provider account row —
 * the adapter commits an OAuth user and its account atomically, so a
 * session-bearing auth user with zero accounts can only have arrived through
 * a completed mailbox-proof ceremony. Its claims are issued by this
 * installation and keyed by the auth user id, so equal email never merges
 * two principals.
 */
export function createSQLiteAuthPrincipalReader(
  sqlite: Database,
  emailProof?: { readonly issuerOrigin: string }
): AuthPrincipalEvidenceReader {
  return {
    async getVerifiedClaims(authUserId: string): Promise<AdapterOutcome<ExternalIdentityClaims>> {
      const row = sqlite.query<PrincipalRow, [string]>(`
        select u.id auth_user_id, a.account_id, a.provider_id, u.email, u.email_verified,
               u.name, u.image, u.updated_at
          from auth_users u join auth_accounts a on a.user_id = u.id
         where u.id = ? and a.provider_id = 'google'
         order by a.updated_at desc limit 1
      `).get(authUserId);
      if (!row) {
        if (emailProof) {
          const principal = sqlite.query<EmailPrincipalRow, [string]>(`
            select u.id, u.email, u.email_verified, u.name, u.updated_at,
                   (select count(*) from auth_accounts a where a.user_id = u.id) account_count
              from auth_users u where u.id = ?
          `).get(authUserId);
          if (principal && principal.account_count === 0 && principal.email_verified === 1) {
            const observedAt = new Date(principal.updated_at).toISOString();
            return success({
              provider: 'email',
              issuer: emailProof.issuerOrigin,
              subject: principal.id,
              email: principal.email,
              emailVerified: true,
              displayName: principal.name,
              observedAt
            });
          }
        }
        return failure({ code: 'auth_principal_evidence_missing', message: 'The verified provider evidence is not available yet.', retryable: true });
      }
      if (row.email_verified !== 1) return failure({ code: 'email_not_verified', message: 'Google did not verify the required email address.', retryable: false });

      const observedAt = new Date(row.updated_at).toISOString();
      return success({
        provider: 'google',
        issuer: 'https://accounts.google.com',
        subject: row.account_id,
        email: row.email,
        emailVerified: true,
        displayName: row.name,
        // The current auth records do not retain Google's verified `hd` claim. Omitting
        // it keeps workspace-domain admission closed until such evidence is available.
        ...(row.image
          ? { avatar: { provider: 'google', url: row.image, observedAt } }
          : {}),
        observedAt
      });
    }
  };
}
