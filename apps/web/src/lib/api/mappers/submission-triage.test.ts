import { describe, expect, test } from 'bun:test';
import {
	submissionTriageListSchema,
	submissionTriageProjectionSchema,
	submissionTriageReadSchema
} from '@jooevents/contracts/submission-triage';
import {
	mapSubmissionTriageAttribution,
	mapSubmissionTriageList,
	mapSubmissionTriageRead
} from './submission-triage';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const digest = (seed: string) => seed.repeat(64);
const workspaceId = id(1);
const eventId = id(2);
const submissionId = id(3);
const formId = id(4);
const formVersionId = id(5);
const arrivalId = id(6);
const fieldId = id(7);
const runId = id(8);

function row(input: {
	readonly state?: 'inbox' | 'set_aside' | 'discarded_recoverable';
	readonly arrival?: 'on_time' | 'late';
	readonly source?: 'public_form' | 'direct_entry' | 'import' | 'email';
	readonly attribution?: 'manual' | 'registered_run' | null;
	readonly abstract?: string | null;
	readonly categories?: boolean;
} = {}) {
	const state = input.state ?? 'inbox';
	const arrival = input.arrival ?? 'on_time';
	const source = input.source ?? 'public_form';
	const attribution = input.attribution ?? (state === 'set_aside' ? 'registered_run' : null);
	const visibleTray = state === 'discarded_recoverable'
		? 'discarded'
		: state === 'set_aside'
			? 'set_aside'
			: arrival === 'late' ? 'late' : 'inbox';
	return submissionTriageProjectionSchema.parse({
		schemaVersion: 1,
		source: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			source,
			summary: {
				schemaVersion: 1,
				id: submissionId,
				formId,
				formVersionId,
				target: { kind: 'general_pool' },
				title: 'A durable proposal',
				primaryParticipantName: 'Avery Stone',
				submittedAt: '2026-08-13T10:01:00.000Z'
			},
			detail: {
				schemaVersion: 1,
				submissionId,
				formId,
				formVersionId,
				submittedAt: '2026-08-13T10:01:00.000Z',
				participantCount: 1,
				answers: [{
					kind: 'textarea', fieldId, fieldLabel: 'Abstract', value: 'Practical systems.'
				}],
				affirmedConsentFieldIds: []
			},
			abstract: input.abstract === undefined ? 'Practical systems.' : input.abstract,
			track: input.categories ? { id: id(20), label: 'Infrastructure' } : null,
			format: input.categories ? { id: id(21), label: 'Talk' } : null
		},
		triage: {
			schemaVersion: 1,
			scope: { workspaceId, eventId },
			submissionId,
			version: 4,
			state,
			setAsideAttribution: state !== 'set_aside'
				? null
				: attribution === 'manual'
					? { kind: 'manual', principalKey: 'opaque:principal', invocationId: id(30), surface: 'operator_http' }
					: {
						kind: 'registered_run',
						runId,
						standingPolicy: {
							reference: { key: 'screening.relevance', version: 1 },
							definitionDigestSha256: digest('c')
						},
						invocationEvidenceIds: ['evidence:one']
					},
			updatedAt: '2026-08-13T10:02:00.000Z'
		},
		arrival: {
			schemaVersion: 1,
			id: arrivalId,
			scope: { workspaceId, eventId },
			submissionId,
			formId,
			formVersionId,
			source,
			submittedAt: '2026-08-13T10:01:00.000Z',
			classification: arrival,
			closeEvidence: arrival === 'late'
				? {
					closeAt: '2026-08-13T10:00:00.000Z',
					policy: {
						reference: { key: 'intake.soft_close', version: 1 },
						definitionDigestSha256: digest('d')
					}
				}
				: null,
			recordedAt: '2026-08-13T10:01:00.000Z'
		},
		visibleTray
	});
}

const queryGuard = Object.freeze({
	schemaVersion: 1 as const,
	scope: { workspaceId, eventId },
	version: 7,
	digestSha256: digest('a')
});

describe('Submission Triage source-neutral mapper', () => {
	test('keeps late as arrival-derived tray while the durable head remains inbox', () => {
		const mapped = mapSubmissionTriageRead(submissionTriageReadSchema.parse({
			schemaVersion: 1,
			queryGuard,
			row: row({ arrival: 'late' })
		}));
		expect(mapped).toMatchObject({
			head: { version: 4, state: 'inbox' },
			arrival: { classification: 'late' },
			visibleTray: 'late',
			source: { id: submissionId, title: 'A durable proposal' }
		});
	});

	test('preserves only supplied source facts and leaves absent fields null', () => {
		const mapped = mapSubmissionTriageRead(submissionTriageReadSchema.parse({
			schemaVersion: 1,
			queryGuard,
			row: row({ abstract: null, categories: false })
		}));
		expect(mapped.source).toMatchObject({
			id: submissionId,
			title: 'A durable proposal',
			primaryParticipantName: 'Avery Stone',
			abstract: null,
			track: null,
			format: null,
			source: 'public_form'
		});
		const serialized = JSON.stringify(mapped);
		for (const invented of ['email', 'decision', 'notified', 'signals', 'reviewCount']) {
			expect(serialized).not.toContain(`\"${invented}\"`);
		}
	});

	test('redacts opaque attribution identifiers without inventing display copy', () => {
		const registered = row({ state: 'set_aside', attribution: 'registered_run' });
		expect(mapSubmissionTriageAttribution(registered.triage.setAsideAttribution)).toEqual({
			kind: 'registered_run',
			standingPolicy: { key: 'screening.relevance', version: 1 }
		});
		const manual = row({ state: 'set_aside', attribution: 'manual' });
		expect(mapSubmissionTriageAttribution(manual.triage.setAsideAttribution)).toEqual({
			kind: 'manual'
		});
		const serialized = JSON.stringify(mapSubmissionTriageRead(submissionTriageReadSchema.parse({
			schemaVersion: 1, queryGuard, row: registered
		})));
		expect(serialized).not.toContain('opaque:principal');
		expect(serialized).not.toContain(runId);
		expect(serialized).not.toContain('Screening run');
	});

	test('preserves canonical source and page vocabulary without disguising email intake', () => {
		const mapped = mapSubmissionTriageList(submissionTriageListSchema.parse({
			schemaVersion: 1,
			queryGuard,
			rows: [row({ source: 'email', categories: true })],
			trayTotals: { inbox: 1, set_aside: 2, late: 3, discarded: 4 },
			search: { query: 'durable', matched: 1, scanned: 1 }
		}));
		expect(mapped).toMatchObject({
			trayTotals: { inbox: 1, set_aside: 2, late: 3, discarded: 4 },
			search: { query: 'durable', matched: 1, scanned: 1 },
			rows: [{ source: { source: 'email', track: { label: 'Infrastructure' } } }]
		});
		expect(mapped.queryGuard).toEqual(queryGuard);
	});
});
