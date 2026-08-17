/**
 * The API keys settings seam: the credential list, the permission catalog the
 * creation flow renders, the named key profiles, and the mint/rotate/revoke
 * commands. A key's stored grant is always the explicit permission-id list plus
 * the propose-changes capability — a profile is an input convenience, never a
 * wildcard — and the raw secret exists only inside a mint result, exactly once.
 */

export type ApiKeyPermissionRisk = 'routine' | 'sensitive' | 'consequential';

export interface ApiKeyPermission {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly risk: ApiKeyPermissionRisk;
	/**
	 * Whether the signed-in person currently holds this permission. A key can
	 * only narrow its owner, so an unheld permission stays visible and
	 * selectable but grants nothing until the owner holds it.
	 */
	readonly held: boolean;
}

export interface ApiKeyPermissionGroup {
	readonly key: string;
	readonly label: string;
	readonly permissions: readonly ApiKeyPermission[];
}

/** The named use cases the creation flow leads with; `custom` is the granular path. */
export type ApiKeyProfileKey = 'full' | 'assistant' | 'dashboard' | 'schedule' | 'custom';

export interface ApiKeyProfile {
	readonly key: Exclude<ApiKeyProfileKey, 'custom'>;
	readonly label: string;
	readonly description: string;
	readonly proposesChanges: boolean;
	/** `'everything-held'` snapshots the creator's currently granted ids. */
	readonly permissionIds: readonly string[] | 'everything-held';
}

export type ApiKeyRevokeReason = 'rotated' | 'owner_request' | 'admin_request' | 'security';

export interface ApiKeyView {
	readonly id: string;
	readonly name: string;
	/** Prefix plus the first four secret characters — `jooak1_Vk8j` — never more. */
	readonly tokenHint: string;
	readonly proposesChanges: boolean;
	readonly permissionIds: readonly string[];
	/** Empty means every event the owner can reach. */
	readonly eventIds: readonly string[];
	readonly createdAt: string;
	/** `null` means the owner explicitly chose a key that does not expire. */
	readonly expiresAt: string | null;
	readonly lastUsedAt: string | null;
	readonly standing: 'active' | 'revoked';
	readonly revokedAt: string | null;
	readonly revokeReason: ApiKeyRevokeReason | null;
}

export interface ApiKeyDraft {
	readonly name: string;
	readonly proposesChanges: boolean;
	readonly permissionIds: readonly string[];
	/** Empty means every event. */
	readonly eventIds: readonly string[];
	/** `null` is the explicit never-expire choice. */
	readonly expiresInDays: number | null;
}

export type ApiKeyMintResult =
	| { readonly kind: 'created'; readonly key: ApiKeyView; readonly secret: string }
	| { readonly kind: 'refused'; readonly reason: string };

export type ApiKeyRotateResult =
	| {
			readonly kind: 'rotated';
			readonly successor: ApiKeyView;
			readonly predecessor: ApiKeyView;
			readonly secret: string;
	  }
	| { readonly kind: 'refused'; readonly reason: string };

export type ApiKeyRevokeResult =
	| { readonly kind: 'revoked'; readonly key: ApiKeyView }
	| { readonly kind: 'refused'; readonly reason: string };

export interface ApiKeysPagePort {
	readonly source: { readonly kind: 'sample' | 'live' };
	/** The event's zone, so expiry dates read on the event's calendar. */
	readonly timezone: string;
	readonly catalog: readonly ApiKeyPermissionGroup[];
	readonly profiles: readonly ApiKeyProfile[];
	readonly events: readonly { readonly id: string; readonly name: string }[];
	readonly expiry: {
		readonly defaultDays: number;
		readonly maxDays: number;
		/** How long a rotated-out predecessor keeps working. */
		readonly rotationGraceDays: number;
	};
	list(): Promise<readonly ApiKeyView[]>;
	create(draft: ApiKeyDraft): Promise<ApiKeyMintResult>;
	rotate(id: string): Promise<ApiKeyRotateResult>;
	revoke(id: string): Promise<ApiKeyRevokeResult>;
}
