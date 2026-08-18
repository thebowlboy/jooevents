import { describe, expect, test } from 'bun:test';
import { createSampleDecisionsPagePort } from './decisions-page-port.sample';
import { api } from './workspace';
import { recipientTemplate } from '../features/workspace/components/recipient-preview';

/**
 * What the decision send ceremony can show. One batch mails an acceptance to
 * one speaker and a waitlist notice to another, so the evidence has to be
 * per-recipient: their own letter, resolved with their own submission.
 */

describe('the decision notification review', () => {
	test('names the template each row actually receives, not the batch headline', async () => {
		const port = createSampleDecisionsPagePort(api);
		const page = await port.submissions.list({ tray: 'inbox' });
		const ids = page.rows
			.filter((row) => row.decision !== 'undecided' && !row.notified)
			.map((row) => row.id);
		const review = await port.decisions.reviewNotification(ids);

		const keys = new Set(review.recipients.map((row) => row.templateKey));
		// The batch genuinely spans outcomes; a single stated template could only
		// have been right for some of these people.
		expect(keys.size).toBeGreaterThan(1);
		for (const row of review.recipients) {
			expect(row.templateKey).toMatch(/^decision-(accepted|waitlisted|declined)$/);
		}
	});

	test('carries each person’s own submission, so nobody is shown another’s talk', async () => {
		const port = createSampleDecisionsPagePort(api);
		const page = await port.submissions.list({ tray: 'inbox' });
		const ids = page.rows
			.filter((row) => row.decision !== 'undecided' && !row.notified)
			.map((row) => row.id);
		const review = await port.decisions.reviewNotification(ids);

		for (const row of review.recipients) {
			expect(row.mergeValues?.['submission.title']).toBeDefined();
			// The one-line sample and the merge value describe one submission.
			expect(row.mergeSample).toContain(row.mergeValues!['submission.title']!);
		}
	});

	test('resolving a row against its template yields that person’s copy', async () => {
		const port = createSampleDecisionsPagePort(api);
		const page = await port.submissions.list({ tray: 'inbox' });
		const ids = page.rows
			.filter((row) => row.decision !== 'undecided' && !row.notified)
			.map((row) => row.id);
		const review = await port.decisions.reviewNotification(ids);
		const { messages } = await port.templates.list();

		const row = review.recipients[0]!;
		const template = messages.find((entry) => entry.key === row.templateKey)!;
		const resolved = recipientTemplate(template, row, 'Your decision');

		const sampleOf = (key: string) =>
			resolved.mergeFields.find((field) => field.key === key)?.sample;
		// Their name resolves the speaker token, their submission the rest — the
		// template's declared samples belong to somebody else entirely.
		expect(sampleOf('speaker.name')).toBe(row.name);
		expect(sampleOf('submission.title')).toBe(row.mergeValues!['submission.title']);
		// The edited subject rides on top so the ceremony reflects what is typed.
		expect(resolved.subject).toBe('Your decision');
	});

	test('an empty subject leaves the template’s own line rather than blanking it', async () => {
		const port = createSampleDecisionsPagePort(api);
		const { messages } = await port.templates.list();
		const template = messages.find((entry) => entry.key === 'decision-accepted')!;
		const resolved = recipientTemplate(template, { name: 'Ada' }, '   ');
		expect(resolved.subject).toBe(template.subject);
	});

	test('the sample lane serves a brand to draw the preview in', async () => {
		const port = createSampleDecisionsPagePort(api);
		expect(await port.theme!.get()).toBeDefined();
		// And composes no server-rendered preview: its bodies are stored
		// templates rendered in the browser.
		expect(port.decisions.previewRecipient).toBeUndefined();
	});
});
