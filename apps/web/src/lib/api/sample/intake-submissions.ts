import { submittedAtLabel } from '../mappers/intake-submissions';
import type { WorkspaceDataset } from './dataset';
import type { Submission } from '../types';
import type {
	OrganizerSubmissionContactView,
	OrganizerSubmissionDetailView,
	OrganizerSubmissionReadResult,
	OrganizerSubmissionsPort,
	OrganizerSubmissionSummaryView
} from '../view-models/intake-submissions';

type SampleSubmissionDataset = Pick<
	WorkspaceDataset,
	'key' | 'name' | 'description' | 'tracks' | 'formats' | 'submissions'
>;

export type SampleSubmissionContactCapability =
	| { readonly kind: 'available' }
	| { readonly kind: 'unavailable'; readonly reason: 'not_enabled' | 'not_authorized' };

export interface ResettableSampleIntakeSubmissionsPort extends OrganizerSubmissionsPort {
	/** Restores this adapter's isolated safe projection to its initial scenario image. */
	reset(): void;
}

interface SafeSampleRecord {
	readonly summary: OrganizerSubmissionSummaryView;
	readonly detail: OrganizerSubmissionDetailView;
	readonly contact?: OrganizerSubmissionContactView;
}

function frozenChoice(id: string, label: string) {
	return Object.freeze({ id, label });
}

function projectRecord(
	dataset: SampleSubmissionDataset,
	submission: Submission,
	includeContact: boolean
): SafeSampleRecord {
	const track = dataset.tracks.find((entry) => entry.id === submission.trackId);
	const format = dataset.formats.find((entry) => entry.id === submission.formatId);
	const formId = `sample-form:${dataset.key}`;
	const formVersionId = `${formId}:version-1`;
	const summary = Object.freeze({
		id: submission.id,
		formId,
		formVersionId,
		target: Object.freeze({
			kind: 'category' as const,
			categoryKind: 'track' as const,
			categoryId: submission.trackId,
			label: track?.name ?? 'Track target'
		}),
		title: submission.title,
		primaryParticipantName: submission.speakers[0]?.name ?? null,
		submittedAt: submission.submittedAt,
		submittedAtLabel: submittedAtLabel(submission.submittedAt)
	}) satisfies OrganizerSubmissionSummaryView;
	const answers = Object.freeze([
		Object.freeze({
			type: 'text' as const,
			fieldId: `sample-field:${submission.id}:title`,
			fieldLabel: 'Session title',
			value: submission.title
		}),
		Object.freeze({
			type: 'textarea' as const,
			fieldId: `sample-field:${submission.id}:abstract`,
			fieldLabel: 'Abstract',
			value: submission.abstract
		}),
		Object.freeze({
			type: 'select' as const,
			fieldId: `sample-field:${submission.id}:track`,
			fieldLabel: 'Track',
			choice: frozenChoice(submission.trackId, track?.name ?? submission.trackId)
		}),
		Object.freeze({
			type: 'select' as const,
			fieldId: `sample-field:${submission.id}:format`,
			fieldLabel: 'Format',
			choice: frozenChoice(submission.formatId, format?.name ?? submission.formatId)
		})
	]);
	const detail = Object.freeze({
		submissionId: submission.id,
		formId,
		formVersionId,
		submittedAt: submission.submittedAt,
		submittedAtLabel: submittedAtLabel(submission.submittedAt),
		participantCount: submission.speakers.length,
		answers,
		affirmedConsentFieldIds: Object.freeze([] as string[])
	}) satisfies OrganizerSubmissionDetailView;
	const primary = submission.speakers[0];
	const contact =
		includeContact && primary
			? Object.freeze({ submissionId: submission.id, email: primary.email })
			: undefined;
	return Object.freeze({ summary, detail, ...(contact ? { contact } : {}) });
}

function success<Data>(data: Data): OrganizerSubmissionReadResult<Data> {
	return { kind: 'success', data };
}

function missing<Data>(): OrganizerSubmissionReadResult<Data> {
	return {
		kind: 'transport_error',
		error: { code: 'not_found', retryable: false }
	};
}

/**
 * Adapts an existing resettable product scenario to the same privacy-safe port
 * as live. The retained state is projected at construction: a no-contact
 * adapter keeps no email in its records and has no contact read method.
 */
export function createSampleIntakeSubmissionsPort(input: {
	readonly dataset: SampleSubmissionDataset;
	readonly contactCapability: SampleSubmissionContactCapability;
}): ResettableSampleIntakeSubmissionsPort {
	const includeContact = input.contactCapability.kind === 'available';
	const seed = Object.freeze(
		input.dataset.submissions.map((submission) => projectRecord(input.dataset, submission, includeContact))
	);
	let records = [...seed];
	const contact =
		input.contactCapability.kind === 'unavailable'
			? Object.freeze({
					kind: 'unavailable' as const,
					reason: input.contactCapability.reason
				})
			: Object.freeze({
					kind: 'available' as const,
					async read(submissionId: string) {
						const value = records.find((record) => record.summary.id === submissionId)?.contact;
						return value ? success(value) : missing<OrganizerSubmissionContactView>();
					}
				});

	return Object.freeze({
		source: Object.freeze({
			kind: 'sample' as const,
			label: 'Sample data' as const,
			scenario: Object.freeze({
				key: input.dataset.key,
				name: input.dataset.name,
				description: input.dataset.description
			})
		}),
		async list() {
			return success(Object.freeze(records.map((record) => record.summary)));
		},
		async readDetail(submissionId: string) {
			const value = records.find((record) => record.summary.id === submissionId)?.detail;
			return value ? success(value) : missing<OrganizerSubmissionDetailView>();
		},
		contact,
		reset() {
			records = [...seed];
		}
	});
}
