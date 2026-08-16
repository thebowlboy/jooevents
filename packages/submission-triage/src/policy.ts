import type { VersionedAccessPolicyRef } from '@jooevents/identity-access';
import { parseContractVersion } from '@jooevents/kernel';

/** Current-authority policy required for organizer submission-triage transitions. */
export const SUBMISSION_TRIAGE_MANAGE_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.submission.triage-manage',
  version: parseContractVersion(1)
});

export const SUBMISSION_TRIAGE_OPERATOR_READ_ACCESS_POLICY: VersionedAccessPolicyRef =
  Object.freeze({
    key: 'authority.submission.triage-read',
    version: parseContractVersion(1)
  });

export const SUBMISSION_TRIAGE_MCP_READ_ACCESS_POLICY: VersionedAccessPolicyRef = Object.freeze({
  key: 'authority.submission.triage-mcp-read',
  version: parseContractVersion(1)
});
