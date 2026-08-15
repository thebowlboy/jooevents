import type { CommunicationsAuthoringPort } from './communications-authoring-port';

const PURPOSE_KEY = 'task_reminder';
const CONTACT_PREFIX = 'task-engagement:';
const actionKey = (stage: string) => `je.task-reminder.${stage}.${globalThis.crypto.randomUUID()}`;

export class TaskReminderLiveError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'TaskReminderLiveError';
	}
}

function requireSuccess<Data>(
	result: { readonly kind: string; readonly data?: Data },
	stage: string
): Data {
	if (result.kind !== 'success' || result.data === undefined) {
		throw new TaskReminderLiveError(
			`task_reminder_${stage}_failed`,
			'The reminder could not be prepared. Nothing was sent.'
		);
	}
	return result.data;
}

/** Reviewed Task selection composed through the canonical Communications lane. */
export function createTaskReminderLiveSender(input: {
	readonly communications: CommunicationsAuthoringPort;
}) {
	return async (speakerIds: readonly string[], subject: string): Promise<void> => {
		const selected = [...new Set(speakerIds)].sort();
		if (selected.length === 0) throw new TaskReminderLiveError('task_reminder_empty', 'Select a speaker first.');
		const purposes = requireSuccess(
			await input.communications.listPurposes({ channel: 'email', lifecycle: 'active' }),
			'purpose'
		);
		const purpose = purposes.rows.find((row) => row.revision.purposeKey === PURPOSE_KEY);
		if (!purpose) {
			throw new TaskReminderLiveError('task_reminder_purpose_missing', 'Task reminders are not configured for this event.');
		}
		const content = requireSuccess(
			await input.communications.storeAuthoringPayload({
				payloadKind: 'message_content', schemaVersion: 1,
				value: {
					kind: 'email/v1', subject,
					body: {
						kind: 'plain_text/v1',
						text: 'You have one or more outstanding speaker tasks. Open your JooEvents speaker checklist to review and complete them.'
					}
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
		const included = recipients.rows.filter((row) => row.state === 'included').length;
		if (included !== selected.length) {
			throw new TaskReminderLiveError(
				'task_reminder_audience_changed',
				'The outstanding-task selection changed while you were reviewing. Reopen the reminder to review the current recipients; nothing was sent.'
			);
		}
		requireSuccess(await input.communications.sendMessages({
			audienceSpecId: preview.identity.audienceSpecId,
			batchId: `batch.${globalThis.crypto.randomUUID()}`,
			subject,
			audienceLabel: 'Selected speakers with outstanding tasks'
		}, actionKey('send')), 'send');
	};
}
