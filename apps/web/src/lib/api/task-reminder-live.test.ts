import { describe, expect, test } from 'bun:test';
import type { CommunicationsAuthoringPort } from './communications-authoring-port';
import { createTaskReminderLiveSender, TaskReminderLiveError } from './task-reminder-live';
import { TASK_REMINDER_BODY } from './task-reminder-copy';
import { createLiveTasksPagePort } from './tasks-page-port.live';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = 'a'.repeat(64);

function fixture(recipientStates: readonly ('included' | 'excluded')[] = ['included', 'included']) {
	const calls: { payloads: unknown[]; sends: unknown[] } = { payloads: [], sends: [] };
	const port = {
		source: { kind: 'live' },
		async listPurposes() {
			return { kind: 'success', correlationId: id(90), data: {
				schemaVersion: 1,
				rows: [{ revision: {
					purposeId: id(1), purposeKey: 'task_reminder', revisionId: id(2),
					revisionNumber: 1, digestSha256: digest
				} }], page: { hasMore: false }
			} };
		},
		async storeAuthoringPayload(payload: unknown) {
			calls.payloads.push(payload);
			const kind = (payload as { payloadKind: string }).payloadKind;
			return { kind: 'success', correlationId: id(90), receipt: {}, data: {
				payloadRefId: id(calls.payloads.length + 10), payloadRefVersion: 1,
				payloadKind: kind, schemaKey: `schema.${kind}`, schemaVersion: 1,
				classification: `communication.${kind}`
			} };
		},
		async createDraft() {
			return { kind: 'success', correlationId: id(90), receipt: {}, data: { draftId: id(20), version: 1 } };
		},
		async prepareBatchPreview() {
			return { kind: 'success', correlationId: id(90), data: { preparationId: id(21) } };
		},
		async adoptBatchPreview() {
			return { kind: 'success', correlationId: id(90), receipt: {}, data: {
				identity: { audienceSpecId: id(22), draftId: id(20), draftVersion: 1, previewGeneration: 1 }
			} };
		},
		async listPreviewRecipients() {
			return { kind: 'success', correlationId: id(90), data: {
				rows: recipientStates.map((state, index) => ({ state, safeLabel: `Speaker ${index}` })),
				page: { hasMore: false }
			} };
		},
		async sendMessages(value: unknown) {
			calls.sends.push(value);
			return { kind: 'success', correlationId: id(90), receipt: {}, data: { batchId: id(30), releaseCount: 2 } };
		}
	} as unknown as CommunicationsAuthoringPort;
	return { calls, send: createTaskReminderLiveSender({ communications: port }) };
}

describe('live Task reminder composition', () => {
	test('authors opaque current-snapshot recipients and commits the adopted preview', async () => {
		const { calls, send } = fixture();
		await send([id(5), id(4), id(5)], 'Outstanding tasks');
		const audience = calls.payloads[1] as { value: { source: { contactRefIds: string[] } } };
		expect(audience.value.source.contactRefIds).toEqual([
			`task-engagement:${id(4)}`, `task-engagement:${id(5)}`
		]);
		expect(calls.sends).toHaveLength(1);
	});

	/**
	 * The send ceremony shows what this lane sends, and this lane mails a fixed
	 * body rather than rendering a template. Both read one owner, so the words a
	 * dialog promises and the bytes the sender stores cannot drift apart.
	 */
	test('puts the shared reminder body on the wire, which is what the ceremony previews', async () => {
		const { calls, send } = fixture();
		await send([id(4), id(5)], 'Outstanding tasks');
		const content = calls.payloads[0] as {
			value: { subject: string; body: { kind: string; text: string } };
		};
		expect(content.value.body).toEqual({ kind: 'plain_text/v1', text: TASK_REMINDER_BODY });
		// The subject is the operator's; only the body is fixed.
		expect(content.value.subject).toBe('Outstanding tasks');

		// And the ceremony's preview is that same string, from the same owner.
		const port = createLiveTasksPagePort({
			tasks: { source: { kind: 'live' } } as never,
			speakers: { speakers: { list: async () => [] } } as never,
			templates: { list: async () => ({ messages: [] }) } as never,
			schedule: { state: async () => ({}) } as never,
			remind: async () => undefined
		} as never);
		const preview = await port.tasks.reminderPreview!();
		expect(preview).toEqual({ kind: 'plain', subject: '', body: content.value.body.text });
	});

	test('refuses a changed eligibility set before the irreversible send', async () => {
		const { calls, send } = fixture(['included', 'excluded']);
		await expect(send([id(4), id(5)], 'Outstanding tasks')).rejects.toMatchObject({
			name: 'TaskReminderLiveError', code: 'task_reminder_audience_changed'
		} satisfies Partial<TaskReminderLiveError>);
		expect(calls.sends).toHaveLength(0);
	});
});
