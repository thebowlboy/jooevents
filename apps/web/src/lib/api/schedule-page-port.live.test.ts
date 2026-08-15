import { describe, expect, test } from 'bun:test';
import {
	committedChangesetOperationResultSchema,
	deriveProgramTrackAccent,
	programVocabularySnapshotSchema,
	proposedChangesetOperationResultSchema,
	safeOperationManifestSchema,
	type OperationEffect,
	type ReleaseOverviewDto,
	type SafeOperationManifest,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import {
	SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS,
	schedulePlacementDraftOperationResultSchema,
	schedulePlacementReadResultSchema
} from '@jooevents/contracts/schedule-placement';
import {
	SESSION_OPERATION_SCHEMA_REFS,
	sessionCatalogReadResultSchema,
	sessionDraftOperationResultSchema,
	type SessionHeadDto
} from '@jooevents/contracts/sessions';
import { programGrouping } from '$lib/features/schedule/program-roundup';
import { CHANGESET_REVIEW_OPERATIONS } from './changesets/live';
import { mapProgramVocabularySnapshot } from './mappers/program-vocabulary';
import type { ExpectedOperatorHttpOperation } from './operations/operator-http-binding';
import {
	createSchedulePlacementLivePort,
	SCHEDULE_PLACEMENT_LIVE_OPERATIONS
} from './operations/schedule-placement-live';
import {
	createSessionCatalogLivePort,
	SESSION_CATALOG_LIVE_OPERATIONS
} from './operations/session-catalog-live';
import type { ProgramVocabularySettingsPort } from './program-vocabulary-settings-adapter';
import {
	createLiveSchedulePagePort,
	deriveScheduleGeometry,
	SchedulePageLiveError,
	type ScheduleGeometrySettingsSource,
	type ScheduleProposalCountsReadResult,
	type ScheduleProposalCountsSource
} from './schedule-page-port.live';
import type { EventSettings } from './types';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const correlationId = id(900);

const scope = Object.freeze({ workspaceId: id(1), eventId: id(2) });
const roomId = id(3);
const trackId = id(11);
const formatId = id(10);

// ---------------------------------------------------------------------------
// Canonical fixtures, all parsed by the same executable schemas the HTTP
// boundary uses.

function head(value: number, overrides: Partial<SessionHeadDto> = {}): SessionHeadDto {
	return {
		schemaVersion: 1,
		scope,
		id: id(value),
		title: 'Opening keynote',
		plannedDurationMinutes: 45,
		lifecycle: 'programmed',
		programTarget: {
			setVersion: 3,
			setDigestSha256: digest('b'),
			format: { kind: 'format', id: formatId, name: 'Talk', status: 'active', version: 1 },
			track: null
		},
		roster: { version: 1, digestSha256: digest('c'), participants: [] },
		version: 1,
		digestSha256: digest('d'),
		createdByUserId: id(90),
		createdAt: '2026-08-01T09:00:00.000Z',
		updatedByUserId: id(90),
		updatedAt: '2026-08-01T09:00:00.000Z',
		...overrides
	};
}

const collectingHead = head(21, {
	id: id(21),
	title: 'Community lightning talks',
	lifecycle: 'collecting',
	plannedDurationMinutes: 30,
	programTarget: {
		setVersion: 3,
		setDigestSha256: digest('b'),
		format: { kind: 'format', id: formatId, name: 'Talk', status: 'active', version: 1 },
		track: { kind: 'track', id: trackId, name: 'Product', accent: 'sea', status: 'active', version: 1 }
	}
});

function catalogData() {
	return {
		schemaVersion: 1,
		scope,
		version: 7,
		digestSha256: digest('e'),
		sessions: [head(20), collectingHead]
	};
}

const placedOccurrence = Object.freeze({
	id: id(5),
	sessionId: id(20),
	roomId,
	startAt: '2026-09-01T09:00:00.000Z',
	endAt: '2026-09-01T09:45:00.000Z',
	version: 1
});

const vocabularySnapshot = mapProgramVocabularySnapshot(
	programVocabularySnapshotSchema.parse({
		schemaVersion: 1,
		scope,
		setVersion: 3,
		rooms: [{
			kind: 'room',
			id: roomId,
			name: 'Main hall',
			status: 'active',
			version: 1,
			usage: { current: 0, historicalPins: 0 },
			deleteEligibility: { kind: 'eligible' },
			capacity: 120
		}],
		tracks: [{
			kind: 'track',
			id: trackId,
			name: 'Product',
			status: 'active',
			version: 1,
			usage: { current: 0, historicalPins: 0 },
			deleteEligibility: { kind: 'eligible' },
			accent: deriveProgramTrackAccent(trackId)
		}],
		formats: [{
			kind: 'format',
			id: formatId,
			name: 'Talk',
			status: 'active',
			version: 1,
			usage: { current: 0, historicalPins: 0 },
			deleteEligibility: { kind: 'eligible' }
		}]
	})
);

function fakeVocabulary(input: {
	readonly source?: { readonly kind: 'live' } | { readonly kind: 'sample'; readonly label: string; readonly resettable: true };
	readonly onAddRoom?: (name: string, capacity: number | null) => void;
} = {}): ProgramVocabularySettingsPort {
	const notExercised = async (): Promise<never> => {
		throw new Error('not exercised');
	};
	return {
		source: input.source ?? { kind: 'live' },
		read: async () => ({ kind: 'success', data: vocabularySnapshot, correlationId }),
		rooms: async () => [...vocabularySnapshot.rooms],
		tracks: async () => [...vocabularySnapshot.tracks],
		formats: async () => [...vocabularySnapshot.formats],
		apply: notExercised,
		addRoom: async (name, capacity) => {
			input.onAddRoom?.(name, capacity);
			return {
				kind: 'room',
				id: id(70),
				name,
				status: 'active',
				version: 1,
				usage: { currentReferences: 0, historicalPins: 0 },
				deleteAvailability: { kind: 'available' },
				capacity
			};
		},
		addTrack: async (name) => ({
			kind: 'track',
			id: id(71),
			name,
			status: 'active',
			version: 1,
			usage: { currentReferences: 0, historicalPins: 0 },
			deleteAvailability: { kind: 'available' },
			accent: deriveProgramTrackAccent(id(71))
		}),
		addFormat: async (name) => ({
			kind: 'format',
			id: id(72),
			name,
			status: 'active',
			version: 1,
			usage: { currentReferences: 0, historicalPins: 0 },
			deleteAvailability: { kind: 'available' }
		}),
		editRoom: notExercised,
		editTrack: notExercised,
		editFormat: notExercised,
		removeRoom: async () => ({
			ok: false,
			reason: 'This entry still has current references or historical pins. Retire or merge it instead.',
			failure: { kind: 'refused', code: 'item_not_found', reason: 'refused for test' }
		}),
		removeTrack: notExercised,
		removeFormat: notExercised,
		retireRoom: notExercised,
		retireTrack: notExercised,
		retireFormat: notExercised,
		restoreRoom: notExercised,
		restoreTrack: notExercised,
		restoreFormat: notExercised,
		mergeRoom: notExercised,
		mergeTrack: notExercised,
		mergeFormat: notExercised
	};
}

/**
 * A counts owner whose record is its own honest claim: the default serves
 * "zero open proposals anywhere", which is a counted total here, never the
 * port's invention.
 */
function fakeProposalCounts(input: {
	readonly source?: ScheduleProposalCountsSource['source'];
	readonly result?: ScheduleProposalCountsReadResult;
} = {}): ScheduleProposalCountsSource {
	return {
		source: input.source ?? { kind: 'live' },
		readOpenProposalCounts: async () => input.result ?? { kind: 'success', data: {} }
	};
}

// ---------------------------------------------------------------------------
// One exact manifest carrying every operation this composition binds.

type OperationKey =
	| 'sessionCatalog'
	| 'sessionDraft'
	| 'placementSnapshot'
	| 'placementDraft'
	| 'propose'
	| 'commit';

const pathByOperation: Readonly<Record<OperationKey, string>> = Object.freeze({
	sessionCatalog: SESSION_CATALOG_LIVE_OPERATIONS.catalog.path,
	sessionDraft: SESSION_CATALOG_LIVE_OPERATIONS.draft.path,
	placementSnapshot: SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot.path,
	placementDraft: SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.path,
	propose: '/api/changesets/proposals',
	commit: '/api/changesets/commits'
});

function expected(key: OperationKey): ExpectedOperatorHttpOperation {
	switch (key) {
		case 'sessionCatalog':
			return {
				...SESSION_CATALOG_LIVE_OPERATIONS.catalog,
				...SESSION_OPERATION_SCHEMA_REFS.catalogRead
			};
		case 'sessionDraft':
			return { ...SESSION_CATALOG_LIVE_OPERATIONS.draft, ...SESSION_OPERATION_SCHEMA_REFS.draft };
		case 'placementSnapshot':
			return {
				...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.snapshot,
				...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.snapshotRead
			};
		case 'placementDraft':
			return {
				...SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft,
				...SCHEDULE_PLACEMENT_OPERATION_SCHEMA_REFS.placementDraft
			};
		default:
			return CHANGESET_REVIEW_OPERATIONS[key];
	}
}

function manifestEntry(key: OperationKey): SafeOperationManifestEntry {
	const operation = expected(key);
	const effect = operation.effect as OperationEffect;
	return {
		name: operation.name,
		version: operation.version,
		lifecycle: { status: 'active' },
		summary: `Execute ${operation.name}.`,
		effect,
		maxRisk: effect === 'commit' ? 'normal' : 'low',
		autonomy: {
			policy: { key: `autonomy.${operation.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'low',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'block',
				approval_required: 'block',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: [],
		inputSchema: operation.inputSchema,
		idempotency: operation.idempotencyRequired
			? {
					required: true,
					keySource: { key: 'idempotency.operator-header', version: 1 },
					credentialVerifierProfile: { key: 'credential.schedule', version: 1 },
					requestHashProfile: { key: 'request-hash.schedule', version: 1 }
			  }
			: { required: false },
		concurrency: effect === 'read'
			? { kind: 'read_snapshot' }
			: { kind: 'registered', definition: { key: `concurrency.${operation.name}`, version: 1 } },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http',
			protocol: 'http',
			method: operation.method,
			path: pathByOperation[key],
			input: operation.input,
			resultSchema: operation.resultSchema,
			browserResumption: { kind: 'none' }
		}]
	};
}

function manifest(): SafeOperationManifest {
	const keys: readonly OperationKey[] = [
		'sessionCatalog',
		'sessionDraft',
		'placementSnapshot',
		'placementDraft',
		'propose',
		'commit'
	];
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('f'),
		operations: keys.map((key) => manifestEntry(key))
	});
}

const fullRangePath = `${pathByOperation.placementSnapshot}?${new URLSearchParams({
	startAt: '1970-01-01T00:00:00.000Z',
	endAt: '9999-12-31T23:59:59.999Z',
	limit: '2000'
}).toString()}`;

const receipt = (value: number, operationName: string) => ({
	id: id(value), operationName, operationVersion: 1
});

function readPayloads() {
	return {
		[pathByOperation.sessionCatalog]: sessionCatalogReadResultSchema.parse({
			kind: 'success',
			data: catalogData(),
			correlationId
		}),
		[fullRangePath]: schedulePlacementReadResultSchema.parse({
			kind: 'success',
			data: { schemaVersion: 1, scope, scheduleVersion: 4, occurrences: [placedOccurrence] },
			correlationId
		})
	};
}

const approvalPolicy = Object.freeze({
	reference: { key: 'policy.session.change.bounded', version: 1 },
	definitionDigestSha256: digest('a'),
	requirement: 'none' as const
});

interface RecordedRequest {
	readonly path: string;
	readonly body?: unknown;
	readonly idempotencyKey?: string;
}

/**
 * Composed settings source. Defaults to the served "no event yet" absence,
 * which derives the honest no-grid state the earlier assertions pin.
 */
function fakeSettings(settings: EventSettings | null = null): ScheduleGeometrySettingsSource {
	return { get: async () => settings };
}

function fakePublication(overrides: Partial<ReleaseOverviewDto> = {}) {
	return {
		async overview(): Promise<ReleaseOverviewDto> {
			return {
				schemaVersion: 1,
				scope,
				currentProgramRelease: null,
				currentStyleSetRelease: null,
				surfaceHeads: [],
				activeSurfaceReleases: [],
				...overrides
			};
		}
	};
}

/** A complete, coherent served geometry for the grid-rendering tests. */
function geometrySettings(overrides: Partial<EventSettings> = {}): EventSettings {
	return {
		name: 'Joined Event',
		dates: 'May 4–5, 2027',
		startDate: '2027-05-04',
		endDate: '2027-05-05',
		location: 'Helsinki',
		// A UTC event on purpose: these cases pin the day-window arithmetic, so
		// they read wall clock and canonical instant as the same numbers. The
		// event-local basis (`dayStart` is wall clock, the instant is UTC) is
		// pinned separately below, against a real offset.
		timezone: 'UTC',
		venueNote: '',
		dayStart: '09:00',
		dayEnd: '18:00',
		slotMinutes: 30,
		...overrides
	};
}

function composePort(
	payloads: Readonly<Record<string, unknown>>,
	calls: RecordedRequest[],
	proposals: ScheduleProposalCountsSource = fakeProposalCounts(),
	settings: ScheduleGeometrySettingsSource = fakeSettings()
) {
	const shared = manifest();
	const request = async (input: RecordedRequest) => {
		calls.push(input);
		return { kind: 'success' as const, data: payloads[input.path] };
	};
	return createLiveSchedulePagePort({
		placements: createSchedulePlacementLivePort({ manifest: shared, request }),
		sessions: createSessionCatalogLivePort({ manifest: shared, request }),
		vocabulary: fakeVocabulary(),
		proposals,
		settings,
		publication: fakePublication()
	});
}

describe('live tuned Schedule page port', () => {
	test('refuses composition when any composed source is not live', () => {
		const shared = manifest();
		const live = {
			placements: createSchedulePlacementLivePort({ manifest: shared }),
			sessions: createSessionCatalogLivePort({ manifest: shared }),
			proposals: fakeProposalCounts(),
			settings: fakeSettings(),
			publication: fakePublication()
		};
		expect(() =>
			createLiveSchedulePagePort({
				...live,
				vocabulary: fakeVocabulary({
					source: { kind: 'sample', label: 'Sample data', resettable: true }
				})
			})
		).toThrow(new TypeError('live_schedule_source_required'));
		expect(() =>
			createLiveSchedulePagePort({
				...live,
				sessions: {
					...live.sessions,
					source: {
						kind: 'sample',
						label: 'Sample data',
						scenario: { key: 'k', name: 'n', description: 'd' }
					}
				},
				vocabulary: fakeVocabulary()
			})
		).toThrow(new TypeError('live_schedule_source_required'));
		expect(() =>
			createLiveSchedulePagePort({
				...live,
				vocabulary: fakeVocabulary(),
				proposals: fakeProposalCounts({ source: { kind: 'sample', label: 'Sample data' } })
			})
		).toThrow(new TypeError('live_schedule_source_required'));
	});

	test('serves canonical state: sessions by identity, UTC-day placements, and no invented geometry', async () => {
		const calls: RecordedRequest[] = [];
		const port = composePort(readPayloads(), calls);
		const state = await port.schedule.state();

		// No canonical Event day geometry owner has joined: no days, no grid.
		expect(state.days).toEqual([]);
		expect(state.slotsPerDay).toBe(0);
		expect(state.dayStart).toBe('00:00');
		expect(state.breaks).toEqual([]);
		expect(state.published).toBe(false);

		expect(state.rooms).toEqual([{
			id: roomId,
			name: 'Main hall',
			capacity: 120,
			status: 'active',
			usage: { currentReferences: 0, historicalPins: 0 }
		}]);
		expect(state.sessions).toEqual([
			{
				id: id(20),
				title: 'Opening keynote',
				speakers: [],
				trackId: '',
				formatId,
				durationMin: 45,
				state: 'programmed'
			},
			{
				id: id(21),
				title: 'Community lightning talks',
				speakers: [],
				trackId,
				formatId,
				durationMin: 30,
				state: 'collecting'
			}
		]);
		// The placed session stays truthfully placed, keyed by its own UTC day.
		expect(state.placements).toEqual([{
			sessionId: id(20),
			dayKey: '2026-09-01',
			roomId,
			startMin: 540,
			conflicts: []
		}]);
		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.sessionCatalog,
			fullRangePath
		]);
	});

	test('derives the grid from the served settings trio and re-keys placements to the day window', async () => {
		const port = composePort(readPayloads(), [], fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02' })
		));
		const state = await port.schedule.state();
		expect(state.days).toEqual([
			{ key: '2026-09-01', label: 'Tue Sep 1' },
			{ key: '2026-09-02', label: 'Wed Sep 2' }
		]);
		expect(state.dayStart).toBe('09:00');
		expect(state.slotMinutes).toBe(30);
		expect(state.slotsPerDay).toBe(18);
		// The 09:00Z occurrence is slot zero of a 09:00 day window.
		expect(state.placements).toEqual([{
			sessionId: id(20),
			dayKey: '2026-09-01',
			roomId,
			startMin: 0,
			conflicts: []
		}]);
	});

	test('a placement outside the derived day list or window serves the honest no-grid state', async () => {
		// The served occurrence lands on 2026-09-01; an event whose dates do not
		// contain that day cannot truthfully draw a grid around it.
		const outsideDays = composePort(readPayloads(), [], fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-02', endDate: '2026-09-03' })
		));
		const dayMismatch = await outsideDays.schedule.state();
		expect(dayMismatch.days).toEqual([]);
		expect(dayMismatch.slotsPerDay).toBe(0);
		expect(dayMismatch.dayStart).toBe('00:00');
		// Placements stay truthfully placed on their UTC day keys either way.
		expect(dayMismatch.placements[0]).toMatchObject({ dayKey: '2026-09-01', startMin: 540 });

		// The occurrence starts 09:00Z; a 10:00 day window cannot draw it either.
		const outsideWindow = composePort(readPayloads(), [], fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02', dayStart: '10:00' })
		));
		expect((await outsideWindow.schedule.state()).days).toEqual([]);
	});

	test('an incomplete or incoherent trio serves the honest no-grid state', () => {
		const occurrences = [
			{ startAtUtc: '2026-09-01T09:00:00.000Z', endAtUtc: '2026-09-01T09:45:00.000Z' }
		];
		// Null trio member.
		expect(deriveScheduleGeometry({
			settings: geometrySettings({ slotMinutes: null }),
			occurrences
		}).localCalendarReady).toBe(false);
		// Window not divisible by the slot length.
		expect(deriveScheduleGeometry({
			settings: geometrySettings({ dayEnd: '18:10' }),
			occurrences
		}).localCalendarReady).toBe(false);
		// Inverted window.
		expect(deriveScheduleGeometry({
			settings: geometrySettings({ dayStart: '18:00', dayEnd: '09:00' }),
			occurrences
		}).localCalendarReady).toBe(false);
		// No settings at all (no current event).
		expect(deriveScheduleGeometry({ settings: null, occurrences }).localCalendarReady)
			.toBe(false);
		// A pathological range renders no grid rather than thousands of columns.
		expect(deriveScheduleGeometry({
			settings: geometrySettings({ startDate: '2026-09-01', endDate: '2036-09-01' }),
			occurrences: []
		}).localCalendarReady).toBe(false);
		// The complete, reconciling shape flips the gate.
		const ready = deriveScheduleGeometry({
			settings: geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-01' }),
			occurrences
		});
		expect(ready.localCalendarReady).toBe(true);
		expect(ready.days).toEqual([{ key: '2026-09-01', label: 'Tue Sep 1' }]);
		expect(ready.dayStartMin).toBe(540);
		expect(ready.slotsPerDay).toBe(18);
	});

	test('place restores the day-window offset when minting the canonical instant', async () => {
		const startAt = '2026-09-02T10:00:00.000Z';
		const endAt = '2026-09-02T10:30:00.000Z';
		const placedId = id(6);
		const servedTrios: (EventSettings | null)[] = [
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02' }),
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02', dayStart: '08:00' })
		];
		const plan = {
			input: {
				action: 'place',
				expectedScheduleVersion: 4,
				sessionId: id(21),
				roomId,
				startAt,
				endAt,
				scope,
				occurrenceId: placedId
			},
			before: null,
			after: { id: placedId, sessionId: id(21), roomId, startAt, endAt, version: 1 },
			scheduleVersion: { before: 4, after: 5 },
			roomQueryGuard: {
				id: `schedule_room_query:${scope.eventId}:${roomId}`,
				version: 4,
				digestSha256: digest('9')
			}
		};
		const placementApproval = {
			reference: { key: 'policy.schedule.placement.bounded', version: 1 },
			definitionDigestSha256: digest('c'),
			requirement: 'none' as const
		};
		const calls: RecordedRequest[] = [];
		const port = composePort({
			...readPayloads(),
			[pathByOperation.placementDraft]: schedulePlacementDraftOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'place',
					changesetId: id(60),
					headVersion: 1,
					status: 'draft',
					revision: { id: id(61), number: 1, digestSha256: digest('b') },
					riskTier: 'normal',
					approvalPolicy: placementApproval,
					safeDiff: plan
				},
				receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
				correlationId
			}),
			[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'propose',
					diff: {
						changesetId: id(60),
						headVersion: 2,
						status: 'proposed',
						revisionId: id(61),
						revisionNumber: 1,
						revisionDigest: digest('b'),
						riskTier: 'normal',
						approvalPolicy: placementApproval,
						operations: [{
							kind: 'schedule.placement.mutate',
							version: 1,
							riskTier: 'normal',
							dependencyGroup: 'schedule_placement',
							safeDiff: plan,
							consequences: ['schedule_occurrence_changed']
						}]
					}
				},
				receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
				correlationId
			}),
			[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'commit',
					changesetId: id(60),
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: id(61),
					revisionDigest: digest('b')
				},
				receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
				correlationId
			})
		}, calls, fakeProposalCounts(), {
			// The board renders under the 09:00 trio; by drop time the source
			// already serves 08:00. The mint must stay pinned to the geometry
			// `state()` handed the slot out in — a write-time re-derivation would
			// silently re-time the drop an hour early.
			get: async () =>
				servedTrios.length > 1
					? servedTrios.shift()!
					: servedTrios[0]!
		});

		await port.schedule.state();
		calls.length = 0;

		// Slot 60 minutes into the served 09:00 window is the same 10:00Z
		// canonical instant the midnight-based basis would call 600.
		const placement = await port.schedule.place(id(21), '2026-09-02', roomId, 60);
		expect(placement).toEqual({
			sessionId: id(21),
			dayKey: '2026-09-02',
			roomId,
			startMin: 60,
			conflicts: []
		});
		expect(calls[2]?.body).toMatchObject({ startAt, endAt });
	});

	test('creates a session through draft, propose, and commit with canonical guards', async () => {
		const createdHead = head(40, {
			id: id(40),
			title: 'Lightning round',
			plannedDurationMinutes: 30,
			lifecycle: 'collecting',
			programTarget: collectingHead.programTarget
		});
		const createDiff = { action: 'create', before: null, after: createdHead };
		const calls: RecordedRequest[] = [];
		const port = composePort({
			...readPayloads(),
			[pathByOperation.sessionDraft]: sessionDraftOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'create',
					changesetId: id(30),
					headVersion: 1,
					status: 'draft',
					revision: { id: id(31), number: 1, digestSha256: digest('f') },
					riskTier: 'normal',
					approvalPolicy,
					safeDiff: createDiff
				},
				receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
				correlationId
			}),
			[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'propose',
					diff: {
						changesetId: id(30),
						headVersion: 2,
						status: 'proposed',
						revisionId: id(31),
						revisionNumber: 1,
						revisionDigest: digest('f'),
						riskTier: 'normal',
						approvalPolicy,
						operations: [{
							kind: 'session.mutate',
							version: 1,
							riskTier: 'normal',
							dependencyGroup: 'session',
							safeDiff: createDiff,
							consequences: ['session_changed']
						}]
					}
				},
				receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
				correlationId
			}),
			[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'commit',
					changesetId: id(30),
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: id(31),
					revisionDigest: digest('f')
				},
				receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
				correlationId
			})
		}, calls);

		const created = await port.schedule.createSession({
			title: 'Lightning round',
			trackId,
			formatId,
			durationMin: 30,
			state: 'collecting'
		});
		expect(created).toEqual({
			id: id(40),
			title: 'Lightning round',
			speakers: [],
			trackId,
			formatId,
			durationMin: 30,
			state: 'collecting'
		});

		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.sessionCatalog,
			pathByOperation.sessionDraft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		// Classification travels with the fresh catalog guards; a collecting
		// session in a track-using event never relies on canonical absence.
		expect(calls[1]?.body).toEqual({
			action: 'create',
			expectedCatalogVersion: 7,
			expectedCatalogDigestSha256: digest('e'),
			title: 'Lightning round',
			plannedDurationMinutes: 30,
			lifecycle: 'collecting',
			formatId,
			trackId
		});
		expect(calls.slice(1).map((call) => call.idempotencyKey)).toEqual([
			expect.stringMatching(/^je\.session\.change\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.session\.change\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.session\.change\.commit\.[a-f0-9]{64}$/)
		]);
	});

	test('rejects never-satisfiable transitions and applies a forward one with head guards', async () => {
		const afterHead = { ...collectingHead, lifecycle: 'programmed' as const, version: 2 };
		const transitionDiff = { action: 'transition', before: collectingHead, after: afterHead };
		const calls: RecordedRequest[] = [];
		const port = composePort({
			...readPayloads(),
			[pathByOperation.sessionDraft]: sessionDraftOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'transition',
					changesetId: id(30),
					headVersion: 1,
					status: 'draft',
					revision: { id: id(31), number: 1, digestSha256: digest('f') },
					riskTier: 'normal',
					approvalPolicy,
					safeDiff: transitionDiff
				},
				receipt: receipt(100, SESSION_CATALOG_LIVE_OPERATIONS.draft.name),
				correlationId
			}),
			[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'propose',
					diff: {
						changesetId: id(30),
						headVersion: 2,
						status: 'proposed',
						revisionId: id(31),
						revisionNumber: 1,
						revisionDigest: digest('f'),
						riskTier: 'normal',
						approvalPolicy,
						operations: [{
							kind: 'session.mutate',
							version: 1,
							riskTier: 'normal',
							dependencyGroup: 'session',
							safeDiff: transitionDiff,
							consequences: ['session_changed']
						}]
					}
				},
				receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
				correlationId
			}),
			[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'commit',
					changesetId: id(30),
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: id(31),
					revisionDigest: digest('f')
				},
				receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
				correlationId
			})
		}, calls);

		// Forward-only: a target the domain can never satisfy rejects on the
		// error channel before any request leaves. A resolved refusal would let
		// the page's recorded undo — which awaits without reading the outcome —
		// retire its receipt as undone over an unchanged session.
		await expect(port.schedule.transitionSession(id(21), 'draft')).rejects.toMatchObject({
			name: 'SchedulePageLiveError',
			code: 'session_transition_backward'
		});
		expect(calls).toHaveLength(0);

		// The recorded-undo shape: a programmed session asked back to collecting
		// rejects after the head read, with no draft ever requested.
		await expect(port.schedule.transitionSession(id(20), 'collecting')).rejects.toMatchObject({
			name: 'SchedulePageLiveError',
			code: 'session_transition_backward'
		});
		expect(calls.map((call) => call.path)).toEqual([pathByOperation.sessionCatalog]);
		calls.length = 0;

		expect(await port.schedule.transitionSession(id(21), 'programmed')).toEqual({ ok: true });
		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.sessionCatalog,
			pathByOperation.sessionDraft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		expect(calls[1]?.body).toEqual({
			action: 'transition',
			expectedCatalogVersion: 7,
			expectedCatalogDigestSha256: digest('e'),
			sessionId: id(21),
			expectedSessionVersion: 1,
			expectedSessionDigestSha256: digest('d'),
			to: 'programmed'
		});

		// An unknown session refuses without drafting anything.
		calls.length = 0;
		const missing = await port.schedule.transitionSession(id(99), 'programmed');
		expect(missing.ok).toBe(false);
		expect(calls.map((call) => call.path)).toEqual([pathByOperation.sessionCatalog]);
	});

	test('places an unplaced session on a canonical UTC slot through the placement lifecycle', async () => {
		const startAt = '2026-09-02T10:00:00.000Z';
		const endAt = '2026-09-02T10:30:00.000Z';
		const placedId = id(6);
		const plan = {
			input: {
				action: 'place',
				expectedScheduleVersion: 4,
				sessionId: id(21),
				roomId,
				startAt,
				endAt,
				scope,
				occurrenceId: placedId
			},
			before: null,
			after: { id: placedId, sessionId: id(21), roomId, startAt, endAt, version: 1 },
			scheduleVersion: { before: 4, after: 5 },
			roomQueryGuard: {
				id: `schedule_room_query:${scope.eventId}:${roomId}`,
				version: 4,
				digestSha256: digest('9')
			}
		};
		const placementApproval = {
			reference: { key: 'policy.schedule.placement.bounded', version: 1 },
			definitionDigestSha256: digest('c'),
			requirement: 'none' as const
		};
		const calls: RecordedRequest[] = [];
		const port = composePort({
			...readPayloads(),
			[pathByOperation.placementDraft]: schedulePlacementDraftOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'place',
					changesetId: id(60),
					headVersion: 1,
					status: 'draft',
					revision: { id: id(61), number: 1, digestSha256: digest('b') },
					riskTier: 'normal',
					approvalPolicy: placementApproval,
					safeDiff: plan
				},
				receipt: receipt(100, SCHEDULE_PLACEMENT_LIVE_OPERATIONS.draft.name),
				correlationId
			}),
			[pathByOperation.propose]: proposedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'propose',
					diff: {
						changesetId: id(60),
						headVersion: 2,
						status: 'proposed',
						revisionId: id(61),
						revisionNumber: 1,
						revisionDigest: digest('b'),
						riskTier: 'normal',
						approvalPolicy: placementApproval,
						operations: [{
							kind: 'schedule.placement.mutate',
							version: 1,
							riskTier: 'normal',
							dependencyGroup: 'schedule_placement',
							safeDiff: plan,
							consequences: ['schedule_occurrence_changed']
						}]
					}
				},
				receipt: receipt(101, CHANGESET_REVIEW_OPERATIONS.propose.name),
				correlationId
			}),
			[pathByOperation.commit]: committedChangesetOperationResultSchema.parse({
				kind: 'success',
				data: {
					schemaVersion: 1,
					action: 'commit',
					changesetId: id(60),
					expectedHeadVersion: 2,
					committedHeadVersion: 3,
					revisionId: id(61),
					revisionDigest: digest('b')
				},
				receipt: receipt(102, CHANGESET_REVIEW_OPERATIONS.commit.name),
				correlationId
			})
		}, calls, fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02' })
		));

		// The board's slots exist only after `state()` has served the grid; the
		// pinned 09:00 window makes slot 60 the 10:00Z canonical instant.
		await port.schedule.state();
		calls.length = 0;

		const placement = await port.schedule.place(id(21), '2026-09-02', roomId, 60);
		expect(placement).toEqual({
			sessionId: id(21),
			dayKey: '2026-09-02',
			roomId,
			startMin: 60,
			conflicts: []
		});
		expect(calls.map((call) => call.path)).toEqual([
			pathByOperation.sessionCatalog,
			fullRangePath,
			pathByOperation.placementDraft,
			pathByOperation.propose,
			pathByOperation.commit
		]);
		// The slot travels as exact canonical UTC instants; the end comes from the
		// session's canonical planned duration, never from grid geometry.
		expect(calls[2]?.body).toEqual({
			action: 'place',
			expectedScheduleVersion: 4,
			sessionId: id(21),
			roomId,
			startAt,
			endAt
		});
		expect(calls.slice(2).map((call) => call.idempotencyKey)).toEqual([
			expect.stringMatching(/^je\.schedule\.placement\.draft\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.schedule\.placement\.propose\.[a-f0-9]{64}$/),
			expect.stringMatching(/^je\.schedule\.placement\.commit\.[a-f0-9]{64}$/)
		]);

		// A slot that is not a real canonical UTC date refuses before any request.
		calls.length = 0;
		await expect(port.schedule.place(id(21), '2026-02-31', roomId, 60)).rejects.toMatchObject({
			name: 'SchedulePageLiveError',
			code: 'invalid_slot'
		});
		expect(calls).toHaveLength(0);
	});

	test('place refuses typed when no served grid backs the slot, instead of guessing a basis', async () => {
		// No `state()` has served a grid yet: nothing can have handed out a slot,
		// so the port refuses before any request rather than minting from a
		// midnight basis the board never rendered.
		const unservedCalls: RecordedRequest[] = [];
		const unserved = composePort(readPayloads(), unservedCalls, fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02' })
		));
		await expect(unserved.schedule.place(id(21), '2026-09-02', roomId, 60)).rejects.toMatchObject({
			name: 'SchedulePageLiveError',
			code: 'schedule_geometry_unready'
		});
		expect(unservedCalls).toHaveLength(0);

		// A served no-grid state (absent trio) pins the same refusal: the honest
		// no-grid board offers no slots, so a drop cannot be re-based to midnight.
		const noGrid = composePort(readPayloads(), [], fakeProposalCounts(), fakeSettings(null));
		await noGrid.schedule.state();
		await expect(noGrid.schedule.place(id(21), '2026-09-02', roomId, 60)).rejects.toMatchObject({
			code: 'schedule_geometry_unready'
		});

		// A slot outside the pinned grid (a day the served geometry does not
		// hold, or a start beyond its window) is a stale board, never a re-mint.
		const pinnedCalls: RecordedRequest[] = [];
		const pinned = composePort(readPayloads(), pinnedCalls, fakeProposalCounts(), fakeSettings(
			geometrySettings({ startDate: '2026-09-01', endDate: '2026-09-02' })
		));
		await pinned.schedule.state();
		pinnedCalls.length = 0;
		await expect(pinned.schedule.place(id(21), '2026-09-05', roomId, 60)).rejects.toMatchObject({
			code: 'schedule_geometry_stale'
		});
		await expect(pinned.schedule.place(id(21), '2026-09-02', roomId, 540)).rejects.toMatchObject({
			code: 'schedule_geometry_stale'
		});
		expect(pinnedCalls).toHaveLength(0);
	});

	test('every unmounted capability surfaces its typed refusal or typed absence, never fake success', async () => {
		const calls: RecordedRequest[] = [];
		const port = composePort(readPayloads(), calls);

		// Synchronous loading evidence: null is "not read yet", never a guess.
		expect(port.workspace.scheduleAttentionExpectedSnapshot()).toBeNull();

		// Absence states the port can truthfully hold.
		expect(await port.schedule.sessionOrigins(id(20))).toEqual([]);
		expect(await port.speakers.list()).toEqual([]);
		expect(await port.speakers.profile('speaker@example.com')).toBeNull();
		expect(await port.templates.list()).toEqual({ surfaces: [] });

		// Typed refusals on the port's own outcome channel.
		const publish = await port.schedule.publish();
		expect(publish.ok).toBe(false);
		for (const outcome of [
			await port.schedule.removeSession(id(20)),
			await port.schedule.attachSubmission(id(20), id(50)),
			await port.schedule.detachSubmission(id(20), id(50)),
			await port.schedule.addDirectParticipant(id(20), { name: 'A', email: 'a@example.com' }),
			await port.schedule.addParticipantFromRoster(id(20), id(51)),
			await port.schedule.removeParticipant(id(20), 'a@example.com')
		]) {
			expect(outcome.ok).toBe(false);
			if (outcome.ok) throw new TypeError('Expected a typed refusal.');
			expect(outcome.reason.length).toBeGreaterThan(0);
		}

		// Channels without a refusal shape throw the typed error, never strings.
		await expect(port.schedule.unplace(id(20))).rejects.toBeInstanceOf(SchedulePageLiveError);
		await expect(
			port.schedule.addBreak({ label: 'Lunch', dayKey: '2026-09-01', roomId, startMin: 720, durationMin: 60 })
		).rejects.toMatchObject({ name: 'SchedulePageLiveError', code: 'schedule_breaks' });
		await expect(port.schedule.removeBreak(id(52))).rejects.toBeInstanceOf(SchedulePageLiveError);
		await expect(port.schedule.attachCandidates(id(20))).rejects.toMatchObject({
			code: 'session_attach'
		});

		// None of the refusals above reached the network.
		expect(calls).toHaveLength(0);
	});

	test('serves proposal totals only from the counts owner and rejects anything uncounted', async () => {
		// A counted record passes through untouched — including a counted zero,
		// which is the owner's claim, not the port's.
		const counted = composePort(readPayloads(), [], fakeProposalCounts({
			result: { kind: 'success', data: { [id(21)]: 12 } }
		}));
		expect(await counted.schedule.proposalTargets()).toEqual({ [id(21)]: 12 });

		const zero = composePort(readPayloads(), []);
		expect(await zero.schedule.proposalTargets()).toEqual({});

		// The page renders an absent key as the positive fact "no proposals
		// yet", so a source without an answer must fail the read, never serve {}.
		const unmountedCounts = composePort(readPayloads(), [], fakeProposalCounts({
			result: { kind: 'unavailable', reason: 'operation_not_registered' }
		}));
		await expect(unmountedCounts.schedule.proposalTargets()).rejects.toMatchObject({
			name: 'SchedulePageLiveError',
			code: 'operation_not_registered'
		});

		const failing = composePort(readPayloads(), [], fakeProposalCounts({
			result: { kind: 'transport_error', error: { code: 'network', retryable: true } }
		}));
		await expect(failing.schedule.proposalTargets()).rejects.toBeInstanceOf(SchedulePageLiveError);
	});

	test('serves the live vocabulary and translates the page capacity and outcome grammars', async () => {
		let receivedCapacity: number | null | undefined;
		const shared = manifest();
		const port = createLiveSchedulePagePort({
			placements: createSchedulePlacementLivePort({ manifest: shared }),
			sessions: createSessionCatalogLivePort({ manifest: shared }),
			vocabulary: fakeVocabulary({ onAddRoom: (_name, capacity) => (receivedCapacity = capacity) }),
			proposals: fakeProposalCounts(),
			settings: fakeSettings(),
			publication: fakePublication()
		});

		expect(await port.vocab.tracks()).toEqual([{
			id: trackId,
			name: 'Product',
			accent: deriveProgramTrackAccent(trackId),
			status: 'active',
			usage: { currentReferences: 0, historicalPins: 0 }
		}]);
		expect(await port.vocab.formats()).toEqual([{
			id: formatId,
			name: 'Talk',
			status: 'active',
			usage: { currentReferences: 0, historicalPins: 0 }
		}]);

		// The page's "capacity 0" means unset; canonically that is null, never zero.
		const room = await port.vocab.addRoom('Workshop room', 0);
		expect(receivedCapacity).toBeNull();
		expect(room.capacity).toBeNull();

		const track = await port.vocab.addTrack('AI');
		expect(track).toMatchObject({ id: id(71), name: 'AI' });
		const format = await port.vocab.addFormat('Panel');
		expect(format).toMatchObject({ id: id(72), name: 'Panel' });

		const removal = await port.vocab.removeRoom(roomId);
		expect(removal.ok).toBe(false);
		if (removal.ok) throw new TypeError('Expected a refusal.');
		expect(removal.reason).toContain('Retire or merge');
	});
});

// ---------------------------------------------------------------------------
// The event's own clock. Regression cover for the JooCon 2027 playground, where
// a Europe/Berlin event with three committed placements served an empty day
// list: `dayStart`/`dayEnd` are event-local wall clock, the canonical instant is
// UTC, and comparing the two directly refused the grid for every event outside
// UTC. Payloads below are the bytes a seeded live runtime actually served.

/** Verbatim `/api/events/current/settings` data from the seeded playground. */
function jooconSettings(overrides: Partial<EventSettings> = {}): EventSettings {
	return {
		name: 'JooCon 2027',
		dates: 'September 15–17, 2027',
		startDate: '2027-09-15',
		endDate: '2027-09-17',
		location: 'Kulturbrauerei, Berlin',
		timezone: 'Europe/Berlin',
		venueNote: '',
		dayStart: '09:00',
		dayEnd: '18:00',
		slotMinutes: 15,
		...overrides
	};
}

/**
 * Verbatim occurrences from the same runtime: 09:30, 10:30 and 11:30 Berlin
 * on day one, which are 07:30Z, 08:30Z and 09:30Z.
 */
const jooconOccurrences = Object.freeze([
	Object.freeze({ startAtUtc: '2027-09-15T07:30:00.000Z', endAtUtc: '2027-09-15T08:15:00.000Z' }),
	Object.freeze({ startAtUtc: '2027-09-15T08:30:00.000Z', endAtUtc: '2027-09-15T09:15:00.000Z' }),
	Object.freeze({ startAtUtc: '2027-09-15T09:30:00.000Z', endAtUtc: '2027-09-15T10:15:00.000Z' })
]);

describe('live tuned Schedule page geometry on the event’s own clock', () => {
	test('draws the grid for a non-UTC event whose placements sit inside its local day window', () => {
		const geometry = deriveScheduleGeometry({
			settings: jooconSettings(),
			occurrences: jooconOccurrences
		});

		// Before the basis fix this served NO_GRID_GEOMETRY: 07:30Z read as 450
		// minutes, "before" the 540-minute day start, and the board rendered
		// "Nothing is scheduled yet" over three committed placements.
		expect(geometry.localCalendarReady).toBe(true);
		expect(geometry.timeZone).toBe('Europe/Berlin');
		expect(geometry.days).toEqual([
			{ key: '2027-09-15', label: 'Wed Sep 15' },
			{ key: '2027-09-16', label: 'Thu Sep 16' },
			{ key: '2027-09-17', label: 'Fri Sep 17' }
		]);
		expect(geometry.slotsPerDay).toBe(36);
	});

	test('places the cards on their event-local rows, not their UTC ones', async () => {
		const berlinOccurrence = {
			id: id(5),
			sessionId: id(20),
			roomId,
			startAt: '2027-09-15T07:30:00.000Z',
			endAt: '2027-09-15T08:15:00.000Z',
			version: 1
		};
		const payloads = {
			[pathByOperation.sessionCatalog]: sessionCatalogReadResultSchema.parse({
				kind: 'success', data: catalogData(), correlationId
			}),
			[fullRangePath]: schedulePlacementReadResultSchema.parse({
				kind: 'success',
				data: { schemaVersion: 1, scope, scheduleVersion: 4, occurrences: [berlinOccurrence] },
				correlationId
			})
		};
		const port = composePort(payloads, [], fakeProposalCounts(), fakeSettings(jooconSettings()));
		const state = await port.schedule.state();

		expect(state.days).toHaveLength(3);
		// 09:30 Berlin is 30 minutes into a 09:00 day window — two 15-minute rows
		// down, never the −90 the raw UTC clock would have produced.
		expect(state.placements).toEqual([{
			sessionId: id(20),
			dayKey: '2027-09-15',
			roomId,
			startMin: 30,
			conflicts: []
		}]);
	});

	test('the served board offers a placeable row and a grid to place it on', async () => {
		// The playground's shape: one session already holding a slot, one
		// programmed session still unplaced. The page's own predicate — a row is
		// placeable while it holds no slot and is not a draft — must find the
		// second, and `boardReady` (rooms and days) must be true for the grid the
		// press needs. Both were false on the live playground.
		const placedBerlin = {
			id: id(5),
			sessionId: id(20),
			roomId,
			startAt: '2027-09-15T07:30:00.000Z',
			endAt: '2027-09-15T08:15:00.000Z',
			version: 1
		};
		const payloads = {
			[pathByOperation.sessionCatalog]: sessionCatalogReadResultSchema.parse({
				kind: 'success',
				data: {
					...catalogData(),
					sessions: [head(20), head(22, { id: id(22), title: 'Schedule Physics for Stubborn Rooms' })]
				},
				correlationId
			}),
			[fullRangePath]: schedulePlacementReadResultSchema.parse({
				kind: 'success',
				data: { schemaVersion: 1, scope, scheduleVersion: 4, occurrences: [placedBerlin] },
				correlationId
			})
		};
		const port = composePort(payloads, [], fakeProposalCounts(), fakeSettings(jooconSettings()));
		const state = await port.schedule.state();

		const boardReady = state.rooms.length > 0 && state.days.length > 0;
		expect(boardReady).toBe(true);

		const grouping = programGrouping(state, new Map());
		const rows = [...grouping.groups.values()].flat();
		const placeable = rows.filter((row) => !row.placed && row.session.state !== 'draft');
		expect(placeable.map((row) => row.session.title)).toEqual([
			'Schedule Physics for Stubborn Rooms'
		]);
	});

	test('keeps the honest no-grid state for placements the local window truly cannot draw', () => {
		// 05:00Z is 07:00 in Berlin — genuinely before a 09:00 day start, and the
		// fix must not paper that over.
		expect(deriveScheduleGeometry({
			settings: jooconSettings(),
			occurrences: [
				{ startAtUtc: '2027-09-15T05:00:00.000Z', endAtUtc: '2027-09-15T05:45:00.000Z' }
			]
		}).localCalendarReady).toBe(false);

		// 22:30Z on day one is 00:30 on day two in Berlin. Day keys stay canonical
		// UTC (re-keying occurrences is deferred), so a local date that disagrees
		// with the UTC key renders no grid rather than a shifted column.
		expect(deriveScheduleGeometry({
			settings: jooconSettings(),
			occurrences: [
				{ startAtUtc: '2027-09-15T22:30:00.000Z', endAtUtc: '2027-09-15T23:15:00.000Z' }
			]
		}).localCalendarReady).toBe(false);

		// An unrecognized zone falls back to the canonical UTC basis rather than
		// inventing geometry: 07:30Z is then truly outside a 09:00 window.
		expect(deriveScheduleGeometry({
			settings: jooconSettings({ timezone: 'Not/AZone' }),
			occurrences: jooconOccurrences
		}).localCalendarReady).toBe(false);
	});

	test('place mints the instant the organizer’s own clock names, and round-trips', async () => {
		const geometry = deriveScheduleGeometry({
			settings: jooconSettings(),
			occurrences: []
		});
		// Slot zero of the 09:00 Berlin window is 07:00Z, and reading it back on
		// the event's clock returns slot zero — the board's press and the canonical
		// record agree.
		const state = await composePort(
			{
				[pathByOperation.sessionCatalog]: sessionCatalogReadResultSchema.parse({
					kind: 'success', data: catalogData(), correlationId
				}),
				[fullRangePath]: schedulePlacementReadResultSchema.parse({
					kind: 'success',
					data: {
						schemaVersion: 1,
						scope,
						scheduleVersion: 4,
						occurrences: [{
							id: id(5),
							sessionId: id(20),
							roomId,
							startAt: '2027-09-15T07:00:00.000Z',
							endAt: '2027-09-15T07:45:00.000Z',
							version: 1
						}]
					},
					correlationId
				})
			},
			[],
			fakeProposalCounts(),
			fakeSettings(jooconSettings())
		).schedule.state();
		expect(geometry.dayStartMin).toBe(540);
		expect(state.placements[0]).toMatchObject({ dayKey: '2027-09-15', startMin: 0 });
	});
});
