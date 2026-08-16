import {
	createSampleSenderIdentitySettingsPort,
	type SampleSenderIdentitySource,
	type SettingsPageSenderIdentityPort
} from './sender-identity-settings-port';
import type { WorkspaceTeamSettingsMutationResult, WorkspaceTeamSettingsPort } from './workspace-team-settings-adapter';
import type { WorkspaceTeamLiveReadResult } from './operations/workspace-team-live';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import type { PlacementSuggestion } from './placement';
import type {
	EventSettings,
	FieldContext,
	FieldKind,
	Format,
	Member,
	MutationOutcome,
	RegistryField,
	Room,
	Track,
	WorkspaceSummary
} from './types';

export interface SettingsPageEventPort {
	get(): Promise<EventSettings | null>;
	update(patch: Partial<EventSettings>): Promise<EventSettings | null>;
}

export interface SettingsPageFieldsPort {
	list(): Promise<RegistryField[]>;
	add(input: {
		kind: FieldKind;
		label: string;
		help?: string;
		options?: string[];
		collectAt: FieldContext[];
		requiredIn?: FieldContext[];
		formScope?: string;
	}): Promise<{ field: RegistryField; placement: PlacementSuggestion }>;
	update(
		id: string,
		patch: Partial<Pick<RegistryField, 'label' | 'help' | 'options' | 'required' | 'collectAt'>>
	): Promise<MutationOutcome>;
	remove(id: string): Promise<MutationOutcome>;
	move(id: string, toIndex: number): Promise<MutationOutcome>;
	restore(field: RegistryField, index: number): Promise<void>;
}

export interface SettingsPageVocabularyPort {
	rooms(): Promise<Room[]>;
	tracks(): Promise<Track[]>;
	formats(): Promise<Format[]>;
	addRoom(name: string, capacity: number): Promise<Room>;
	addTrack(name: string): Promise<Track>;
	addFormat(name: string): Promise<Format>;
	removeRoom(id: string): Promise<MutationOutcome>;
	removeTrack(id: string): Promise<MutationOutcome>;
	removeFormat(id: string): Promise<MutationOutcome>;
	retireRoom(id: string): Promise<MutationOutcome>;
	retireTrack(id: string): Promise<MutationOutcome>;
	retireFormat(id: string): Promise<MutationOutcome>;
	restoreRoom(id: string): Promise<MutationOutcome>;
	restoreTrack(id: string): Promise<MutationOutcome>;
	restoreFormat(id: string): Promise<MutationOutcome>;
}

export interface SampleSettingsPageSource {
	readonly workspace: {
		summarySnapshot(): WorkspaceSummary | null;
	};
	readonly settings: SettingsPageEventPort & {
		members(): Promise<Member[]>;
		invite(email: string, role: string): Promise<Member>;
		changeRole(id: string, role: string): Promise<MutationOutcome>;
		removeMember(id: string): Promise<MutationOutcome>;
	};
	readonly vocab: SettingsPageVocabularyPort;
	readonly fields: SettingsPageFieldsPort;
	readonly communications: { readonly senderIdentity: SampleSenderIdentitySource };
}

export type SettingsTeamReadResult =
	| { readonly kind: 'success'; readonly members: readonly Member[] }
	| { readonly kind: 'failure'; readonly reason: string };

export type SettingsTeamActionResult =
	| {
			readonly ok: true;
			readonly committed: true;
			readonly message: string;
			readonly members?: readonly Member[];
			readonly member?: Member;
			readonly removedId?: string;
	  }
	| { readonly ok: false; readonly committed: false; readonly reason: string };

export interface SettingsPageTeamPort {
	members(): Promise<SettingsTeamReadResult>;
	invite(email: string, role: string): Promise<SettingsTeamActionResult>;
	changeRole(id: string, role: string): Promise<SettingsTeamActionResult>;
	removeMember(id: string): Promise<SettingsTeamActionResult>;
}

export interface SettingsPagePort {
	readonly source: { readonly kind: 'sample' | 'live' };
	readonly workspace: {
		summarySnapshot(): WorkspaceSummary | null;
	};
	readonly event: SettingsPageEventPort;
	readonly team: SettingsPageTeamPort;
	readonly vocab: SettingsPageVocabularyPort;
	readonly fields: SettingsPageFieldsPort;
	/**
	 * Workspace-scoped, not event-scoped: the Email section answers before any
	 * event exists, so this seam is not gated on `event.get()`.
	 */
	readonly senderIdentity: SettingsPageSenderIdentityPort;
}

function cloneMember(member: Member): Member {
	return { ...member };
}

function liveMember(member: Extract<WorkspaceTeamLiveReadResult, { readonly kind: 'success' }>['data']['members'][number]): Member {
	return {
		id: member.id,
		name: member.name,
		email: member.email,
		role: member.role.name,
		status: member.status
	};
}

function liveRoom(room: Awaited<ReturnType<ProgramVocabularySettingsPort['rooms']>>[number]): Room {
	return {
		id: room.id,
		name: room.name,
		capacity: room.capacity,
		status: room.status,
		usage: { ...room.usage }
	};
}

function liveTrack(track: Awaited<ReturnType<ProgramVocabularySettingsPort['tracks']>>[number]): Track {
	return {
		id: track.id,
		name: track.name,
		accent: track.accent,
		status: track.status,
		usage: { ...track.usage }
	};
}

function liveFormat(format: Awaited<ReturnType<ProgramVocabularySettingsPort['formats']>>[number]): Format {
	return {
		id: format.id,
		name: format.name,
		status: format.status,
		usage: { ...format.usage }
	};
}

async function vocabularyOutcome(
	result: ReturnType<ProgramVocabularySettingsPort[
		'removeRoom' | 'removeTrack' | 'removeFormat' |
		'retireRoom' | 'retireTrack' | 'retireFormat' |
		'restoreRoom' | 'restoreTrack' | 'restoreFormat'
	]>
): Promise<MutationOutcome> {
	const resolved = await result;
	return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
}

function readFailure(result: Exclude<WorkspaceTeamLiveReadResult, { readonly kind: 'success' }>): string {
	if (result.kind === 'unavailable') return 'Team access is not available in this live workspace.';
	if (result.kind === 'transport_error') {
		return result.error.retryable
			? 'The team list could not be reached. Try again.'
			: 'The team list response was not valid.';
	}
	if (result.outcome.class === 'access_denied') return 'You no longer have permission to view the team.';
	return 'The team list could not be loaded.';
}

function mutationFailure(result: Exclude<WorkspaceTeamSettingsMutationResult,
	{ readonly kind: 'success' | 'committed_refresh_failed' | 'committed_projection_mismatch' }>): string {
	if (result.kind === 'refused') return result.reason;
	if (result.kind === 'prepare_read_failed') return readFailure(result.result);
	if (result.kind === 'unavailable') return 'This team change is not available in this live workspace.';
	if (result.kind === 'transport_error') {
		return result.error.retryable
			? 'The team change could not reach JooEvents. Try again.'
			: 'This team change was not valid.';
	}
	if (result.outcome.class === 'access_denied') {
		return 'You no longer have permission to make this team change.';
	}
	if (result.outcome.class === 'stale_revision') {
		return 'The team changed while you were working. Reload and try again.';
	}
	return 'This team change could not be applied.';
}

function committedButUnreconciled(): SettingsTeamActionResult {
	return {
		ok: true,
		committed: true,
		message: 'The team change was committed. Refresh to reconcile the latest team list.'
	};
}

export function createLiveSettingsPagePort(input: {
	readonly event: SettingsPageEventPort;
	readonly team: WorkspaceTeamSettingsPort;
	readonly vocab: ProgramVocabularySettingsPort;
	readonly fields: SettingsPageFieldsPort;
	readonly senderIdentity: SettingsPageSenderIdentityPort;
	readonly summarySnapshot?: () => WorkspaceSummary | null;
}): SettingsPagePort {
	if (input.vocab.source.kind !== 'live' || input.team.source.kind !== 'live') {
		throw new TypeError('live_settings_source_required');
	}

	async function apply(
		work: () => Promise<WorkspaceTeamSettingsMutationResult>,
		message: (result: Extract<WorkspaceTeamSettingsMutationResult, { readonly kind: 'success' }>) => string
	): Promise<SettingsTeamActionResult> {
		const result = await work();
		if (result.kind === 'committed_refresh_failed' || result.kind === 'committed_projection_mismatch') {
			return committedButUnreconciled();
		}
		if (result.kind !== 'success') {
			return { ok: false, committed: false, reason: mutationFailure(result) };
		}
		return {
			ok: true,
			committed: true,
			message: message(result),
			members: result.data.team.members.map(liveMember)
		};
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),
		workspace: Object.freeze({ summarySnapshot: input.summarySnapshot ?? (() => null) }),
		event: input.event,
		team: Object.freeze({
			async members(): Promise<SettingsTeamReadResult> {
				const result = await input.team.members();
				return result.kind === 'success'
					? { kind: 'success', members: result.data.members.map(liveMember) }
					: { kind: 'failure', reason: readFailure(result) };
			},
			invite(email: string, role: string) {
				return apply(
					() => input.team.invite(email, role),
					() => `Invitation recorded for ${email}. Delivery is awaiting activation.`
				);
			},
			changeRole(id: string, role: string) {
				return apply(() => input.team.changeRole(id, role), () => `Role changed to ${role}`);
			},
			removeMember(id: string) {
				return apply(() => input.team.removeMember(id), (result) => {
					const effect = result.data.effect;
					if (effect.action !== 'remove') return 'Team entry removed';
					return effect.sessionRevocation === 'awaiting_activation'
						? `${effect.removedSubject.name} removed from the workspace. Session revocation is pending.`
						: `${effect.removedSubject.name} invitation removed`;
				});
			}
		}),
		vocab: Object.freeze({
			rooms: async () => (await input.vocab.rooms()).map(liveRoom),
			tracks: async () => (await input.vocab.tracks()).map(liveTrack),
			formats: async () => (await input.vocab.formats()).map(liveFormat),
			addRoom: async (name: string, capacity: number) => liveRoom(
				await input.vocab.addRoom(name, capacity)
			),
			addTrack: async (name: string) => liveTrack(await input.vocab.addTrack(name)),
			addFormat: async (name: string) => liveFormat(await input.vocab.addFormat(name)),
			removeRoom: (id: string) => vocabularyOutcome(input.vocab.removeRoom(id)),
			removeTrack: (id: string) => vocabularyOutcome(input.vocab.removeTrack(id)),
			removeFormat: (id: string) => vocabularyOutcome(input.vocab.removeFormat(id)),
			retireRoom: (id: string) => vocabularyOutcome(input.vocab.retireRoom(id)),
			retireTrack: (id: string) => vocabularyOutcome(input.vocab.retireTrack(id)),
			retireFormat: (id: string) => vocabularyOutcome(input.vocab.retireFormat(id)),
			restoreRoom: (id: string) => vocabularyOutcome(input.vocab.restoreRoom(id)),
			restoreTrack: (id: string) => vocabularyOutcome(input.vocab.restoreTrack(id)),
			restoreFormat: (id: string) => vocabularyOutcome(input.vocab.restoreFormat(id))
		}),
		fields: input.fields,
		senderIdentity: input.senderIdentity
	});
}

export function createSampleSettingsPagePort(api: SampleSettingsPageSource): SettingsPagePort {
	return Object.freeze({
		source: Object.freeze({ kind: 'sample' as const }),
		workspace: Object.freeze({ summarySnapshot: () => api.workspace.summarySnapshot() }),
		event: Object.freeze({ get: api.settings.get, update: api.settings.update }),
		team: Object.freeze({
			async members(): Promise<SettingsTeamReadResult> {
				return { kind: 'success', members: (await api.settings.members()).map(cloneMember) };
			},
			async invite(email: string, role: string): Promise<SettingsTeamActionResult> {
				const member = await api.settings.invite(email, role);
				return { ok: true, committed: true, message: `Invitation sent to ${email}`, member: cloneMember(member) };
			},
			async changeRole(id: string, role: string): Promise<SettingsTeamActionResult> {
				const outcome = await api.settings.changeRole(id, role);
				return outcome.ok
					? { ok: true, committed: true, message: `Role changed to ${role}` }
					: { ok: false, committed: false, reason: outcome.reason };
			},
			async removeMember(id: string): Promise<SettingsTeamActionResult> {
				const outcome = await api.settings.removeMember(id);
				return outcome.ok
					? { ok: true, committed: true, message: 'Team member removed', removedId: id }
					: { ok: false, committed: false, reason: outcome.reason };
			}
		}),
		vocab: api.vocab,
		fields: api.fields,
		senderIdentity: createSampleSenderIdentitySettingsPort(api.communications.senderIdentity)
	});
}
