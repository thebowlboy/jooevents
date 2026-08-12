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

/** Maps Better Auth's already-validated Google principal to provider-neutral claims. */
export function createSQLiteAuthPrincipalReader(sqlite: Database): AuthPrincipalEvidenceReader {
  return {
    async getVerifiedClaims(authUserId: string): Promise<AdapterOutcome<ExternalIdentityClaims>> {
      const row = sqlite.query<PrincipalRow, [string]>(`
        select u.id auth_user_id, a.account_id, a.provider_id, u.email, u.email_verified,
               u.name, u.image, u.updated_at
          from auth_users u join auth_accounts a on a.user_id = u.id
         where u.id = ? and a.provider_id = 'google'
         order by a.updated_at desc limit 1
      `).get(authUserId);
      if (!row) return failure({ code: 'auth_principal_evidence_missing', message: 'The verified provider evidence is not available yet.', retryable: true });
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
