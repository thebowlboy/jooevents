import { describe, expect, test } from 'bun:test';
import type { DecisionStateSnapshotDto } from '@jooevents/contracts';
import type { SubmissionTriagePageView, SubmissionTriageRowView } from '../mappers/submission-triage';
import { createLiveScheduleAttributionSource } from './schedule-attribution.live';

const id = (value: number) =>
	`00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

function row(value: number): SubmissionTriageRowView {
	const submissionId = id(value);
	return {
		source: {
			id: submissionId, formId: id(2), formVersionId: id(3),
			target: { kind: 'general_pool' }, title: `Talk ${value}`,
			primaryParticipantName: `Person ${value}`,
			submittedAt: '2026-08-18T01:00:00.000Z', source: 'public_form',
			abstract: null, track: null, format: null,
			detail: {} as never
		},
		head: { version: 1, state: 'inbox', setAsideAttribution: null, updatedAt: '2026-08-18T01:00:00.000Z' },
		arrival: {} as never, visibleTray: 'inbox', queryGuard: {} as never
	};
}

function page(rows: readonly SubmissionTriageRowView[], population = rows.length): SubmissionTriagePageView {
	return {
		rows, trayTotals: { inbox: population, set_aside: 0, late: 0, spam: 0 },
		search: null, queryGuard: {} as never
	};
}

function accepted(
	submissionId: string,
	origin: DecisionStateSnapshotDto['rows'][number]['origin'] = null
): DecisionStateSnapshotDto['rows'][number] {
	return {
		submissionId,
		head: {
			schemaVersion: 1, scope: { workspaceId: id(10), eventId: id(11) },
			submissionId, state: 'accepted', version: 1, digestSha256: 'a'.repeat(64),
			decidedByUserId: id(12), decidedAt: '2026-08-18T02:00:00.000Z'
		},
		origin
	};
}

describe('live Schedule attribution source', () => {
	test('serves accepted origin and unrouted facts from one proven-complete population', async () => {
		const routed = row(20);
		const unrouted = row(21);
		const source = createLiveScheduleAttributionSource({
			list: async () => ({ kind: 'success', data: page([routed, unrouted]), correlationId: id(90) }),
			decisions: { readState: async (ids) => ({
				kind: 'success', correlationId: id(91), data: { schemaVersion: 1, rows: ids.map((submissionId) =>
					accepted(submissionId, submissionId === routed.source.id ? {
						schemaVersion: 1, scope: { workspaceId: id(10), eventId: id(11) },
						submissionId, sessionId: id(30), kind: 'attached',
						linkedByUserId: id(12), linkedAt: '2026-08-18T02:00:00.000Z'
					} : null)
				) }
			}) }
		});

		const result = await source.read();
		expect(result.kind).toBe('success');
		if (result.kind !== 'success') return;
		expect(result.data.map((entry) => ({ id: entry.id, decision: entry.decision, origin: entry.origin }))).toEqual([
			{ id: routed.source.id, decision: 'accepted', origin: { sessionId: id(30), kind: 'attached' } },
			{ id: unrouted.source.id, decision: 'accepted', origin: null }
		]);
	});

	test('refuses a truncated triage page before reading decisions', async () => {
		let decisionReads = 0;
		const source = createLiveScheduleAttributionSource({
			list: async () => ({ kind: 'success', data: page([row(20)], 2), correlationId: id(90) }),
			decisions: { readState: async () => {
				decisionReads += 1;
				throw new Error('must not read');
			} }
		});
		expect(await source.read()).toEqual({
			kind: 'unavailable', reason: 'schedule_attribution_population_truncated'
		});
		expect(decisionReads).toBe(0);
	});

	test('chunks Decision reads at the wire limit', async () => {
		const rows = Array.from({ length: 101 }, (_, index) => row(index + 100));
		const chunks: number[] = [];
		const source = createLiveScheduleAttributionSource({
			list: async () => ({ kind: 'success', data: page(rows), correlationId: id(90) }),
			decisions: { readState: async (ids) => {
				chunks.push(ids.length);
				return { kind: 'success', correlationId: id(91), data: {
					schemaVersion: 1, rows: ids.map((submissionId) => ({ submissionId, head: null, origin: null }))
				} };
			} }
		});
		expect((await source.read()).kind).toBe('success');
		expect(chunks).toEqual([100, 1]);
	});
});
