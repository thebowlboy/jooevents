import {
	formDefinitionContentSchema,
	organizerFormCatalogSchema,
	organizerFormDetailSchema,
	type FieldRegistryFieldViewDto,
	type FormDefinitionContentDto,
	type FormFieldDefinitionDto,
	type OrganizerFormCatalogDto,
	type OrganizerFormDetailDto,
	type OrganizerFormFieldRowDto
} from '@jooevents/contracts';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;

export const intakeFormsFixtureIds = Object.freeze({
	workspace: id(900),
	event: id(901),
	user: id(902),
	openForm: id(1),
	draftForm: id(2),
	track: id(20),
	publishedVersion: id(201),
	titleField: id(101),
	abstractField: id(102),
	nameField: id(103),
	emailField: id(104),
	trackField: id(105),
	consentField: id(106)
});

export const sampleFormRegistryPin = Object.freeze({ version: 4, digestSha256: 'b'.repeat(64) });
const ordinary = Object.freeze({ kind: 'ordinary' as const });
const shared = Object.freeze({ kind: 'shared' as const });
const none = Object.freeze({ kind: 'none' as const });
const editable = Object.freeze({ removal: 'allowed' as const, applyVisibility: 'editable' as const });
const applyRequired = Object.freeze({
	apply: { visible: true, required: true },
	onboard: { visible: false, required: false },
	profile: { visible: true, required: false }
});

export const sampleFormRegistryFields: readonly FieldRegistryFieldViewDto[] = Object.freeze([
	{
		id: intakeFormsFixtureIds.titleField,
		key: 'talk.title',
		version: 2,
		kind: 'text',
		label: 'Session title',
		help: 'A clear title that helps reviewers understand the proposal.',
		answerOwner: 'talk',
		mapsTo: 'talk.title',
		purpose: ordinary,
		scope: shared,
		group: 'talk',
		position: 0,
		contexts: applyRequired,
		options: none,
		constraints: editable,
		fileUpload: 'not_applicable',
		resolvedOptions: null
	},
	{
		id: intakeFormsFixtureIds.abstractField,
		key: 'talk.abstract',
		version: 1,
		kind: 'textarea',
		label: 'Abstract',
		help: 'What will participants learn?',
		answerOwner: 'talk',
		mapsTo: 'talk.abstract',
		purpose: ordinary,
		scope: shared,
		group: 'talk',
		position: 1,
		contexts: applyRequired,
		options: none,
		constraints: editable,
		fileUpload: 'not_applicable',
		resolvedOptions: null
	},
	{
		id: intakeFormsFixtureIds.nameField,
		key: 'person.name',
		version: 1,
		kind: 'text',
		label: 'Your name',
		help: null,
		answerOwner: 'person',
		mapsTo: 'person.name',
		purpose: ordinary,
		scope: shared,
		group: 'identity',
		position: 2,
		contexts: applyRequired,
		options: none,
		constraints: editable,
		fileUpload: 'not_applicable',
		resolvedOptions: null
	},
	{
		id: intakeFormsFixtureIds.emailField,
		key: 'person.email',
		version: 1,
		kind: 'email',
		label: 'Email',
		help: 'Used for updates about this proposal.',
		answerOwner: 'person',
		mapsTo: 'person.email',
		purpose: ordinary,
		scope: shared,
		group: 'contact',
		position: 3,
		contexts: applyRequired,
		options: none,
		constraints: { removal: 'forbidden', applyVisibility: 'required_visible' },
		fileUpload: 'not_applicable',
		resolvedOptions: null
	},
	{
		id: intakeFormsFixtureIds.trackField,
		key: 'talk.track',
		version: 1,
		kind: 'select',
		label: 'Track',
		help: 'Choose the closest topic area.',
		answerOwner: 'talk',
		mapsTo: 'talk.track',
		purpose: ordinary,
		scope: shared,
		group: 'talk',
		position: 4,
		contexts: {
			apply: { visible: true, required: false },
			onboard: { visible: false, required: false },
			profile: { visible: true, required: false }
		},
		options: { kind: 'program_vocabulary', source: 'tracks' },
		constraints: editable,
		fileUpload: 'not_applicable',
		resolvedOptions: [{ id: intakeFormsFixtureIds.track, label: 'Platform engineering', version: 1 }]
	},
	{
		id: intakeFormsFixtureIds.consentField,
		key: 'consent.participation',
		version: 1,
		kind: 'checkbox',
		label: 'I agree to the event participation terms',
		help: null,
		answerOwner: 'person',
		mapsTo: null,
		purpose: { kind: 'consent', key: 'event_participation' },
		scope: shared,
		group: 'consent',
		position: 5,
		contexts: applyRequired,
		options: none,
		constraints: editable,
		fileUpload: 'not_applicable',
		resolvedOptions: null
	}
]);

function composition(excludedFieldIds: readonly string[] = []) {
	return {
		excludedFieldIds: [...excludedFieldIds].sort(),
		requiredOverrides: {},
		optionExposure: {}
	};
}

function definition(input: {
	readonly name: string;
	readonly target: FormDefinitionContentDto['target'];
	readonly confirmation: string;
	readonly excludedFieldIds?: readonly string[];
}): FormDefinitionContentDto {
	return formDefinitionContentSchema.parse({
		kind: 'cfp',
		name: input.name,
		target: input.target,
		availability: { kind: 'evergreen' },
		confirmation: input.confirmation,
		composition: composition(input.excludedFieldIds),
		rules: []
	});
}

const openDefinition = definition({
	name: 'Main call for proposals',
	target: { kind: 'general_pool' },
	confirmation: 'Thanks — your proposal has been received.'
});
const draftDefinition = definition({
	name: 'Workshop proposals',
	target: { kind: 'category', category: { kind: 'track', id: intakeFormsFixtureIds.track } },
	confirmation: 'Thanks — the workshop team will review your proposal.',
	excludedFieldIds: [intakeFormsFixtureIds.abstractField]
});

function row(field: FieldRegistryFieldViewDto, included: boolean): OrganizerFormFieldRowDto {
	return {
		field,
		included,
		required: field.contexts.apply.required,
		requiredOverridden: false,
		options: field.resolvedOptions?.map((option) => ({
			id: option.id,
			name: option.label,
			version: option.version,
			exposed: true
		})) ?? null,
		exposureAll: field.options.kind === 'program_vocabulary'
	};
}

export const sampleOrganizerFormRows = Object.freeze(
	sampleFormRegistryFields.map((field) => row(field, true))
);
const openRows = sampleOrganizerFormRows;
const draftRows = sampleFormRegistryFields.map((field) =>
	row(field, field.id !== intakeFormsFixtureIds.abstractField)
);

function publishedField(field: FieldRegistryFieldViewDto): FormFieldDefinitionDto {
	const base = {
		id: field.id,
		sourceFieldVersion: field.version,
		key: field.key,
		mapsTo: field.mapsTo,
		purpose: field.purpose,
		answerOwner: field.answerOwner,
		group: field.group,
		constraints: field.constraints,
		label: field.label,
		help: field.help,
		required: field.contexts.apply.required,
		initiallyVisible: true,
		position: field.position
	};
	switch (field.kind) {
		case 'text':
			return { kind: 'text', ...base, maximumLength: 500, options: none };
		case 'textarea':
			return { kind: 'textarea', ...base, maximumLength: 10_000, options: none };
		case 'email':
			return { kind: 'email', ...base, maximumLength: 320, options: none };
		case 'select':
			return {
				kind: 'select',
				...base,
				options: { kind: 'program_vocabulary', source: 'tracks', exposure: { kind: 'all_active' } }
			};
		case 'checkbox':
			return { kind: 'checkbox', ...base, options: none };
		default:
			throw new TypeError(`Unsupported fixture field kind: ${field.kind}`);
	}
}

const scope = Object.freeze({
	workspaceId: intakeFormsFixtureIds.workspace,
	eventId: intakeFormsFixtureIds.event
});

export const sampleOrganizerFormCatalogDto: OrganizerFormCatalogDto = organizerFormCatalogSchema.parse({
	schemaVersion: 1,
	catalogVersion: 3,
	registryPin: sampleFormRegistryPin,
	forms: [
		{
			schemaVersion: 1,
			id: intakeFormsFixtureIds.openForm,
			name: openDefinition.name,
			target: openDefinition.target,
			availability: openDefinition.availability,
			status: 'open',
			version: 2,
			currentPublishedVersionId: intakeFormsFixtureIds.publishedVersion,
			composition: openDefinition.composition,
			registryPin: sampleFormRegistryPin,
			closesAt: null,
			fieldCount: openRows.filter((item) => item.included).length,
			configurationIssues: [],
			submissionCount: 18,
			updatedAt: '2026-08-10T09:30:00.000Z'
		},
		{
			schemaVersion: 1,
			id: intakeFormsFixtureIds.draftForm,
			name: draftDefinition.name,
			target: draftDefinition.target,
			availability: draftDefinition.availability,
			status: 'draft',
			version: 1,
			currentPublishedVersionId: null,
			composition: draftDefinition.composition,
			registryPin: sampleFormRegistryPin,
			closesAt: null,
			fieldCount: draftRows.filter((item) => item.included).length,
			configurationIssues: [],
			submissionCount: 0,
			updatedAt: '2026-08-11T14:15:00.000Z'
		}
	]
});

const openDetail = organizerFormDetailSchema.parse({
	schemaVersion: 1,
	head: {
		schemaVersion: 1,
		id: intakeFormsFixtureIds.openForm,
		scope,
		version: 2,
		status: 'open',
		currentPublishedVersionId: intakeFormsFixtureIds.publishedVersion,
		definition: openDefinition,
		createdByUserId: intakeFormsFixtureIds.user,
		createdAt: '2026-08-01T08:00:00.000Z',
		updatedByUserId: intakeFormsFixtureIds.user,
		updatedAt: '2026-08-10T09:30:00.000Z'
	},
	registryPin: sampleFormRegistryPin,
	fields: openRows,
	configurationIssues: [],
	currentPublishedVersion: {
		schemaVersion: 1,
		id: intakeFormsFixtureIds.publishedVersion,
		formId: intakeFormsFixtureIds.openForm,
		scope,
		number: 1,
		sourceDefinitionVersion: 1,
		sourceDefinitionDigestSha256: 'a'.repeat(64),
		registryPin: sampleFormRegistryPin,
		definitionDigestSha256: 'c'.repeat(64),
		definition: {
			kind: openDefinition.kind,
			name: openDefinition.name,
			target: openDefinition.target,
			availability: openDefinition.availability,
			confirmation: openDefinition.confirmation,
			fields: sampleFormRegistryFields.map(publishedField),
			rules: []
		},
		targetPin: null,
		deadlinePin: null,
		publishedByUserId: intakeFormsFixtureIds.user,
		publishedAt: '2026-08-02T10:00:00.000Z'
	}
});

const draftDetail = organizerFormDetailSchema.parse({
	schemaVersion: 1,
	head: {
		schemaVersion: 1,
		id: intakeFormsFixtureIds.draftForm,
		scope,
		version: 1,
		status: 'draft',
		currentPublishedVersionId: null,
		definition: draftDefinition,
		createdByUserId: intakeFormsFixtureIds.user,
		createdAt: '2026-08-11T14:15:00.000Z',
		updatedByUserId: intakeFormsFixtureIds.user,
		updatedAt: '2026-08-11T14:15:00.000Z'
	},
	registryPin: sampleFormRegistryPin,
	fields: draftRows,
	configurationIssues: [],
	currentPublishedVersion: null
});

export const sampleOrganizerFormDetailDtos: Readonly<Record<string, OrganizerFormDetailDto>> =
	Object.freeze({
		[intakeFormsFixtureIds.openForm]: openDetail,
		[intakeFormsFixtureIds.draftForm]: draftDetail
	});
