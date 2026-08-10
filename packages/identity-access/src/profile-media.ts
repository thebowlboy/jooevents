import type {
  ISODateTime,
  ProviderAvatarCandidate,
  UserId
} from './identity';
import type { AdapterOutcome, OperationalNotice } from './outcomes';
import { success } from './outcomes';

export type MediaAssetId = string;
export type AvatarImportPolicy = 'replace' | 'keep_existing' | 'confirm_if_existing';

/** Database metadata for bytes held by a BlobStore adapter. */
export interface MediaAsset {
  readonly id: MediaAssetId;
  readonly ownerUserId: UserId;
  readonly purpose: 'profile_avatar';
  readonly storageProvider: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly sourceProvider?: string;
  readonly sourceUrl?: string;
  readonly sourceFingerprint?: string;
  readonly createdAt: ISODateTime;
}

export interface AvatarImportIntent {
  readonly action: 'enqueue';
  readonly userId: UserId;
  readonly candidate: ProviderAvatarCandidate;
  readonly expectedCurrentAssetId?: MediaAssetId;
  readonly replaceAssetId?: MediaAssetId;
}

export interface AvatarImportSkip {
  readonly action: 'skip';
  readonly reason: 'provider_has_no_image' | 'unchanged' | 'keep_existing';
}

export type AvatarImportPlan = AvatarImportIntent | AvatarImportSkip;

export interface AvatarImportJob {
  readonly id: string;
  readonly userId: UserId;
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly sourceProvider: string;
  readonly sourceUrl: string;
  readonly sourceFingerprint?: string;
  readonly expectedCurrentAssetId?: MediaAssetId;
  readonly replaceAssetId?: MediaAssetId;
  readonly attempts: number;
  readonly nextAttemptAt: ISODateTime;
  readonly lastErrorCode?: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface StoredBlob {
  readonly provider: string;
  readonly key: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
}

/** Local disk, S3, and R2 implement this port without changing User or MediaAsset. */
export interface BlobStore {
  readonly provider: string;
  putObject(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<AdapterOutcome<StoredBlob>>;
  deleteObject(key: string): Promise<AdapterOutcome<{ readonly deleted: boolean }>>;
}

export interface RemoteImageFetchPolicy {
  readonly allowedHttpsHosts: readonly string[];
  readonly followRedirects: false;
  readonly rejectPrivateNetworkAddresses: true;
  readonly maximumBytes: number;
  readonly allowedContentTypes: readonly string[];
  readonly maximumWidth: number;
  readonly maximumHeight: number;
}

export const DEFAULT_PROVIDER_AVATAR_FETCH_POLICY: RemoteImageFetchPolicy = {
  allowedHttpsHosts: ['lh3.googleusercontent.com'],
  followRedirects: false,
  rejectPrivateNetworkAddresses: true,
  maximumBytes: 5 * 1024 * 1024,
  allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  maximumWidth: 2048,
  maximumHeight: 2048
};

function sameSource(
  current: MediaAsset,
  candidate: ProviderAvatarCandidate
): boolean {
  if (
    current.sourceFingerprint !== undefined &&
    candidate.sourceFingerprint !== undefined
  ) {
    return (
      current.sourceProvider === candidate.provider &&
      current.sourceFingerprint === candidate.sourceFingerprint
    );
  }

  return current.sourceProvider === candidate.provider && current.sourceUrl === candidate.url;
}

/** Plans profile synchronization; downloading remains an asynchronous worker responsibility. */
export function planAvatarImport(input: {
  readonly userId: UserId;
  readonly candidate?: ProviderAvatarCandidate;
  readonly current?: MediaAsset;
  readonly policy: AvatarImportPolicy;
}): AdapterOutcome<AvatarImportPlan> {
  if (!input.candidate) {
    return success({ action: 'skip', reason: 'provider_has_no_image' });
  }

  if (input.current && sameSource(input.current, input.candidate)) {
    return success({ action: 'skip', reason: 'unchanged' });
  }

  const proposal: AvatarImportIntent = {
    action: 'enqueue',
    userId: input.userId,
    candidate: input.candidate,
    ...(input.current
      ? {
          expectedCurrentAssetId: input.current.id,
          replaceAssetId: input.current.id
        }
      : {})
  };

  if (!input.current || input.policy === 'replace') return success(proposal);

  const notice: OperationalNotice = {
    code: 'existing_profile_image_preserved',
    severity: 'warning',
    message: 'A profile image already exists, so the provider image was not imported.'
  };

  if (input.policy === 'keep_existing') {
    return success({ action: 'skip', reason: 'keep_existing' }, [notice]);
  }

  return {
    kind: 'needs_confirmation',
    proposed: proposal,
    confirmation: {
      code: 'replace_existing_profile_image',
      prompt: 'Replace the existing profile image with the image supplied by the login provider?',
      choices: [
        { id: 'replace', label: 'Replace image', consequence: 'The copied provider image becomes the active profile image.' },
        { id: 'keep', label: 'Keep current image', consequence: 'The current profile image remains unchanged.' }
      ],
      defaultChoiceId: 'keep'
    },
    notices: [notice]
  };
}
