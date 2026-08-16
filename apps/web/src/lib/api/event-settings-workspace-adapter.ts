import {
	eventSettingsUpdateInputSchema,
	type EventSettingsUpdateInput,
	type StructuredOutcome
} from '@jooevents/contracts';
import type {
	EventSettingsLiveReadResult,
	EventSettingsLiveClient,
	EventSettingsLiveUpdateResult
} from './operations/event-settings-live';
import type { SettingsPageEventPort } from './settings-page-port';
import type { EventSettings } from './types';
import type { EventSettingsView } from './view-models/event-settings';

export type WorkspaceEventSettingsApi = SettingsPageEventPort;

type AdapterFailure = Readonly<{ code: string; reason: string }>;

/** A safe, reviewed-copy failure from the source-neutral adapter boundary. */
export class EventSettingsWorkspaceAdapterError extends Error {
	readonly code: string;

	constructor(failure: AdapterFailure) {
		super(failure.reason);
		this.name = 'EventSettingsWorkspaceAdapterError';
		this.code = failure.code;
	}
}

function detailCode(outcome: StructuredOutcome): string | undefined {
	if (typeof outcome.detail !== 'object' || outcome.detail === null) return undefined;
	const code = (outcome.detail as { readonly code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function isEventRequired(outcome: StructuredOutcome): boolean {
	return outcome.class === 'conflict' && outcome.kind === 'event.settings.event_required';
}

function outcomeFailure(outcome: StructuredOutcome): AdapterFailure {
	const code = detailCode(outcome);
	if (outcome.class === 'stale_revision'
		|| code === 'selection_changed'
		|| code === 'stale_event_set'
		|| code === 'stale_event'
		|| code === 'settings_changed'
		|| code === 'policy_changed') {
		return {
			code: outcome.kind,
			reason: 'Event settings changed while you were working. Reload and try again.'
		};
	}
	if (outcome.class === 'access_denied') {
		return { code: outcome.kind, reason: 'You no longer have permission to change event settings.' };
	}
	if (outcome.class === 'idempotency_conflict') {
		return {
			code: outcome.kind,
			reason: 'This save changed before it finished. Reload and try it again.'
		};
	}
	return { code: outcome.kind, reason: 'This event-settings change could not be applied.' };
}

function readFailure(
	result: Exclude<EventSettingsLiveReadResult, { readonly kind: 'success' | 'outcome' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return { code: result.reason, reason: 'Event settings are not available in this live workspace.' };
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'Event settings could not be reached. Try again.'
			: 'This event-settings request is not valid.'
	};
}

function updateFailure(
	result: Exclude<EventSettingsLiveUpdateResult, { readonly kind: 'success' | 'outcome' }>
): AdapterFailure {
	if (result.kind === 'unavailable') {
		return {
			code: result.reason,
			reason: 'Event-settings changes are not available in this live workspace.'
		};
	}
	return {
		code: result.error.code,
		reason: result.error.retryable
			? 'The event-settings change could not be confirmed. Try again.'
			: 'This event-settings change is not valid.'
	};
}

function workspaceSettings(view: EventSettingsView): EventSettings {
	return {
		name: view.name,
		dates: view.dates,
		startDate: view.startDate,
		endDate: view.endDate,
		location: view.location,
		timezone: view.timezone,
		venueNote: view.venueNote,
		dayStart: view.dayStart,
		dayEnd: view.dayEnd,
		slotMinutes: view.slotMinutes
	};
}

function sameAuthoredValues(current: EventSettingsView, request: EventSettingsUpdateInput): boolean {
	return current.name === request.name
		&& current.timezone === request.timezone
		&& current.startDate === request.startDate
		&& current.endDate === request.endDate
		&& current.location === request.location
		&& current.venueNote === request.venueNote
		&& current.dayStart === request.dayStart
		&& current.dayEnd === request.dayEnd
		&& current.slotMinutes === request.slotMinutes;
}

function defaultIdempotencyKey(): string {
	return `je.event-settings.action.${globalThis.crypto.randomUUID()}`;
}

const authoredKeys = new Set<keyof EventSettings>([
	'name', 'timezone', 'startDate', 'endDate', 'location', 'venueNote',
	'dayStart', 'dayEnd', 'slotMinutes'
]);

/**
 * Implements only the Event identity methods of the broader workspace settings
 * contract. Team access, vocabularies, fields, and public indexing have their
 * own capability owners.
 */
export function createEventSettingsWorkspaceAdapter(input: {
	readonly client: EventSettingsLiveClient;
	readonly newIdempotencyKey?: () => string;
}): WorkspaceEventSettingsApi {
	const newIdempotencyKey = input.newIdempotencyKey ?? defaultIdempotencyKey;

	async function readCurrent(): Promise<EventSettingsView | null> {
		const result = await input.client.read();
		if (result.kind === 'success') return result.data;
		if (result.kind === 'outcome' && isEventRequired(result.outcome)) return null;
		if (result.kind === 'outcome') {
			throw new EventSettingsWorkspaceAdapterError(outcomeFailure(result.outcome));
		}
		throw new EventSettingsWorkspaceAdapterError(readFailure(result));
	}

	return Object.freeze({
		async get(): Promise<EventSettings | null> {
			const current = await readCurrent();
			return current ? workspaceSettings(current) : null;
		},

		async update(patch: Partial<EventSettings>): Promise<EventSettings | null> {
			for (const key of Object.keys(patch) as (keyof EventSettings)[]) {
				if (!authoredKeys.has(key)) {
					throw new EventSettingsWorkspaceAdapterError({
						code: 'event_settings_field_not_supported',
						reason: key === 'publicIndexing'
							? 'Public indexing is not available in this live workspace yet.'
							: 'That event setting is derived and cannot be changed here.'
					});
				}
			}

			const current = await readCurrent();
			if (!current) return null;
			// The geometry triple accepts explicit null (clear the grid), so its
			// merge distinguishes an absent patch key from an authored null.
			const parsed = eventSettingsUpdateInputSchema.safeParse({
				expectedEventId: current.eventId,
				expectedEventSetVersion: current.eventSetVersion,
				expectedEventVersion: current.eventVersion,
				name: patch.name ?? current.name,
				timezone: patch.timezone ?? current.timezone,
				startDate: patch.startDate ?? current.startDate,
				endDate: patch.endDate ?? current.endDate,
				location: patch.location ?? current.location,
				venueNote: patch.venueNote ?? current.venueNote,
				dayStart: Object.hasOwn(patch, 'dayStart') ? patch.dayStart ?? null : current.dayStart,
				dayEnd: Object.hasOwn(patch, 'dayEnd') ? patch.dayEnd ?? null : current.dayEnd,
				slotMinutes: Object.hasOwn(patch, 'slotMinutes')
					? patch.slotMinutes ?? null
					: current.slotMinutes
			});
			if (!parsed.success) {
				throw new EventSettingsWorkspaceAdapterError({
					code: 'invalid_request',
					reason: 'Review the event details and try saving again.'
				});
			}
			if (sameAuthoredValues(current, parsed.data)) return workspaceSettings(current);

			const result = await input.client.update(parsed.data, newIdempotencyKey());
			if (result.kind === 'success') return workspaceSettings(result.data.settings);
			if (result.kind === 'outcome' && isEventRequired(result.outcome)) return null;
			if (result.kind === 'outcome') {
				throw new EventSettingsWorkspaceAdapterError(outcomeFailure(result.outcome));
			}
			throw new EventSettingsWorkspaceAdapterError(updateFailure(result));
		}
	});
}
