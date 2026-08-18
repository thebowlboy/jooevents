import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import { REVIEWER_REMINDER_BODY } from './reviewer-reminder-copy';

const PURPOSE_KEY = 'reviewer_reminder';
const CONTACT_PREFIX = 'reviewer:';
const actionKey = (stage: string) => `je.reviewer-reminder.${stage}.${globalThis.crypto.randomUUID()}`;

export class ReviewerReminderLiveError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'ReviewerReminderLiveError';
	}
}

function requireSuccess<Data>(
	result: { readonly kind: string; readonly data?: Data },
	stage: string
): Data {
	if (result.kind !== 'success' || result.data === undefined) {
		throw new ReviewerReminderLiveError(
			`reviewer_reminder_${stage}_failed`,
			'The reminder could not be prepared. Nothing was sent.'
		);
	}
	return result.data;
}

/** Reviewed reviewer selection composed through the canonical Communications lane. */
export function createReviewerReminderLiveSender(input: {
	readonly communications: CommunicationsAuthoringPort;
}) {
	return async (reviewerIds: readonly string[], subject: string): Promise<void> => {
		const selected = [...new Set(reviewerIds)].sort();
		if (selected.length === 0) {
			throw new ReviewerReminderLiveError('reviewer_reminder_empty', 'Select a reviewer first.');
		}
		const purposes = requireSuccess(
			await input.communications.listPurposes({ channel: 'email', lifecycle: 'active' }),
			'purpose'
		);
		const purpose = purposes.rows.find((row) => row.revision.purposeKey === PURPOSE_KEY);
		if (!purpose) {
			throw new ReviewerReminderLiveError(
				'reviewer_reminder_purpose_missing',
				'Reviewer reminders are not configured for this event.'
			);
		}
		const content = requireSuccess(
			await input.communications.storeAuthoringPayload({
				payloadKind: 'message_content', schemaVersion: 1,
				value: {
					kind: 'email/v1', subject,
					body: { kind: 'plain_text/v1', text: REVIEWER_REMINDER_BODY }
				}
			}, actionKey('content')),
			'content'
		);
		const audience = requireSuccess(
			await input.communications.storeAuthoringPayload({
				payloadKind: 'message_audience_draft', schemaVersion: 1,
				value: {
					schemaVersion: 1,
					binding: 'current_snapshot',
					purposeRevision: structuredClone(purpose.revision) as never,
					source: {
						kind: 'explicit_contacts',
						contactRefIds: selected.map((id) => `${CONTACT_PREFIX}${id}`)
					}
				}
			}, actionKey('audience')),
			'audience'
		);
		const draft = requireSuccess(
			await input.communications.createDraft({
				channel: 'email',
				purposeRevision: structuredClone(purpose.revision) as never,
				initial: {
					kind: 'adopted_payload_refs',
					contentPayload: structuredClone(content) as never,
					audiencePayload: structuredClone(audience) as never
				}
			}, actionKey('draft')),
			'draft'
		);
		requireSuccess(await input.communications.prepareBatchPreview({
			draftId: draft.draftId, expectedDraftVersion: draft.version
		}), 'prepare');
		const preview = requireSuccess(
			await input.communications.adoptBatchPreview({
				draftId: draft.draftId, expectedDraftVersion: draft.version
			}, actionKey('preview')),
			'preview'
		);
		const recipients = requireSuccess(
			await input.communications.listPreviewRecipients(structuredClone(preview.identity) as never),
			'recipients'
		);
		if (recipients.rows.length !== selected.length
			|| recipients.rows.some((row) => row.state !== 'included')) {
			throw new ReviewerReminderLiveError(
				'reviewer_reminder_audience_changed',
				'The unfinished-review selection changed while you were reviewing. Reopen the reminder to review the current recipients; nothing was sent.'
			);
		}
		requireSuccess(await input.communications.sendMessages({
			audienceSpecId: preview.identity.audienceSpecId,
			batchId: `batch.${globalThis.crypto.randomUUID()}`,
			subject,
			audienceLabel: 'Selected reviewers with outstanding reviews'
		}, actionKey('send')), 'send');
	};
}
