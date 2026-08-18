import { describe, expect, test } from 'bun:test';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import { REVIEWER_REMINDER_BODY } from './reviewer-reminder-copy';
import {
	createReviewerReminderLiveSender,
	ReviewerReminderLiveError
} from './reviewer-reminder-live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = 'a'.repeat(64);

function fixture(recipientStates: readonly ('included' | 'excluded')[] = ['included', 'included']) {
	const calls: { payloads: unknown[]; sends: unknown[] } = { payloads: [], sends: [] };
	const port = {
		async listPurposes() {
			return { kind: 'success', data: { rows: [{ revision: {
				purposeId: id(1), purposeKey: 'reviewer_reminder', revisionId: id(2),
				revisionNumber: 1, digestSha256: digest
			} }] } };
		},
		async storeAuthoringPayload(payload: unknown) {
			calls.payloads.push(payload);
			return { kind: 'success', data: {
				payloadRefId: id(10 + calls.payloads.length), payloadRefVersion: 1,
				payloadKind: (payload as { payloadKind: string }).payloadKind
			} };
		},
		async createDraft() { return { kind: 'success', data: { draftId: id(20), version: 1 } }; },
		async prepareBatchPreview() { return { kind: 'success', data: { preparationId: id(21) } }; },
		async adoptBatchPreview() {
			return { kind: 'success', data: { identity: {
				audienceSpecId: id(22), draftId: id(20), draftVersion: 1, previewGeneration: 1
			} } };
		},
		async listPreviewRecipients() {
			return { kind: 'success', data: {
				rows: recipientStates.map((state, index) => ({ state, safeLabel: `Reviewer ${index}` }))
			} };
		},
		async sendMessages(value: unknown) {
			calls.sends.push(value);
			return { kind: 'success', data: { batchId: id(30), releaseCount: 2 } };
		}
	} as unknown as CommunicationsAuthoringPort;
	return { calls, send: createReviewerReminderLiveSender({ communications: port }) };
}

describe('live reviewer reminder composition', () => {
	test('canonicalizes reviewer contacts and sends the exact reviewed body', async () => {
		const { calls, send } = fixture();
		await send([id(5), id(4), id(5)], 'Reviews still open');
		const content = calls.payloads[0] as { value: { body: { text: string } } };
		const audience = calls.payloads[1] as {
			value: { source: { contactRefIds: string[] } };
		};
		expect(content.value.body.text).toBe(REVIEWER_REMINDER_BODY);
		expect(audience.value.source.contactRefIds).toEqual([
			`reviewer:${id(4)}`, `reviewer:${id(5)}`
		]);
		expect(calls.sends).toEqual([expect.objectContaining({
			audienceLabel: 'Selected reviewers with outstanding reviews'
		})]);
	});

	test('refuses before send when any selected reviewer is no longer included', async () => {
		const { calls, send } = fixture(['included', 'excluded']);
		await expect(send([id(4), id(5)], 'Reviews still open')).rejects.toMatchObject({
			name: 'ReviewerReminderLiveError', code: 'reviewer_reminder_audience_changed'
		} satisfies Partial<ReviewerReminderLiveError>);
		expect(calls.sends).toHaveLength(0);
	});
});
