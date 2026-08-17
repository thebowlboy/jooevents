export type AcceleventsSessionType = 'IN_PERSON' | 'VIRTUAL' | 'HYBRID';

export type AcceleventsRemoteFormat =
	| 'REGULAR_SESSION'
	| 'MAIN_STAGE_SESSION'
	| 'WORKSHOP'
	| 'MEET_UP'
	| 'BREAK'
	| 'OTHER'
	| 'EXPO';

export const ACCELEVENTS_REMOTE_FORMATS: readonly {
	readonly value: AcceleventsRemoteFormat;
	readonly label: string;
	readonly description: string;
}[] = [
	{ value: 'REGULAR_SESSION', label: 'Regular session', description: 'An ordinary agenda session.' },
	{ value: 'MAIN_STAGE_SESSION', label: 'Main stage session', description: 'A headline slot on the main stage.' },
	{ value: 'WORKSHOP', label: 'Workshop', description: 'A hands-on, usually capacity-limited session.' },
	{ value: 'MEET_UP', label: 'Meet-up', description: 'An informal gathering around a topic.' },
	{ value: 'BREAK', label: 'Break', description: 'A pause between sessions; no speakers expected.' },
	{ value: 'OTHER', label: 'Other', description: 'Anything the other kinds do not cover.' },
	{ value: 'EXPO', label: 'Expo', description: 'Exhibition or booth time.' }
];

export interface AcceleventsReleaseOption {
	readonly id: string;
	readonly number: number;
	readonly releasedAt: string;
	readonly sessionCount: number;
	readonly occurrenceCount: number;
	readonly roomCount: number;
	readonly speakerCount: number;
}

export interface AcceleventsFormatRow {
	readonly formatId: string;
	readonly name: string;
	readonly sessionCount: number;
	readonly remoteFormat: AcceleventsRemoteFormat | null;
}

export interface AcceleventsSpeakerRow {
	readonly personId: string;
	readonly displayName: string;
	readonly sessionCount: number;
	readonly firstName: string;
	readonly lastName: string;
	/** True while the names are the untouched two-word split of the display name. */
	readonly prefilled: boolean;
	readonly hasApprovedEmail: boolean;
}

export type AcceleventsRoomBinding =
	| { readonly kind: 'remote'; readonly locationId: number }
	| { readonly kind: 'no_location' }
	| null;

export interface AcceleventsRoomRow {
	readonly roomId: string;
	readonly name: string;
	readonly occurrenceCount: number;
	readonly binding: AcceleventsRoomBinding;
}

export interface AcceleventsPrimaryCandidate {
	readonly personId: string;
	readonly displayName: string;
	readonly roleLabel: string;
}

export interface AcceleventsPrimaryRow {
	readonly occurrenceId: string;
	readonly sessionId: string;
	readonly sessionTitle: string;
	readonly candidates: readonly AcceleventsPrimaryCandidate[];
	readonly primaryPersonId: string | null;
}

export interface AcceleventsUnplacedSession {
	readonly sessionId: string;
	readonly title: string;
}

export interface AcceleventsExportView {
	readonly schemaVersion?: 1;
	readonly eventId?: string;
	readonly configurationVersion?: number;
	/** The event's IANA timezone; every date and time in the files uses it. */
	readonly timezone: string;
	readonly releases: readonly AcceleventsReleaseOption[];
	readonly selectedReleaseId: string | null;
	readonly sessionType: AcceleventsSessionType | null;
	readonly formats: readonly AcceleventsFormatRow[];
	readonly speakers: readonly AcceleventsSpeakerRow[];
	readonly rooms: readonly AcceleventsRoomRow[];
	readonly primaries: readonly AcceleventsPrimaryRow[];
	readonly unplacedSessions: readonly AcceleventsUnplacedSession[];
	readonly lastGenerated: { readonly at: string; readonly releaseNumber: number } | null;
	/** Stage-one file for the guided location flow; absent until the serving operation exists. */
	readonly locationsCsvPath: string | null;
	/** The built package download; absent until the live export operation exists. */
	readonly packagePath: string | null;
	/** The server owns this report in live workspaces. */
	readonly preflight?: AcceleventsPreflight;
}

export interface AcceleventsExportPort {
	read(): Promise<AcceleventsExportView>;
	selectRelease(releaseId: string): Promise<AcceleventsExportView>;
	setSessionType(sessionType: AcceleventsSessionType): Promise<AcceleventsExportView>;
	mapFormat(formatId: string, remoteFormat: AcceleventsRemoteFormat): Promise<AcceleventsExportView>;
	setSpeakerName(personId: string, firstName: string, lastName: string): Promise<AcceleventsExportView>;
	bindRoom(roomId: string, binding: AcceleventsRoomBinding): Promise<AcceleventsExportView>;
	setPrimary(occurrenceId: string, primaryPersonId: string | null): Promise<AcceleventsExportView>;
	generate(): Promise<AcceleventsExportView>;
}

export interface AcceleventsPreflightBlocker {
	readonly id: string;
	readonly summary: string;
	/** In-page anchor of the section that resolves it. */
	readonly anchor?: string;
}

export interface AcceleventsPreflightNote {
	readonly id: string;
	readonly summary: string;
}

export interface AcceleventsPreflight {
	readonly blockers: readonly AcceleventsPreflightBlocker[];
	readonly leftOut: readonly AcceleventsPreflightNote[];
	readonly contains: {
		readonly locations: number;
		readonly speakers: number;
		readonly sessionRows: number;
		readonly personalFields: readonly string[];
	} | null;
	readonly consequences: readonly AcceleventsPreflightNote[];
	readonly ready: boolean;
}

function listNames(names: readonly string[]): string {
	return names.join(', ');
}

/**
 * The presentation derivation of the export preflight. The live export
 * operation owns the authoritative report; this mirror keeps the sample
 * surface honest and the page's grouping identical in both compositions.
 */
export function computeAcceleventsPreflight(view: AcceleventsExportView): AcceleventsPreflight {
	if (view.preflight) return view.preflight;
	if (view.selectedReleaseId === null) {
		return { blockers: [], leftOut: [], contains: null, consequences: [], ready: false };
	}

	const blockers: AcceleventsPreflightBlocker[] = [];
	if (view.sessionType === null) {
		blockers.push({
			id: 'session-type',
			summary: 'Every session row needs a session type — in person, virtual, or hybrid — and none is chosen yet.',
			anchor: '#mapping'
		});
	}
	const unmapped = view.formats.filter((format) => format.remoteFormat === null);
	if (unmapped.length > 0) {
		blockers.push({
			id: 'formats',
			summary: `${unmapped.length === 1 ? 'One format has' : `${unmapped.length} formats have`} no Accelevents format yet: ${listNames(unmapped.map((format) => format.name))}.`,
			anchor: '#mapping'
		});
	}
	const unnamed = view.speakers.filter((speaker) => speaker.firstName.trim() === '' || speaker.lastName.trim() === '');
	if (unnamed.length > 0) {
		blockers.push({
			id: 'names',
			summary: `${unnamed.length === 1 ? 'One speaker is' : `${unnamed.length} speakers are`} missing a first or last name: ${listNames(unnamed.map((speaker) => speaker.displayName))}.`,
			anchor: '#speakers'
		});
	}
	const unmailed = view.speakers.filter((speaker) => !speaker.hasApprovedEmail);
	if (unmailed.length > 0) {
		blockers.push({
			id: 'emails',
			summary: `${unmailed.length === 1 ? 'One speaker has' : `${unmailed.length} speakers have`} no email on file: ${listNames(unmailed.map((speaker) => speaker.displayName))}. Accelevents matches speakers by email.`,
			anchor: '/app/speakers'
		});
	}
	const unbound = view.rooms.filter((room) => room.binding === null);
	if (unbound.length > 0) {
		blockers.push({
			id: 'locations',
			summary: `${unbound.length === 1 ? 'One room has' : `${unbound.length} rooms have`} no Accelevents location ID yet: ${listNames(unbound.map((room) => room.name))}.`,
			anchor: '#locations'
		});
	}

	const leftOut: AcceleventsPreflightNote[] = [
		...view.unplacedSessions.map((session) => ({
			id: `unplaced-${session.sessionId}`,
			summary: `“${session.title}” is released but not scheduled, so it has no time to import.`
		})),
		{ id: 'headshots', summary: 'Headshots — the Accelevents CSV import cannot carry images.' },
		{
			id: 'editorial',
			summary: 'Bios and session descriptions — no approved copy exists for them, so those columns stay blank.'
		}
	];

	const occurrenceCount = view.releases.find((release) => release.id === view.selectedReleaseId)?.occurrenceCount ?? 0;
	const contains = {
		locations: view.rooms.filter((room) => room.binding?.kind !== 'no_location').length,
		speakers: view.speakers.length,
		sessionRows: occurrenceCount,
		personalFields: ['name', 'email address', 'pronouns, headline, and links when they exist']
	};

	const consequences: AcceleventsPreflightNote[] = [
		{
			id: 'notifications',
			summary: 'Accelevents may email each imported speaker if its own notifications are turned on.'
		},
		...view.primaries
			.filter((row) => row.primaryPersonId !== null)
			.map((row) => {
				const person = row.candidates.find((candidate) => candidate.personId === row.primaryPersonId);
				return {
					id: `primary-${row.occurrenceId}`,
					summary: `${person?.displayName ?? 'The chosen speaker'} becomes a primary speaker in Accelevents and can edit and moderate “${row.sessionTitle}” there.`
				};
			}),
		...(view.lastGenerated
			? [{
				id: 'repeat',
				summary: 'A package for this event was already generated. Importing both creates duplicate speakers and sessions in Accelevents.'
			}]
			: [])
	];

	return { blockers, leftOut, contains, consequences, ready: blockers.length === 0 };
}

/** The exact Accelevents location-template header; column order is the vendor contract. */
export const ACCELEVENTS_LOCATIONS_HEADER = 'Location,Source URL,Attendee Meetings';

function csvField(value: string): string {
	return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Stage-one file: rooms only, safe defaults, exact vendor header. */
export function locationsCsv(rooms: readonly AcceleventsRoomRow[]): string {
	const rows = rooms
		.filter((room) => room.binding?.kind !== 'no_location')
		.map((room) => `${csvField(room.name)},,N`);
	return [ACCELEVENTS_LOCATIONS_HEADER, ...rows].join('\r\n') + '\r\n';
}

function prefillName(displayName: string): { firstName: string; lastName: string; prefilled: boolean } {
	const tokens = displayName.trim().split(/\s+/u);
	if (tokens.length === 2 && tokens[0] && tokens[1]) {
		return { firstName: tokens[0], lastName: tokens[1], prefilled: true };
	}
	return { firstName: '', lastName: '', prefilled: false };
}

interface SampleSpeakerSeed {
	readonly personId: string;
	readonly displayName: string;
	readonly sessionCount: number;
	readonly hasApprovedEmail: boolean;
}

const SAMPLE_SPEAKERS: readonly SampleSpeakerSeed[] = [
	{ personId: 'person-maya', displayName: 'Maya Chen', sessionCount: 2, hasApprovedEmail: true },
	{ personId: 'person-jonas', displayName: 'Jonas Weber', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-ayodele', displayName: 'Ayodele', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-mary', displayName: 'Mary Ann van der Berg', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-nadia', displayName: 'Nadia Osei', sessionCount: 2, hasApprovedEmail: true },
	{ personId: 'person-ravi', displayName: 'Ravi Chandran', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-dana', displayName: 'Dana Ryu', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-elin', displayName: 'Elin Sørensen', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-tomas', displayName: 'Tomás Rivera', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-grace', displayName: 'Grace Okonkwo', sessionCount: 1, hasApprovedEmail: true },
	{ personId: 'person-sam', displayName: 'Sam Whitfield', sessionCount: 1, hasApprovedEmail: true }
];

function sampleView(): AcceleventsExportView {
	return {
		timezone: 'America/New_York',
		releases: [
			{
				id: 'release-4',
				number: 4,
				releasedAt: '2026-08-12T14:30:00.000Z',
				sessionCount: 13,
				occurrenceCount: 14,
				roomCount: 3,
				speakerCount: SAMPLE_SPEAKERS.length
			},
			{
				id: 'release-3',
				number: 3,
				releasedAt: '2026-08-04T09:15:00.000Z',
				sessionCount: 12,
				occurrenceCount: 12,
				roomCount: 3,
				speakerCount: 10
			}
		],
		selectedReleaseId: 'release-4',
		sessionType: null,
		formats: [
			{ formatId: 'format-talk', name: 'Talk', sessionCount: 8, remoteFormat: null },
			// Exact-name matches pre-fill; the row still shows the mapping for confirmation.
			{ formatId: 'format-workshop', name: 'Workshop', sessionCount: 3, remoteFormat: 'WORKSHOP' },
			{ formatId: 'format-keynote', name: 'Keynote', sessionCount: 2, remoteFormat: null }
		],
		speakers: SAMPLE_SPEAKERS.map((seed) => ({ ...seed, ...prefillName(seed.displayName) })),
		rooms: [
			{ roomId: 'room-main', name: 'Main Hall', occurrenceCount: 7, binding: null },
			{ roomId: 'room-4', name: 'Room 4', occurrenceCount: 5, binding: null },
			{ roomId: 'room-studio', name: 'Workshop Studio', occurrenceCount: 2, binding: null }
		],
		primaries: [
			{
				occurrenceId: 'occurrence-panel',
				sessionId: 'session-panel',
				sessionTitle: 'Panel: Post-quantum readiness',
				candidates: [
					{ personId: 'person-nadia', displayName: 'Nadia Osei', roleLabel: 'Host in JooEvents' },
					{ personId: 'person-maya', displayName: 'Maya Chen', roleLabel: 'Panelist in JooEvents' }
				],
				primaryPersonId: null
			}
		],
		unplacedSessions: [{ sessionId: 'session-lightning', title: 'Lightning talks: open mic' }],
		lastGenerated: null,
		locationsCsvPath: null,
		packagePath: null
	};
}

export function createSampleAcceleventsExportPort(
	now: () => number = Date.now
): AcceleventsExportPort {
	let view = sampleView();
	const withLocationsCsv = (next: AcceleventsExportView): AcceleventsExportView => ({
		...next,
		locationsCsvPath: `data:text/csv;charset=utf-8,${encodeURIComponent(locationsCsv(next.rooms))}`
	});
	view = withLocationsCsv(view);
	const copy = () => structuredClone(view);
	return {
		async read() {
			return copy();
		},
		async selectRelease(releaseId) {
			if (view.releases.some((release) => release.id === releaseId)) {
				view = {
					...view,
					selectedReleaseId: releaseId,
					unplacedSessions: releaseId === 'release-4' ? sampleView().unplacedSessions : []
				};
			}
			return copy();
		},
		async setSessionType(sessionType) {
			view = { ...view, sessionType };
			return copy();
		},
		async mapFormat(formatId, remoteFormat) {
			view = {
				...view,
				formats: view.formats.map((format) =>
					format.formatId === formatId ? { ...format, remoteFormat } : format
				)
			};
			return copy();
		},
		async setSpeakerName(personId, firstName, lastName) {
			view = {
				...view,
				speakers: view.speakers.map((speaker) =>
					speaker.personId === personId
						? { ...speaker, firstName, lastName, prefilled: false }
						: speaker
				)
			};
			return copy();
		},
		async bindRoom(roomId, binding) {
			view = withLocationsCsv({
				...view,
				rooms: view.rooms.map((room) => (room.roomId === roomId ? { ...room, binding } : room))
			});
			return copy();
		},
		async setPrimary(occurrenceId, primaryPersonId) {
			view = {
				...view,
				primaries: view.primaries.map((row) =>
					row.occurrenceId === occurrenceId ? { ...row, primaryPersonId } : row
				)
			};
			return copy();
		},
		async generate() {
			if (!computeAcceleventsPreflight(view).ready) {
				throw new Error('accelevents_export_blocked');
			}
			const release = view.releases.find((option) => option.id === view.selectedReleaseId);
			view = {
				...view,
				lastGenerated: {
					at: new Date(now()).toISOString(),
					releaseNumber: release?.number ?? 0
				}
			};
			return copy();
		}
	};
}

const LIVE_OPERATIONS = Object.freeze({
	read: { name: 'program.export.accelevents.view.read', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.viewRead },
	save: { name: 'program.export.accelevents.config.save', version: 1, effect: 'commit', method: 'POST', input: 'body', idempotencyRequired: true, ...ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.configSave },
	package: { name: 'program.export.accelevents.package.read', version: 1, effect: 'read', method: 'GET', input: 'query', idempotencyRequired: false, ...ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS.packageRead }
} as const satisfies Record<string, ExpectedOperatorHttpOperation>);

/** Manifest-pinned same-origin adapter for the live export preparation. */
export function createLiveAcceleventsExportPort(input: {
	readonly manifest: SafeOperationManifest;
}): AcceleventsExportPort {
	const readBinding = resolveOperatorHttpBinding({ manifest: input.manifest, expected: LIVE_OPERATIONS.read });
	const saveBinding = resolveOperatorHttpBinding({ manifest: input.manifest, expected: LIVE_OPERATIONS.save });
	const packageBinding = resolveOperatorHttpBinding({ manifest: input.manifest, expected: LIVE_OPERATIONS.package });
	let latest: AcceleventsExportView | null = null;

	const availablePath = (binding: typeof readBinding): string => {
		if (binding.kind === 'unavailable') throw new Error(binding.reason);
		return binding.path;
	};
	const read = async (): Promise<AcceleventsExportView> => {
		const response = await requestJson({
			path: availablePath(readBinding),
			method: 'GET',
			schema: acceleventsExportViewReadResultSchema,
			timeoutMs: 25_000
		});
		if (response.kind === 'error') throw new Error(response.error.code);
		if (response.data.kind !== 'success') throw new Error(response.data.outcome.kind);
		const saved: AcceleventsExportView = response.data.data;
		latest = saved;
		return structuredClone(saved);
	};
	const current = (): AcceleventsExportView => {
		if (!latest || latest.eventId === undefined || latest.configurationVersion === undefined) {
			throw new Error('accelevents_export_not_loaded');
		}
		return latest;
	};
	const save = async (next: AcceleventsExportView): Promise<AcceleventsExportView> => {
		const previous = current();
		const response = await requestJson({
			path: availablePath(saveBinding),
			method: 'POST',
			idempotencyKey: crypto.randomUUID(),
			body: {
				eventId: previous.eventId,
				expectedVersion: previous.configurationVersion,
				selectedReleaseId: next.selectedReleaseId,
				sessionType: next.sessionType,
				formatMappings: next.formats
					.filter((row) => row.remoteFormat !== null)
					.map((row) => ({ formatId: row.formatId, remoteFormat: row.remoteFormat })),
				speakerNames: next.speakers.map((row) => ({ personId: row.personId, firstName: row.firstName, lastName: row.lastName })),
				roomBindings: next.rooms
					.filter((row) => row.binding !== null)
					.map((row) => ({ roomId: row.roomId, ...row.binding })),
				primarySpeakers: next.primaries
					.filter((row) => row.primaryPersonId !== null)
					.map((row) => ({ occurrenceId: row.occurrenceId, personId: row.primaryPersonId }))
			},
			schema: acceleventsExportConfigSaveResultSchema,
			timeoutMs: 25_000
		});
		if (response.kind === 'error') throw new Error(response.error.code);
		if (response.data.kind !== 'success') throw new Error(response.data.outcome.kind);
		const saved: AcceleventsExportView = response.data.data;
		latest = saved;
		return structuredClone(saved);
	};
	const mutate = async (change: (view: AcceleventsExportView) => AcceleventsExportView) => save(change(structuredClone(current())));

	const port: AcceleventsExportPort = {
		read,
		selectRelease: (releaseId) => mutate((view) => ({
			...view,
			selectedReleaseId: releaseId,
			formats: view.formats.map((row) => ({ ...row, remoteFormat: null })),
			speakers: view.speakers.map((row) => ({ ...row, firstName: '', lastName: '', prefilled: false })),
			rooms: view.rooms.map((row) => ({ ...row, binding: null })),
			primaries: view.primaries.map((row) => ({ ...row, primaryPersonId: null }))
		})),
		setSessionType: (sessionType) => mutate((view) => ({ ...view, sessionType })),
		mapFormat: (formatId, remoteFormat) => mutate((view) => ({ ...view, formats: view.formats.map((row) => row.formatId === formatId ? { ...row, remoteFormat } : row) })),
		setSpeakerName: (personId, firstName, lastName) => mutate((view) => ({ ...view, speakers: view.speakers.map((row) => row.personId === personId ? { ...row, firstName, lastName, prefilled: false } : row) })),
		bindRoom: (roomId, binding) => mutate((view) => ({ ...view, rooms: view.rooms.map((row) => row.roomId === roomId ? { ...row, binding } : row) })),
		setPrimary: (occurrenceId, primaryPersonId) => mutate((view) => ({ ...view, primaries: view.primaries.map((row) => row.occurrenceId === occurrenceId ? { ...row, primaryPersonId } : row) })),
		async generate() {
			const view = current();
			if (!view.selectedReleaseId) throw new Error('accelevents_export_release_required');
			const path = `${availablePath(packageBinding)}?releaseId=${encodeURIComponent(view.selectedReleaseId)}`;
			const response = await requestJson({ path, method: 'GET', schema: acceleventsExportArtifactReadResultSchema, timeoutMs: 25_000 });
			if (response.kind === 'error') throw new Error(response.error.code);
			if (response.data.kind !== 'success') throw new Error(response.data.outcome.kind);
			return read();
		}
	};
	return Object.freeze(port);
}
import {
	ACCELEVENTS_EXPORT_OPERATION_SCHEMA_REFS,
	acceleventsExportArtifactReadResultSchema,
	acceleventsExportConfigSaveResultSchema,
	acceleventsExportViewReadResultSchema,
	type SafeOperationManifest
} from '@jooevents/contracts';
import { requestJson } from './client';
import { resolveOperatorHttpBinding, type ExpectedOperatorHttpOperation } from './operations/operator-http-binding';
