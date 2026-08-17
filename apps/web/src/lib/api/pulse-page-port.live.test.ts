import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	operationHistoryEntrySchema,
	type OperationHistoryEntry,
	type SafeOperationManifestEntry
} from '@jooevents/contracts';
import type { SubmissionTriageRowView } from './mappers/submission-triage';
import {
	PULSE_HISTORY_OPERATION,
	createLivePulsePagePort,
	createPulseHistoryLivePort,
	type LivePulsePageSources,
	type PulseHistoryReadPort,
	type PulseHistoryRequester
} from './pulse-page-port.live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (value: string) => value.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const userId = id(3);
const formId = id(4);
const formVersionId = id(5);
const trackA = id(10);
const trackB = id(11);
const formatId = id(12);
const sessionA = id(20);
const sessionB = id(21);
const NOW = Date.parse('2026-08-16T12:00:00.000Z');

function triageRow(input: {
	readonly submission: number;
	readonly submittedAt: string;
	readonly track?: { readonly id: string; readonly label: string };
	readonly tray?: 'inbox' | 'late' | 'set_aside' | 'spam';
}): SubmissionTriageRowView {
	return {
		source: {
			id: id(input.submission),
			formId,
			formVersionId,
			target: input.track
				? { kind: 'category', category: { kind: 'track', id: input.track.id } }
				: { kind: 'general_pool' },
			title: `Proposal ${input.submission}`,
			primaryParticipantName: 'Avery Stone',
			submittedAt: input.submittedAt,
			source: 'public_form',
			abstract: null,
			track: input.track ?? null,
			format: null,
			detail: {
				schemaVersion: 1,
				submissionId: id(input.submission),
				formId,
				formVersionId,
				submittedAt: input.submittedAt,
				participantCount: 1,
				answers: [],
				affirmedConsentFieldIds: []
			}
		},
		head: { version: 1, state: 'inbox', setAsideAttribution: null, updatedAt: input.submittedAt },
		arrival: {
			schemaVersion: 1,
			id: id(input.submission + 100),
			scope: { workspaceId, eventId },
			submissionId: id(input.submission),
			formId,
			formVersionId,
			source: 'public_form',
			submittedAt: input.submittedAt,
			classification: input.tray === 'late' ? 'late' : 'on_time',
			closeEvidence: null,
			recordedAt: input.submittedAt
		},
		visibleTray: input.tray ?? 'inbox',
		queryGuard: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			version: 1,
			digestSha256: digest('a')
		}
	};
}

function decisionHead(
	submissionId: string,
	state: 'accepted' | 'declined',
	decidedAt: string,
	version = 1
) {
	return {
		schemaVersion: 1 as const,
		scope: { workspaceId, eventId },
		submissionId,
		state,
		version,
		digestSha256: digest('b'),
		decidedByUserId: userId,
		decidedAt
	};
}

function session(idValue: string, track: { readonly id: string; readonly name: string }) {
	return {
		schemaVersion: 1 as const,
		scope: { workspaceId, eventId },
		id: idValue,
		title: 'A session',
		plannedDurationMinutes: 30,
		lifecycle: 'programmed' as const,
		programTarget: {
			setVersion: 1,
			setDigestSha256: digest('c'),
			format: { kind: 'format' as const, id: formatId, name: 'Talk', status: 'active' as const, version: 1 },
			track: { kind: 'track' as const, ...track, accent: 'sea' as const, status: 'active' as const, version: 1 }
		},
		roster: { version: 1, digestSha256: digest('d'), participants: [] },
		version: 1,
		digestSha256: digest('e'),
		createdByUserId: userId,
		createdAt: '2026-07-01T00:00:00.000Z',
		updatedByUserId: userId,
		updatedAt: '2026-07-01T00:00:00.000Z'
	};
}

function engagement(value: number, sessionId: string, state: 'invited' | 'confirmed' | 'cancelled') {
	return {
		schemaVersion: 1 as const,
		id: id(value),
		scope: { workspaceId, eventId },
		sessionId,
		personId: id(value + 100),
		submissionId: null,
		seededByDecision: null,
		state,
		invitedAt: '2026-08-01T00:00:00.000Z',
		respondBy: null,
		confirmation: state === 'confirmed'
			? { attribution: 'self' as const, personId: id(value + 100), recordedByUserId: null, confirmedAt: '2026-08-10T00:00:00.000Z' }
			: null,
		cancellationRequest: null,
		cancelledAt: state === 'cancelled' ? '2026-08-12T00:00:00.000Z' : null,
		source: { kind: 'manual', id: `seed-${value}`, version: 1 },
		version: 1
	};
}

function historyEntry(value: number, summary = 'Submitted a review'): OperationHistoryEntry {
	return operationHistoryEntrySchema.parse({
		id: id(value),
		operation: { name: 'review.evaluation.change', version: 1 },
		scope: { workspaceId, eventId },
		surface: 'operator_http',
		actor: { kind: 'workspace_user', userId },
		subjects: [{ kind: 'event', id: eventId }],
		summary,
		occurredAt: '2026-08-14T10:00:00.000Z',
		correlationId: id(value + 200),
		resultKind: 'success'
	});
}

function sources(input: {
	readonly rows?: readonly SubmissionTriageRowView[];
	readonly trayTotal?: number;
	readonly noEvent?: boolean;
	readonly calls?: string[];
	readonly decisionVersion?: number;
} = {}): LivePulsePageSources {
	const rows = input.rows ?? [
		triageRow({ submission: 30, submittedAt: '2026-08-13T10:00:00.000Z', track: { id: trackA, label: 'Agents' } }),
		triageRow({ submission: 31, submittedAt: '2026-08-02T10:00:00.000Z', track: { id: trackB, label: 'Systems' }, tray: 'set_aside' }),
		triageRow({ submission: 32, submittedAt: '2026-07-10T10:00:00.000Z' })
	];
	const calls = input.calls ?? [];
	const decisionById = new Map([
		[id(30), { head: decisionHead(id(30), 'accepted', '2026-08-15T09:00:00.000Z', input.decisionVersion),
			origin: { schemaVersion: 1 as const, scope: { workspaceId, eventId }, submissionId: id(30), sessionId: sessionA,
				kind: 'spawned' as const, linkedByUserId: userId, linkedAt: '2026-08-15T09:00:00.000Z' } }],
		[id(31), { head: decisionHead(id(31), 'declined', '2026-08-04T09:00:00.000Z'), origin: null }]
	]);
	return {
		event: {
			async read() {
				calls.push('event');
				return input.noEvent
					? { kind: 'success' as const, data: { kind: 'no_event' as const, eventSetVersion: 1 }, correlationId: id(800) }
					: { kind: 'success' as const, data: { kind: 'current_event' as const, eventSetVersion: 1, event: {
						id: eventId, name: 'JooCon', timezone: 'UTC', startDate: '2026-09-01', endDate: '2026-09-03', version: 1
					} }, correlationId: id(800) };
			}
		},
		vocabulary: {
			async read() {
				calls.push('vocabulary');
				const item = (idValue: string, name: string, accent: 'lavender' | 'sea') => ({
					kind: 'track' as const, id: idValue, name, accent, status: 'active' as const, version: 1,
					usage: { currentReferences: 1, historicalPins: 0 }, deleteAvailability: { kind: 'available' as const }
				});
				return { kind: 'success' as const, correlationId: id(801), data: {
					schemaVersion: 1 as const, scope: { workspaceId, eventId }, setVersion: 1,
					rooms: [], tracks: [item(trackA, 'Agents', 'lavender'), item(trackB, 'Systems', 'sea')], formats: []
				} };
			}
		},
		triage: {
			async list() {
				calls.push('triage');
				return { kind: 'success' as const, correlationId: id(802), data: {
					rows, trayTotals: { inbox: input.trayTotal ?? rows.length - 1, late: 0, set_aside: rows.length > 1 ? 1 : 0, spam: 0 },
					search: null, queryGuard: rows[0]?.queryGuard ?? {
						schemaVersion: 1 as const, scope: { workspaceId, eventId }, version: 1, digestSha256: digest('a')
					}
				} };
			}
		},
		decisions: {
			async readState(submissionIds) {
				calls.push('decisions');
				return { kind: 'success' as const, correlationId: id(803), data: { schemaVersion: 1 as const,
					rows: submissionIds.map((submissionId) => ({ submissionId,
						...(decisionById.get(submissionId) ?? { head: null, origin: null }) })) } };
			}
		},
		engagements: {
			async readSnapshot() {
				calls.push('engagements');
				return { kind: 'success' as const, correlationId: id(804), data: { schemaVersion: 1 as const,
					scope: { workspaceId, eventId }, engagements: [
						engagement(40, sessionA, 'invited'), engagement(41, sessionA, 'confirmed'), engagement(42, sessionB, 'cancelled')
					] } };
			}
		},
		sessions: {
			async readCatalog() {
				calls.push('sessions');
				return { kind: 'success' as const, correlationId: id(805), data: { schemaVersion: 1 as const,
					scope: { workspaceId, eventId }, version: 1, digestSha256: digest('f'),
					sessions: [session(sessionA, { id: trackA, name: 'Agents' }), session(sessionB, { id: trackB, name: 'Systems' })] } };
			}
		},
		history: {
			async listEvent() {
				calls.push('history');
				return { kind: 'success' as const, data: [historyEntry(50), historyEntry(51, 'Amended a review')] };
			}
		}
	};
}

describe('live Pulse page port', () => {
	test('projects one coherent live story from registered current-state and history reads', async () => {
		const port = createLivePulsePagePort({ sources: sources(), now: () => NOW });
		expect(port.source).toEqual({ kind: 'live' });
		expect(port.snapshot()).toBeNull();

		const result = await port.read();
		if (result.kind !== 'success') throw new Error('expected_success');
		expect(result.data.event?.name).toBe('JooCon');
		expect(result.data.series.map((series) => [series.key, series.total])).toEqual([
			['proposals', 3], ['reviews', 1], ['decisions', 2]
		]);
		expect(result.data.series[0]?.windowCount).toBe(1);
		expect(result.data.series[1]?.windowCount).toBe(1);
		expect(result.data.series[2]?.windowCount).toBe(2);
		expect(result.data.breakdown.rows).toEqual([
			{ state: 'accepted', count: 1 }, { state: 'declined', count: 1 }, { state: 'undecided', count: 1 }
		]);
		expect(result.data.breakdown.rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
		expect(result.data.tracks.rows.map((row) => [row.name, row.proposals, row.accepted, row.speakers])).toEqual([
			['Agents', 1, 1, 2], ['Systems', 1, 0, 0], ['General pool', 1, 0, 0]
		]);
		expect(result.data.tracks.rosterLine).toBe('2 speakers are on the roster.');
		expect(result.data.hero.figures).toEqual([
			{ label: 'Proposals', value: '3' }, { label: 'Reviews', value: '1' },
			{ label: 'Decided', value: '2' }, { label: 'Accepted', value: '1' },
			{ label: 'Speakers', value: '2' }
		]);
		expect(port.snapshot()).toBe(result.data);
	});

	test('serves the explicit no-event shape without reading event-scoped operations', async () => {
		const calls: string[] = [];
		const port = createLivePulsePagePort({ sources: sources({ noEvent: true, calls }), now: () => NOW });
		const result = await port.read();
		expect(result).toEqual({ kind: 'success', data: {
			event: null, hero: { figures: [] }, series: [], breakdown: { total: 0, rows: [] }, tracks: { rows: [] }
		} });
		expect(calls).toEqual(['event']);
	});

	test('keeps an unbegun decision flow absent instead of drawing a zero chart', async () => {
		const rows = [triageRow({
			submission: 33,
			submittedAt: '2026-08-13T10:00:00.000Z'
		})];
		const port = createLivePulsePagePort({
			sources: sources({ rows, trayTotal: 1 }),
			now: () => NOW
		});
		const result = await port.read();
		if (result.kind !== 'success') throw new Error('expected_success');
		const decisions = result.data.series.find((series) => series.key === 'decisions');
		expect(decisions).toMatchObject({ total: 0, windowCount: 0, weeks: [] });
		expect(decisions?.absence).toBeDefined();
		expect(result.data.breakdown).toEqual({
			total: 1,
			rows: [],
			absence: 'All 1 proposals are waiting for your answer.'
		});
		expect(result.data.tracks).toEqual({
			rows: [],
			absence: 'Each track fills here as proposals are accepted.'
		});
	});

	test('refuses a capped triage slice instead of presenting it as the whole population', async () => {
		const port = createLivePulsePagePort({ sources: sources({ trayTotal: 4 }), now: () => NOW });
		expect(await port.read()).toEqual({
			kind: 'unavailable', message: 'The complete event pulse is not available in this live workspace.'
		});
	});

	test('refuses an amended decision head whose first-transition instant is not readable', async () => {
		const port = createLivePulsePagePort({
			sources: sources({ decisionVersion: 2 }),
			now: () => NOW
		});
		expect(await port.read()).toEqual({
			kind: 'unavailable', message: 'The complete event pulse is not available in this live workspace.'
		});
	});
});

function historyManifestEntry(path: string = PULSE_HISTORY_OPERATION.path): SafeOperationManifestEntry {
	return {
		name: PULSE_HISTORY_OPERATION.name,
		version: PULSE_HISTORY_OPERATION.version,
		lifecycle: { status: 'active' },
		summary: 'List event history.',
		effect: 'read',
		maxRisk: 'low',
		consequenceTags: [],
		inputSchema: PULSE_HISTORY_OPERATION.inputSchema,
		autonomy: {
			policy: { key: 'autonomy.operation.history.list', version: 1 }, riskFloor: 'low',
			unattendedRiskCeiling: 'low', requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'], triggerDispositions: {
				authority_lost: 'block', unattended_bounds_exceeded: 'block', approval_required: 'block',
				known_retryable_failure: 'block', ambiguous_external_effect: 'block', stale_plan: 'block',
				compensation_required: 'block', terminal_failure: 'block'
			}
		},
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [{
			surface: 'operator_http', protocol: 'http', method: 'GET', path, input: 'query',
			resultSchema: PULSE_HISTORY_OPERATION.resultSchema, browserResumption: { kind: 'none' }
		}]
	};
}

function historyManifest(path?: string) {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: digest('9'),
		operations: [historyManifestEntry(path)]
	});
}

describe('Pulse history live read', () => {
	test('resolves the exact binding and follows the safe event-history cursor', async () => {
		const calls: string[] = [];
		const request: PulseHistoryRequester = async ({ path }) => {
			calls.push(path);
			const first = calls.length === 1;
			return { kind: 'success', data: {
				kind: 'success', correlationId: id(900), data: {
					schemaVersion: 1, scope: 'event', entries: [historyEntry(first ? 60 : 61)],
					...(first ? { next: { occurredAt: '2026-08-14T10:00:00.000Z', id: id(60) } } : {})
				}
			} };
		};
		const port = createPulseHistoryLivePort({ manifest: historyManifest(), request });
		expect(await port.listEvent()).toEqual({
			kind: 'success', data: [historyEntry(60), historyEntry(61)]
		});
		expect(calls[0]).toBe('/api/workspace/history?view=event&limit=100');
		expect(calls[1]).toContain('beforeOccurredAt=2026-08-14T10%3A00%3A00.000Z');
		expect(calls[1]).toContain(`beforeId=${id(60)}`);
	});

	test('treats a path drift as an unavailable operation contract', async () => {
		const port: PulseHistoryReadPort = createPulseHistoryLivePort({
			manifest: historyManifest('/api/workspace/history-v2')
		});
		expect(await port.listEvent()).toEqual({
			kind: 'unavailable', reason: 'operation_contract_mismatch'
		});
	});
});
