/**
 * Pure presentation logic for the API keys panel: derived key state, the
 * profile↔switches agreement (tiles and the granular panel are two views of
 * one grant, so drift lands on Custom rather than letting a tile lie), and the
 * grant summary line the creation flow restates before minting.
 */
import type {
	ApiKeyDraft,
	ApiKeyPermissionGroup,
	ApiKeyProfile,
	ApiKeyProfileKey,
	ApiKeyView
} from '$lib/api/api-keys-page-port';
import { API_KEY_EXPIRES_SOON_DAYS } from '@jooevents/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inside this window an active key's expiry becomes a caution state. */
export const EXPIRES_SOON_DAYS = API_KEY_EXPIRES_SOON_DAYS;

export type ApiKeyState = 'active' | 'expires_soon' | 'expired' | 'revoked';

export function apiKeyState(key: ApiKeyView, now: number): ApiKeyState {
	if (key.standing === 'revoked') return 'revoked';
	if (key.expiresAt === null) return 'active';
	const expiresAt = new Date(key.expiresAt).getTime();
	if (expiresAt <= now) return 'expired';
	if (expiresAt - now <= EXPIRES_SOON_DAYS * DAY_MS) return 'expires_soon';
	return 'active';
}

/**
 * The exceptional-state badge. Plain `active` returns null: the active group's
 * band already states the resting fact once, and a column repeating it on
 * every row is the defect the design system names.
 */
export function apiKeyStateBadge(
	state: ApiKeyState
): { readonly label: string; readonly tone: 'caution' | 'neutral' } | null {
	if (state === 'expires_soon') return { label: 'Expires soon', tone: 'caution' };
	if (state === 'expired') return { label: 'Expired', tone: 'neutral' };
	if (state === 'revoked') return { label: 'Revoked', tone: 'neutral' };
	return null;
}

/** Every permission id the signed-in person currently holds, in catalog order. */
export function heldPermissionIds(catalog: readonly ApiKeyPermissionGroup[]): readonly string[] {
	return catalog.flatMap((group) =>
		group.permissions.filter((permission) => permission.held).map((permission) => permission.id)
	);
}

/** A profile's concrete id list, with `'everything-held'` resolved. */
export function resolveProfileIds(
	profile: ApiKeyProfile,
	catalog: readonly ApiKeyPermissionGroup[]
): readonly string[] {
	return profile.permissionIds === 'everything-held'
		? heldPermissionIds(catalog)
		: profile.permissionIds;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const seen = new Set(left);
	return right.every((id) => seen.has(id));
}

/**
 * Which tile the current switches amount to. An exact match selects the
 * profile; anything else is Custom — the tiles never claim something the
 * switches below contradict.
 */
export function matchProfileKey(
	profiles: readonly ApiKeyProfile[],
	catalog: readonly ApiKeyPermissionGroup[],
	selection: { readonly proposesChanges: boolean; readonly permissionIds: readonly string[] }
): ApiKeyProfileKey {
	for (const profile of profiles) {
		if (profile.proposesChanges !== selection.proposesChanges) continue;
		if (sameSet(resolveProfileIds(profile, catalog), selection.permissionIds)) return profile.key;
	}
	return 'custom';
}

export type GroupSelection = 'all' | 'none' | 'some';

export function groupSelection(
	group: ApiKeyPermissionGroup,
	selected: ReadonlySet<string>
): GroupSelection {
	const count = group.permissions.filter((permission) => selected.has(permission.id)).length;
	if (count === 0) return 'none';
	return count === group.permissions.length ? 'all' : 'some';
}

/** `Read-only · 4 permissions` / `Reads and proposes · 5 permissions` / `Full access`. */
export function accessSummary(
	key: Pick<ApiKeyView, 'proposesChanges' | 'permissionIds'>,
	catalog: readonly ApiKeyPermissionGroup[]
): string {
	const held = heldPermissionIds(catalog);
	if (key.proposesChanges && sameSet(key.permissionIds, held)) return 'Full access';
	const capability = key.proposesChanges ? 'Reads and proposes' : 'Read-only';
	const count = key.permissionIds.length;
	return `${capability} · ${count} permission${count === 1 ? '' : 's'}`;
}

/**
 * The one line restating the whole grant before minting. Attribute list, not
 * prose: these are the draft key's own facts, so the interpunct carries them.
 */
export function grantSummary(
	draft: Pick<ApiKeyDraft, 'proposesChanges' | 'permissionIds' | 'eventIds'>,
	catalog: readonly ApiKeyPermissionGroup[],
	events: readonly { readonly id: string; readonly name: string }[],
	expiresOn: string | null
): string {
	const access = accessSummary(draft, catalog);
	const scope =
		draft.eventIds.length === 0
			? 'All events'
			: events
					.filter((event) => draft.eventIds.includes(event.id))
					.map((event) => event.name)
					.join(', ') || 'No events chosen';
	return `${access} · ${scope} · ${expiresOn === null ? 'Never expires' : `Expires ${expiresOn}`}`;
}
