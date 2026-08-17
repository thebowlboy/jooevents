import type { AuthPrincipalEvidenceReader } from '@jooevents/application';
import {
  failure,
  success,
  type AdapterOutcome,
  type ExternalIdentityClaims
} from '@jooevents/identity-access';

interface GooglePrincipalRow {
  readonly auth_user_id: string;
  readonly account_id: string;
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

/** Maps Better Auth's committed D1 principal to provider-neutral evidence. */
export function createD1AuthPrincipalReader(
  database: D1Database,
  emailProof?: { readonly issuerOrigin: string }
): AuthPrincipalEvidenceReader {
  return {
    async getVerifiedClaims(authUserId: string): Promise<AdapterOutcome<ExternalIdentityClaims>> {
      const session = database.withSession('first-primary');
      const row = await session.prepare(`
        SELECT u.id AS auth_user_id,a.account_id,u.email,u.email_verified,
               u.name,u.image,u.updated_at
          FROM auth_users u JOIN auth_accounts a ON a.user_id = u.id
         WHERE u.id = ? AND a.provider_id = 'google'
         ORDER BY a.updated_at DESC LIMIT 1
      `).bind(authUserId).first<GooglePrincipalRow>();
      if (!row) {
        if (emailProof) {
          const principal = await session.prepare(`
            SELECT u.id,u.email,u.email_verified,u.name,u.updated_at,
                   (SELECT count(*) FROM auth_accounts a WHERE a.user_id = u.id) AS account_count
              FROM auth_users u WHERE u.id = ?
          `).bind(authUserId).first<EmailPrincipalRow>();
          if (principal && principal.account_count === 0 && principal.email_verified === 1) {
            return success({
              provider: 'email',
              issuer: emailProof.issuerOrigin,
              subject: principal.id,
              email: principal.email,
              emailVerified: true,
              displayName: principal.name,
              observedAt: new Date(principal.updated_at).toISOString()
            });
          }
        }
        return failure({
          code: 'auth_principal_evidence_missing',
          message: 'The verified provider evidence is not available yet.',
          retryable: true
        });
      }
      if (row.email_verified !== 1) {
        return failure({
          code: 'email_not_verified',
          message: 'Google did not verify the required email address.',
          retryable: false
        });
      }
      const observedAt = new Date(row.updated_at).toISOString();
      return success({
        provider: 'google',
        issuer: 'https://accounts.google.com',
        subject: row.account_id,
        email: row.email,
        emailVerified: true,
        displayName: row.name,
        ...(row.image
          ? { avatar: { provider: 'google', url: row.image, observedAt } }
          : {}),
        observedAt
      });
    }
  };
}
