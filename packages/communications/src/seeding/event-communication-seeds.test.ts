import { describe, expect, test } from 'bun:test';
import { createEventCommunicationPurposeSeedPlan } from './event-communication-seeds';

const scope = {
	workspaceId: '550e8400-e29b-41d4-a716-446655440000',
	eventId: '019c1df7-86b5-769b-bba4-5f7097bfa141'
};

describe('event communication purpose seeds', () => {
	test('deterministically includes the dedicated reviewer reminder purpose', () => {
		const first = createEventCommunicationPurposeSeedPlan(scope);
		const second = createEventCommunicationPurposeSeedPlan(scope);
		expect(first.reviewerReminderPurpose).toEqual(second.reviewerReminderPurpose);
		expect(first.reviewerReminderPurpose).toMatchObject({
			label: 'Reviewer reminders',
			purposeRevision: { purposeKey: 'reviewer_reminder' }
		});
		expect(first.purposes.map((purpose) => purpose.purposeRevision.purposeKey)).toContain(
			'reviewer_reminder'
		);
	});
});
