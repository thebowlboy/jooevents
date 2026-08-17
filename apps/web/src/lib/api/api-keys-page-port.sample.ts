/**
 * Deterministic in-memory API keys, so the settings mock exercises the same
 * port, refusal vocabulary, and show-once secret ceremony the live lane will
 * serve — no fetch. State lives per created port and resets with the
 * composition. Fixture times are relative to load so the scenario never ages
 * out; minted secrets are sample-random and never persisted anywhere.
 */
import type {
	ApiKeyDraft,
	ApiKeyMintResult,
	ApiKeyPermissionGroup,
	ApiKeyProfile,
	ApiKeyRevokeResult,
	ApiKeyRotateResult,
	ApiKeyView,
	ApiKeysPagePort
} from './api-keys-page-port';

const DAY_MS = 24 * 60 * 60 * 1000;

const group = (
	key: string,
	label: string,
	permissions: ApiKeyPermissionGroup['permissions']
): ApiKeyPermissionGroup => Object.freeze({ key, label, permissions: Object.freeze(permissions) });

const permission = (
	id: string,
	label: string,
	description: string,
	risk: 'routine' | 'sensitive' | 'consequential',
	held = true
) => Object.freeze({ id, label, description, risk, held });

/**
 * The catalog the creation flow renders, in the permission catalog's own
 * grouping. `publication.manage` is deliberately unheld: the sample viewer's
 * admin role predates it, which is exactly the marked-but-selectable state the
 * design has to show.
 */
export const SAMPLE_API_KEY_CATALOG: readonly ApiKeyPermissionGroup[] = Object.freeze([
	group('events', 'Events', [
		permission('event.read', 'See event details', 'Dates, venue, settings, and progress.', 'routine'),
		permission('event.manage', 'Change event settings', 'Dates, venue, deadlines, and setup.', 'sensitive'),
		permission(
			'program.vocabulary.manage',
			'Manage tracks and formats',
			'Add, rename, retire, and merge rooms, tracks, and formats.',
			'sensitive'
		)
	]),
	group('speakers', 'Speakers', [
		permission(
			'speaker.directory.read',
			'See the speaker directory',
			'Names, bios, and public profiles.',
			'routine'
		),
		permission(
			'speaker.contact.read',
			'See private contact details',
			'Email addresses and phone numbers. No named profile includes this.',
			'sensitive'
		),
		permission(
			'speaker.profile.manage',
			'Change speaker profiles',
			'Edit names, bios, and photos.',
			'sensitive'
		)
	]),
	group('submissions', 'Submissions', [
		permission('submission.read', 'Read submissions', 'Titles, abstracts, and review state.', 'routine'),
		permission('submission.score', 'Score submissions', 'Record review scores.', 'sensitive'),
		permission('submission.comment', 'Comment on submissions', 'Write review comments.', 'sensitive'),
		permission(
			'submission.decision',
			'Decide submissions',
			'Accept, waitlist, or decline. Feeds the not-yet-told indicator.',
			'consequential'
		)
	]),
	group('schedule', 'Schedule', [
		permission('schedule.read', 'See the working schedule', 'Sessions, rooms, and timing.', 'routine'),
		permission('schedule.manage', 'Change sessions and timing', 'Create sessions, move rooms and times.', 'sensitive'),
		permission('schedule.publish', 'Publish the schedule', 'Push schedule changes to the public page.', 'consequential'),
		permission(
			'publication.manage',
			'Publish public pages',
			'Release program, speaker, and form pages to the public internet.',
			'consequential',
			false
		)
	]),
	group('communications', 'Communications', [
		permission('communication.draft', 'Draft messages', 'Write and revise message drafts.', 'routine'),
		permission('communication.send', 'Send messages', 'Real email leaves the building.', 'consequential'),
		permission(
			'communication.provider.manage',
			'Manage the email provider',
			'Provider connection and sender setup.',
			'sensitive'
		)
	]),
	group('access', 'Users & access', [
		permission('access.users.read', 'See workspace members', 'Who holds access, at what role.', 'sensitive'),
		permission('access.users.invite', 'Invite members', 'Reserve access for an email address.', 'sensitive'),
		permission('access.users.approve', 'Approve member requests', 'Admit pending people.', 'consequential'),
		permission('access.roles.manage', 'Edit roles', 'Change what each role can do.', 'consequential'),
		permission('access.users.suspend', 'Suspend members', 'Remove a person’s workspace access.', 'consequential')
	]),
	group('integrations', 'Integrations', [
		permission('integration.airtable.read', 'Read the Airtable mirror', 'Mirror state and mapping health.', 'sensitive'),
		permission(
			'integration.airtable.manage',
			'Manage the Airtable connection',
			'Connect, map, and reconcile the base.',
			'consequential'
		)
	]),
	group('audit', 'Audit', [
		permission('audit.read', 'Read the audit history', 'Who did what, when, through which operation.', 'sensitive')
	])
]);

export const SAMPLE_API_KEY_PROFILES: readonly ApiKeyProfile[] = Object.freeze([
	Object.freeze({
		key: 'full' as const,
		label: 'Full access',
		description:
			'Everything you can currently do — reads and proposed changes alike. Every proposed change still waits for a person’s approval.',
		proposesChanges: true,
		permissionIds: 'everything-held' as const
	}),
	Object.freeze({
		key: 'assistant' as const,
		label: 'Assistant',
		description:
			'Reads the program, submissions, schedule, and speaker directory, and drafts messages. No private contact details, no access administration. The right choice for most agents.',
		proposesChanges: true,
		permissionIds: Object.freeze([
			'event.read',
			'submission.read',
			'schedule.read',
			'speaker.directory.read',
			'communication.draft'
		])
	}),
	Object.freeze({
		key: 'dashboard' as const,
		label: 'Dashboard',
		description:
			'Read-only: the routine reads an external dashboard, report, or polling script needs. No private contact details.',
		proposesChanges: false,
		permissionIds: Object.freeze([
			'event.read',
			'submission.read',
			'schedule.read',
			'speaker.directory.read'
		])
	}),
	Object.freeze({
		key: 'schedule' as const,
		label: 'Schedule display',
		description:
			'Read-only and narrowest: the working schedule and event basics, for venue screens and site widgets. The published schedule already has public endpoints.',
		proposesChanges: false,
		permissionIds: Object.freeze(['event.read', 'schedule.read'])
	})
]);

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Sample-random: shape-true (`jooak1_` + 43 chars), never stored, never real. */
function mintSampleSecret(): string {
	let body = '';
	for (let index = 0; index < 43; index += 1) {
		body += SECRET_ALPHABET[Math.floor(Math.random() * SECRET_ALPHABET.length)];
	}
	return `jooak1_${body}`;
}

export function createSampleApiKeysPagePort(): ApiKeysPagePort {
	const now = Date.now();
	const at = (days: number) => new Date(now + days * DAY_MS).toISOString();
	let sequence = 0;
	const nextId = () => `sample-key-${(sequence += 1)}`;

	const fixture = (input: {
		name: string;
		tokenHint: string;
		proposesChanges: boolean;
		permissionIds: readonly string[];
		createdDaysAgo: number;
		expiresInDays: number | null;
		lastUsedDaysAgo: number | null;
		revokedDaysAgo?: number;
		revokeReason?: ApiKeyView['revokeReason'];
	}): ApiKeyView => ({
		id: nextId(),
		name: input.name,
		tokenHint: input.tokenHint,
		proposesChanges: input.proposesChanges,
		permissionIds: input.permissionIds,
		eventIds: [],
		createdAt: at(-input.createdDaysAgo),
		expiresAt: input.expiresInDays === null ? null : at(input.expiresInDays),
		lastUsedAt: input.lastUsedDaysAgo === null ? null : at(-input.lastUsedDaysAgo),
		standing: input.revokedDaysAgo === undefined ? 'active' : 'revoked',
		revokedAt: input.revokedDaysAgo === undefined ? null : at(-input.revokedDaysAgo),
		revokeReason: input.revokeReason ?? null
	});

	let keys: ApiKeyView[] = [
		fixture({
			name: 'Claude assistant',
			tokenHint: 'jooak1_Vk8j',
			proposesChanges: true,
			permissionIds: ['event.read', 'submission.read', 'schedule.read', 'speaker.directory.read', 'communication.draft'],
			createdDaysAgo: 10,
			expiresInDays: 80,
			lastUsedDaysAgo: 0.08
		}),
		fixture({
			name: 'Production dashboard',
			tokenHint: 'jooak1_Qm4t',
			proposesChanges: false,
			permissionIds: ['event.read', 'submission.read', 'schedule.read', 'speaker.directory.read'],
			createdDaysAgo: 32,
			expiresInDays: null,
			lastUsedDaysAgo: 0.008
		}),
		fixture({
			name: 'Lobby screen',
			tokenHint: 'jooak1_Xw2p',
			proposesChanges: false,
			permissionIds: ['event.read', 'schedule.read'],
			createdDaysAgo: 85,
			expiresInDays: 5,
			lastUsedDaysAgo: 3
		}),
		fixture({
			name: 'Old export script',
			tokenHint: 'jooak1_Rf7s',
			proposesChanges: false,
			permissionIds: ['event.read', 'submission.read', 'speaker.directory.read', 'speaker.contact.read'],
			createdDaysAgo: 120,
			expiresInDays: 60,
			lastUsedDaysAgo: 21,
			revokedDaysAgo: 20,
			revokeReason: 'owner_request'
		})
	];

	function replace(next: ApiKeyView): void {
		keys = keys.map((key) => (key.id === next.id ? next : key));
	}

	const port: ApiKeysPagePort = {
		source: Object.freeze({ kind: 'sample' as const }),
		timezone: 'Europe/Helsinki',
		catalog: SAMPLE_API_KEY_CATALOG,
		profiles: SAMPLE_API_KEY_PROFILES,
		events: Object.freeze([
			Object.freeze({ id: 'event-2027', name: 'HelsinkiJS 2027' }),
			Object.freeze({ id: 'event-2026', name: 'HelsinkiJS 2026' })
		]),
		expiry: Object.freeze({ defaultDays: 90, maxDays: 365, rotationGraceDays: 7 }),
		async list() {
			return keys.map((key) => ({ ...key }));
		},
		async create(draft: ApiKeyDraft): Promise<ApiKeyMintResult> {
			const name = draft.name.trim();
			if (name.length === 0) {
				return { kind: 'refused', reason: 'Name the key so you can tell it apart later.' };
			}
			if (draft.permissionIds.length === 0) {
				return { kind: 'refused', reason: 'Pick at least one permission — a key that can do nothing has no reason to exist.' };
			}
			const secret = mintSampleSecret();
			const key: ApiKeyView = {
				id: nextId(),
				name,
				tokenHint: secret.slice(0, 11),
				proposesChanges: draft.proposesChanges,
				permissionIds: [...draft.permissionIds],
				eventIds: [...draft.eventIds],
				createdAt: new Date().toISOString(),
				expiresAt:
					draft.expiresInDays === null
						? null
						: new Date(Date.now() + draft.expiresInDays * DAY_MS).toISOString(),
				lastUsedAt: null,
				standing: 'active',
				revokedAt: null,
				revokeReason: null
			};
			keys = [key, ...keys];
			return { kind: 'created', key: { ...key }, secret };
		},
		async rotate(id: string): Promise<ApiKeyRotateResult> {
			const current = keys.find((key) => key.id === id);
			if (!current || current.standing !== 'active') {
				return { kind: 'refused', reason: 'This key is no longer active, so there is nothing to rotate. Create a new key instead.' };
			}
			const secret = mintSampleSecret();
			const graceMs = port.expiry.rotationGraceDays * DAY_MS;
			const clamped = Math.min(
				current.expiresAt === null ? Number.POSITIVE_INFINITY : new Date(current.expiresAt).getTime(),
				Date.now() + graceMs
			);
			const predecessor: ApiKeyView = { ...current, expiresAt: new Date(clamped).toISOString() };
			const successor: ApiKeyView = {
				...current,
				id: nextId(),
				name: current.name,
				tokenHint: secret.slice(0, 11),
				createdAt: new Date().toISOString(),
				expiresAt:
					current.expiresAt === null
						? null
						: new Date(Date.now() + port.expiry.defaultDays * DAY_MS).toISOString(),
				lastUsedAt: null
			};
			replace(predecessor);
			keys = [successor, ...keys];
			return { kind: 'rotated', successor: { ...successor }, predecessor: { ...predecessor }, secret };
		},
		async revoke(id: string): Promise<ApiKeyRevokeResult> {
			const current = keys.find((key) => key.id === id);
			if (!current || current.standing !== 'active') {
				return { kind: 'refused', reason: 'This key was already revoked.' };
			}
			const revoked: ApiKeyView = {
				...current,
				standing: 'revoked',
				revokedAt: new Date().toISOString(),
				revokeReason: 'owner_request'
			};
			replace(revoked);
			return { kind: 'revoked', key: { ...revoked } };
		}
	};
	return Object.freeze(port);
}
