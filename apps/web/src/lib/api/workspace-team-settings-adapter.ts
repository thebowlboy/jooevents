import {
	workspaceTeamCanonicalEmailSchema,
	workspaceTeamSubjectRefSchema
} from '@jooevents/contracts';
import type {
	WorkspaceTeamLiveApplyResult,
	WorkspaceTeamLiveClient,
	WorkspaceTeamLiveReadResult
} from './operations/workspace-team-live';
import type {
	WorkspaceTeamCommittedMutationView,
	WorkspaceTeamMemberView,
	WorkspaceTeamRoleView,
	WorkspaceTeamSafeChangeView,
	WorkspaceTeamSnapshotView
} from './view-models/workspace-team';

export type WorkspaceTeamSettingsReadResult = WorkspaceTeamLiveReadResult;

type ReadFailure = Exclude<WorkspaceTeamLiveReadResult, { readonly kind: 'success' }>;
type ApplyFailure = Exclude<WorkspaceTeamLiveApplyResult, { readonly kind: 'success' }>;

export type WorkspaceTeamSettingsCommittedEffect =
	| {
			readonly action: 'invite';
			readonly invitationStatus: 'recorded';
			readonly delivery: 'awaiting_activation';
			readonly recipientHint: string;
			readonly currentInvitation: WorkspaceTeamMemberView | null;
	  }
	| {
			readonly action: 'change_role';
			readonly before: WorkspaceTeamRoleView;
			readonly after: WorkspaceTeamRoleView;
			readonly currentSubject: WorkspaceTeamMemberView | null;
	  }
	| {
			readonly action: 'remove';
			readonly removedSubject: WorkspaceTeamMemberView;
			readonly sessionRevocation: 'not_applicable' | 'awaiting_activation';
	  };

export interface WorkspaceTeamSettingsCommittedData {
	readonly committed: WorkspaceTeamCommittedMutationView;
	readonly team: WorkspaceTeamSnapshotView;
	readonly effect: WorkspaceTeamSettingsCommittedEffect;
}

export type WorkspaceTeamSettingsMutationResult =
	| {
			readonly kind: 'success';
			readonly data: WorkspaceTeamSettingsCommittedData;
			readonly receipt: Extract<WorkspaceTeamLiveApplyResult,
				{ readonly kind: 'success' }>['receipt'];
			readonly correlationId: string;
	  }
	| {
			readonly kind: 'prepare_read_failed';
			readonly result: ReadFailure;
	  }
	| {
			readonly kind: 'committed_refresh_failed';
			readonly committed: WorkspaceTeamCommittedMutationView;
			readonly receipt: Extract<WorkspaceTeamLiveApplyResult,
				{ readonly kind: 'success' }>['receipt'];
			readonly correlationId: string;
			readonly refresh: ReadFailure;
	  }
	| {
			readonly kind: 'committed_projection_mismatch';
			readonly committed: WorkspaceTeamCommittedMutationView;
			readonly receipt: Extract<WorkspaceTeamLiveApplyResult,
				{ readonly kind: 'success' }>['receipt'];
			readonly correlationId: string;
			readonly team: WorkspaceTeamSnapshotView;
	  }
	| {
			readonly kind: 'refused';
			readonly code: 'role_unavailable' | 'subject_missing' | 'role_unchanged' | 'invalid_email';
			readonly reason: string;
	  }
	| ApplyFailure;

type ApplyOptions = Readonly<{
	idempotencyKey?: string;
	signal?: AbortSignal;
}>;

/**
 * Source-neutral Settings-facing Team seam. Its method names stay close to the
 * tuned consumer, while its result types retain the canonical delivery and
 * session-revocation facts that the legacy `Member`/`MutationOutcome` shapes lose.
 */
export interface WorkspaceTeamSettingsPort {
	readonly source: { readonly kind: 'live' };
	members(options?: { readonly signal?: AbortSignal }): Promise<WorkspaceTeamSettingsReadResult>;
	invite(
		email: string,
		role: string,
		options?: ApplyOptions
	): Promise<WorkspaceTeamSettingsMutationResult>;
	changeRole(
		id: string,
		role: string,
		options?: ApplyOptions
	): Promise<WorkspaceTeamSettingsMutationResult>;
	removeMember(
		id: string,
		options?: ApplyOptions
	): Promise<WorkspaceTeamSettingsMutationResult>;
}

function defaultIdempotencyKey(): string {
	return `je.workspace-team.action.${globalThis.crypto.randomUUID()}`;
}

function normalizeEmail(email: string): string {
	return email.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function roleByName(
	snapshot: WorkspaceTeamSnapshotView,
	name: string
): WorkspaceTeamRoleView | undefined {
	return snapshot.roles.find((role) => role.name === name);
}

function memberById(
	snapshot: WorkspaceTeamSnapshotView,
	id: string
): WorkspaceTeamMemberView | undefined {
	return snapshot.members.find((member) => member.id === id);
}

function canonicalSubject(member: WorkspaceTeamMemberView) {
	return workspaceTeamSubjectRefSchema.parse(member.subject);
}

function roleRefusal(): Extract<WorkspaceTeamSettingsMutationResult, { readonly kind: 'refused' }> {
	return {
		kind: 'refused',
		code: 'role_unavailable',
		reason: 'That workspace role is no longer available. Reload and choose another role.'
	};
}

function subjectRefusal(): Extract<WorkspaceTeamSettingsMutationResult, { readonly kind: 'refused' }> {
	return {
		kind: 'refused',
		code: 'subject_missing',
		reason: 'That team entry is no longer present. Reload the team list.'
	};
}

function effectFor(input: {
	readonly change: WorkspaceTeamSafeChangeView;
	readonly before: WorkspaceTeamSnapshotView;
	readonly after: WorkspaceTeamSnapshotView;
	readonly email?: string;
	readonly priorSubject?: WorkspaceTeamMemberView;
}): WorkspaceTeamSettingsCommittedEffect | undefined {
	if (input.change.action === 'invite') {
		const normalized = input.email === undefined ? undefined : normalizeEmail(input.email);
		const currentInvitation = normalized === undefined
			? null
			: input.after.members.find((member) =>
				member.kind === 'invitation' && normalizeEmail(member.email) === normalized
			) ?? null;
		if (input.after.version === input.before.version + 1 && currentInvitation === null) {
			return undefined;
		}
		return Object.freeze({
			action: input.change.action,
			invitationStatus: input.change.invitationStatus,
			delivery: input.change.delivery,
			recipientHint: input.change.recipientHint,
			currentInvitation
		});
	}
	if (input.change.action === 'change_role') {
		const subjectId = input.change.subject.kind === 'member'
			? input.change.subject.membershipId
			: input.change.subject.reservationId;
		const currentSubject = memberById(input.after, subjectId) ?? null;
		if (input.after.version === input.before.version + 1
			&& (currentSubject === null || currentSubject.role.key !== input.change.after.key)) {
			return undefined;
		}
		return Object.freeze({
			action: input.change.action,
			before: input.change.before,
			after: input.change.after,
			currentSubject
		});
	}
	if (!input.priorSubject) return undefined;
	const subjectId = input.change.subject.kind === 'member'
		? input.change.subject.membershipId
		: input.change.subject.reservationId;
	if (memberById(input.after, subjectId)) return undefined;
	return Object.freeze({
		action: input.change.action,
		removedSubject: input.priorSubject,
		sessionRevocation: input.change.sessionRevocation
	});
}

/**
 * Adapts the canonical live client to Team's existing action vocabulary without
 * claiming that a recorded invitation was sent or that session revocation has
 * already completed. A commit followed by a failed refresh remains committed.
 */
export function createWorkspaceTeamSettingsPort(input: {
	readonly client: WorkspaceTeamLiveClient;
	readonly newIdempotencyKey?: () => string;
}): WorkspaceTeamSettingsPort {
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	async function prepare(
		signal?: AbortSignal
	): Promise<WorkspaceTeamSnapshotView | { readonly failure: ReadFailure }> {
		const result = await input.client.read(signal ? { signal } : {});
		return result.kind === 'success' ? result.data : { failure: result };
	}

	async function finish(inputFinish: {
		readonly applied: Extract<WorkspaceTeamLiveApplyResult, { readonly kind: 'success' }>;
		readonly before: WorkspaceTeamSnapshotView;
		readonly email?: string;
		readonly priorSubject?: WorkspaceTeamMemberView;
		readonly signal?: AbortSignal;
	}): Promise<WorkspaceTeamSettingsMutationResult> {
		const refreshed = await input.client.read(inputFinish.signal ? { signal: inputFinish.signal } : {});
		if (refreshed.kind !== 'success') {
			return {
				kind: 'committed_refresh_failed',
				committed: inputFinish.applied.data,
				receipt: inputFinish.applied.receipt,
				correlationId: inputFinish.applied.correlationId,
				refresh: refreshed
			};
		}
		const effect = effectFor({
			change: inputFinish.applied.data.change,
			before: inputFinish.before,
			after: refreshed.data,
			...(inputFinish.email === undefined ? {} : { email: inputFinish.email }),
			...(inputFinish.priorSubject === undefined
				? {}
				: { priorSubject: inputFinish.priorSubject })
		});
		if (!effect || refreshed.data.version <= inputFinish.before.version) {
			return {
				kind: 'committed_projection_mismatch',
				committed: inputFinish.applied.data,
				receipt: inputFinish.applied.receipt,
				correlationId: inputFinish.applied.correlationId,
				team: refreshed.data
			};
		}
		return {
			kind: 'success',
			data: Object.freeze({
				committed: inputFinish.applied.data,
				team: refreshed.data,
				effect
			}),
			receipt: inputFinish.applied.receipt,
			correlationId: inputFinish.applied.correlationId
		};
	}

	return Object.freeze({
		source: Object.freeze({ kind: 'live' as const }),

		members(options: { readonly signal?: AbortSignal } = {}) {
			return input.client.read(options);
		},

		async invite(
			email: string,
			roleName: string,
			options: ApplyOptions = {}
		): Promise<WorkspaceTeamSettingsMutationResult> {
			let normalized: string;
			try {
				normalized = normalizeEmail(email);
			} catch {
				return {
					kind: 'refused',
					code: 'invalid_email',
					reason: 'Enter a valid email address.'
				};
			}
			if (!workspaceTeamCanonicalEmailSchema.safeParse(normalized).success) {
				return {
					kind: 'refused',
					code: 'invalid_email',
					reason: 'Enter a valid email address.'
				};
			}
			const prepared = await prepare(options.signal);
			if ('failure' in prepared) return { kind: 'prepare_read_failed', result: prepared.failure };
			const role = roleByName(prepared, roleName);
			if (!role) return roleRefusal();
			const applied = await input.client.apply({
				action: 'invite',
				input: {
					email: normalized,
					roleKey: role.key,
					expectedTeamVersion: prepared.version,
					expectedTeamDigestSha256: prepared.digestSha256
				}
			}, options.idempotencyKey ?? newIdempotencyKey(),
			options.signal ? { signal: options.signal } : {});
			return applied.kind === 'success'
				? finish({ applied, before: prepared, email: normalized,
					...(options.signal ? { signal: options.signal } : {}) })
				: applied;
		},

		async changeRole(
			id: string,
			roleName: string,
			options: ApplyOptions = {}
		): Promise<WorkspaceTeamSettingsMutationResult> {
			const prepared = await prepare(options.signal);
			if ('failure' in prepared) return { kind: 'prepare_read_failed', result: prepared.failure };
			const subject = memberById(prepared, id);
			if (!subject) return subjectRefusal();
			const role = roleByName(prepared, roleName);
			if (!role) return roleRefusal();
			if (subject.role.key === role.key) {
				return {
					kind: 'refused',
					code: 'role_unchanged',
					reason: `${subject.name} already has that role.`
				};
			}
			const applied = await input.client.apply({
				action: 'change_role',
				input: {
					subject: canonicalSubject(subject),
					roleKey: role.key,
					expectedTeamVersion: prepared.version,
					expectedTeamDigestSha256: prepared.digestSha256
				}
			}, options.idempotencyKey ?? newIdempotencyKey(),
			options.signal ? { signal: options.signal } : {});
			return applied.kind === 'success'
				? finish({ applied, before: prepared, priorSubject: subject,
					...(options.signal ? { signal: options.signal } : {}) })
				: applied;
		},

		async removeMember(
			id: string,
			options: ApplyOptions = {}
		): Promise<WorkspaceTeamSettingsMutationResult> {
			const prepared = await prepare(options.signal);
			if ('failure' in prepared) return { kind: 'prepare_read_failed', result: prepared.failure };
			const subject = memberById(prepared, id);
			if (!subject) return subjectRefusal();
			const applied = await input.client.apply({
				action: 'remove',
				input: {
					subject: canonicalSubject(subject),
					expectedTeamVersion: prepared.version,
					expectedTeamDigestSha256: prepared.digestSha256
				}
			}, options.idempotencyKey ?? newIdempotencyKey(),
			options.signal ? { signal: options.signal } : {});
			return applied.kind === 'success'
				? finish({ applied, before: prepared, priorSubject: subject,
					...(options.signal ? { signal: options.signal } : {}) })
				: applied;
		}
	});
}
