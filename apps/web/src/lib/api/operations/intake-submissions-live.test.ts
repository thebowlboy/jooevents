import { describe, expect, test } from 'bun:test';
import {
	safeOperationManifestSchema,
	INTAKE_OPERATION_SCHEMA_REFS,
	type SafeOperationManifest,
	type SafeOperationManifestEntry,
	type SafePublicOperationBinding
} from '@jooevents/contracts';
import {
	createIntakeSubmissionsLivePort,
	INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION,
	INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION,
	INTAKE_SUBMISSION_CONTACT_READ_OPERATION,
	INTAKE_SUBMISSION_DETAIL_READ_OPERATION,
	INTAKE_SUBMISSION_LIST_READ_OPERATION,
	organizerSubmissionContactReadResultSchema,
	type IntakeSubmissionRequester
} from './intake-submissions-live';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const correlationId = id(900);

const bindings = {
	list: {
		surface: 'operator_http',
		protocol: 'http',
		method: 'GET',
		path: '/api/events/current/submissions',
		input: 'query',
		resultSchema: INTAKE_OPERATION_SCHEMA_REFS.submissionList.resultSchema,
		browserResumption: { kind: 'none' }
	},
	personList: {
		surface: 'operator_http',
		protocol: 'http',
		method: 'GET',
		path: '/api/events/current/submissions/by-person',
		input: 'query',
		resultSchema: INTAKE_OPERATION_SCHEMA_REFS.personSubmissionList.resultSchema,
		browserResumption: { kind: 'none' }
	},
	detail: {
		surface: 'operator_http',
		protocol: 'http',
		method: 'GET',
		path: '/api/events/current/submissions/detail',
		input: 'query',
		resultSchema: INTAKE_OPERATION_SCHEMA_REFS.submissionRead.resultSchema,
		browserResumption: { kind: 'none' }
	},
	contact: {
		surface: 'operator_http',
		protocol: 'http',
		method: 'GET',
		path: '/api/events/current/submissions/contact',
		input: 'query',
		resultSchema: INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead.resultSchema,
		browserResumption: { kind: 'none' }
	},
	contactList: {
		surface: 'operator_http',
		protocol: 'http',
		method: 'GET',
		path: '/api/events/current/submissions/contacts',
		input: 'query',
		resultSchema: INTAKE_OPERATION_SCHEMA_REFS.submissionContactList.resultSchema,
		browserResumption: { kind: 'none' }
	}
} as const satisfies Record<string, SafePublicOperationBinding>;

function operation(
	ref:
		| typeof INTAKE_SUBMISSION_LIST_READ_OPERATION
		| typeof INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION
		| typeof INTAKE_SUBMISSION_DETAIL_READ_OPERATION
		| typeof INTAKE_SUBMISSION_CONTACT_READ_OPERATION
		| typeof INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION,
	binding: SafePublicOperationBinding,
	schemas: typeof INTAKE_OPERATION_SCHEMA_REFS.submissionList,
	overrides: Partial<SafeOperationManifestEntry> = {}
): SafeOperationManifestEntry {
	return {
		name: ref.name,
		version: ref.version,
		lifecycle: { status: 'active' },
		summary: `Read ${ref.name}.`,
		effect: 'read',
		maxRisk: 'low',
		autonomy: {
			policy: { key: `autonomy.${ref.name}`, version: 1 },
			riskFloor: 'low',
			unattendedRiskCeiling: 'low',
			requiresSeparateApproval: false,
			supportedDispositions: ['proceed', 'block'],
			triggerDispositions: {
				authority_lost: 'block',
				unattended_bounds_exceeded: 'block',
				approval_required: 'block',
				known_retryable_failure: 'block',
				ambiguous_external_effect: 'block',
				stale_plan: 'block',
				compensation_required: 'block',
				terminal_failure: 'block'
			}
		},
		consequenceTags: ['disclosure'],
		inputSchema: schemas.inputSchema,
		idempotency: { required: false },
		concurrency: { kind: 'read_snapshot' },
		outcomes: [],
		enabledBindings: [binding],
		...overrides
	};
}

function manifest(
	operations: readonly SafeOperationManifestEntry[] = [
		operation(INTAKE_SUBMISSION_LIST_READ_OPERATION, bindings.list, INTAKE_OPERATION_SCHEMA_REFS.submissionList),
		operation(INTAKE_PERSON_SUBMISSION_LIST_READ_OPERATION, bindings.personList, INTAKE_OPERATION_SCHEMA_REFS.personSubmissionList),
		operation(INTAKE_SUBMISSION_DETAIL_READ_OPERATION, bindings.detail, INTAKE_OPERATION_SCHEMA_REFS.submissionRead),
		operation(INTAKE_SUBMISSION_CONTACT_READ_OPERATION, bindings.contact, INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead),
		operation(INTAKE_SUBMISSION_CONTACT_LIST_READ_OPERATION, bindings.contactList, INTAKE_OPERATION_SCHEMA_REFS.submissionContactList)
	]
): SafeOperationManifest {
	return safeOperationManifestSchema.parse({
		schemaVersion: 1,
		registryDigestSha256: 'f'.repeat(64),
		operations
	});
}

const summary = {
	schemaVersion: 1,
	id: id(1),
	formId: id(2),
	formVersionId: id(3),
	target: { kind: 'general_pool' },
	title: 'A dependable event system',
	primaryParticipantName: 'Amara Okafor',
	submittedAt: '2026-08-12T09:00:00.000Z'
} as const;

const detail = {
	schemaVersion: 1,
	submissionId: id(1),
	formId: id(2),
	formVersionId: id(3),
	submittedAt: '2026-08-12T09:00:00.000Z',
	participantCount: 1,
	answers: [
		{
			kind: 'text',
			fieldId: id(10),
			fieldLabel: 'Original session title',
			value: 'A dependable event system'
		},
		{
			kind: 'select',
			fieldId: id(11),
			fieldLabel: 'Original format',
			choice: { id: id(12), label: 'Original talk label' }
		}
	],
	affirmedConsentFieldIds: []
} as const;

const contact = {
	schemaVersion: 1,
	submissionId: id(1),
	personId: id(20),
	participantIdentityId: id(21),
	sourceFieldId: id(22),
	email: 'amara@example.com'
} as const;

function success(data: unknown) {
	return { kind: 'success', data, correlationId } as const;
}

function requesterFor(payloads: Readonly<Record<string, unknown>>, calls: string[]): IntakeSubmissionRequester {
	return async (input) => {
		calls.push(input.path);
		return { kind: 'success', data: payloads[input.path] };
	};
}

describe('pure-live organizer submissions operation port', () => {
	test('maps list and detail before making the separately requested contact read', async () => {
		const calls: string[] = [];
		const detailPath = `${bindings.detail.path}?submissionId=${encodeURIComponent(id(1))}`;
		const contactPath = `${bindings.contact.path}?submissionId=${encodeURIComponent(id(1))}`;
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: requesterFor(
				{
					[bindings.list.path]: success([summary]),
					[detailPath]: success(detail),
					[contactPath]: success(contact)
				},
				calls
			)
		});

		const listed = await port.list();
		expect(listed).toMatchObject({
			kind: 'success',
			data: [
				{
					id: id(1),
					title: 'A dependable event system',
					primaryParticipantName: 'Amara Okafor',
					target: { kind: 'general_pool', label: 'General pool' }
				}
			]
		});
		const read = await port.readDetail(id(1));
		expect(read).toMatchObject({
			kind: 'success',
			data: {
				answers: [
					{ fieldLabel: 'Original session title' },
					{ fieldLabel: 'Original format', choice: { label: 'Original talk label' } }
				]
			}
		});
		expect(calls).toEqual([bindings.list.path, detailPath]);
		expect(JSON.stringify([listed, read])).not.toContain(contact.email);

		if (port.contact.kind !== 'available') throw new TypeError('contact capability expected');
		const disclosed = await port.contact.read(id(1));
		expect(disclosed).toEqual({
			kind: 'success',
			data: { submissionId: id(1), email: contact.email },
			correlationId
		});
		expect(calls).toEqual([bindings.list.path, detailPath, contactPath]);
	});

	test('discloses a named contact batch in one request and omits missing rows', async () => {
		const calls: string[] = [];
		const listedPath = `${bindings.contactList.path}?submissionIds=${encodeURIComponent(id(1))}&submissionIds=${encodeURIComponent(id(2))}`;
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: requesterFor(
				{
					[listedPath]: success({ schemaVersion: 1, rows: [contact] })
				},
				calls
			)
		});
		if (port.contact.kind !== 'available') throw new TypeError('contact capability expected');
		expect(await port.contact.readMany([id(1), id(2)])).toEqual({
			kind: 'success',
			data: [{ submissionId: id(1), email: contact.email }],
			correlationId
		});
		expect(calls).toEqual([listedPath]);
	});

	test('gives a no-contact composition no contact method even when the operation is registered', async () => {
		const calls: string[] = [];
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'unavailable', reason: 'not_authorized' },
			request: requesterFor({ [bindings.list.path]: success([summary]) }, calls)
		});

		expect(port.contact).toEqual({ kind: 'unavailable', reason: 'not_authorized' });
		expect('read' in port.contact).toBe(false);
		expect(await port.list()).toMatchObject({ kind: 'success' });
		expect(calls).toEqual([bindings.list.path]);
	});

	test('reads every canonical Person proposal page without exposing identity in the result', async () => {
		const calls: string[] = [];
		const personId = id(500);
		const firstCursor = id(100);
		const firstPath = `${bindings.personList.path}?personId=${encodeURIComponent(personId)}`;
		const secondPath = `${firstPath}&afterSubmissionId=${encodeURIComponent(firstCursor)}`;
		const firstRows = Array.from({ length: 100 }, (_, index) => ({
			...summary,
			id: id(index + 1)
		}));
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: requesterFor({
				[firstPath]: success({
					schemaVersion: 1,
					rows: firstRows,
					nextAfterSubmissionId: firstCursor
				}),
				[secondPath]: success({
					schemaVersion: 1,
					rows: [{ ...summary, id: id(101), title: 'A second proposal' }],
					nextAfterSubmissionId: null
				})
			}, calls)
		});

		const result = await port.listForPerson(personId);
		expect(result).toMatchObject({ kind: 'success', data: { length: 101 } });
		expect(calls).toEqual([firstPath, secondPath]);
		expect(JSON.stringify(result)).not.toContain(personId);
	});

	test('preserves a server access refusal as an outcome instead of contact data', async () => {
		const calls: string[] = [];
		const contactPath = `${bindings.contact.path}?submissionId=${encodeURIComponent(id(1))}`;
		const outcome = organizerSubmissionContactReadResultSchema.parse({
			kind: 'outcome',
			correlationId,
			outcome: {
				class: 'access_denied',
				kind: 'authority.not_authorized',
				retryable: false,
				subjects: [{ type: 'submission', id: id(1) }],
				detail: { reason: 'current_authority_required' },
				detailSchemaVersion: 1
			}
		});
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: requesterFor({ [contactPath]: outcome }, calls)
		});
		if (port.contact.kind !== 'available') throw new TypeError('contact capability expected');

		expect(await port.contact.read(id(1))).toEqual(outcome);
		expect(calls).toEqual([contactPath]);
	});

	test('fails closed for missing bindings and contract-invalid wire data', async () => {
		let requested = false;
		const withoutList = manifest([
			operation(INTAKE_SUBMISSION_DETAIL_READ_OPERATION, bindings.detail, INTAKE_OPERATION_SCHEMA_REFS.submissionRead),
			operation(INTAKE_SUBMISSION_CONTACT_READ_OPERATION, bindings.contact, INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead)
		]);
		const missing = createIntakeSubmissionsLivePort({
			manifest: withoutList,
			contactCapability: { kind: 'available' },
			request: async () => {
				requested = true;
				return { kind: 'success', data: success([]) };
			}
		});
		expect(await missing.list()).toEqual({
			kind: 'unavailable',
			operation: 'list',
			reason: 'operation_not_registered'
		});
		expect(requested).toBe(false);

		const invalid = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: async () => ({
				kind: 'success',
				data: success([{ ...summary, id: id(2) }, summary])
			})
		});
		expect(await invalid.list()).toEqual({
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		});
	});

	test('rejects detail and contact projections for a different submission', async () => {
		const requestedId = id(1);
		const detailPath = `${bindings.detail.path}?submissionId=${encodeURIComponent(requestedId)}`;
		const contactPath = `${bindings.contact.path}?submissionId=${encodeURIComponent(requestedId)}`;
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'available' },
			request: requesterFor(
				{
					[detailPath]: success({ ...detail, submissionId: id(99) }),
					[contactPath]: success({ ...contact, submissionId: id(99) })
				},
				[]
			)
		});
		const invalidContract = {
			kind: 'transport_error',
			error: { code: 'invalid_contract', retryable: true }
		} as const;

		expect(await port.readDetail(requestedId)).toEqual(invalidContract);
		if (port.contact.kind !== 'available') throw new TypeError('contact capability expected');
		expect(await port.contact.read(requestedId)).toEqual(invalidContract);
	});

	test('accepts no actor, role, scope, permission, or authority input from the browser', () => {
		const port = createIntakeSubmissionsLivePort({
			manifest: manifest(),
			contactCapability: { kind: 'unavailable', reason: 'not_authorized' },
			request: async () => ({ kind: 'success', data: success([]) })
		});
		type ListOptions = NonNullable<Parameters<typeof port.list>[0]>;
		type DetailOptions = NonNullable<Parameters<typeof port.readDetail>[1]>;
		type ForbiddenList = Extract<
			keyof ListOptions,
			'actor' | 'role' | 'scope' | 'permission' | 'authority' | 'approval'
		>;
		type ForbiddenDetail = Extract<
			keyof DetailOptions,
			'actor' | 'role' | 'scope' | 'permission' | 'authority' | 'approval'
		>;
		const forbiddenList: readonly ForbiddenList[] = [];
		const forbiddenDetail: readonly ForbiddenDetail[] = [];
		expect(forbiddenList).toEqual([]);
		expect(forbiddenDetail).toEqual([]);
	});

	test('fails closed before disclosure when the contact input schema version drifts', async () => {
		const candidate = manifest([
			operation(
				INTAKE_SUBMISSION_CONTACT_READ_OPERATION,
				bindings.contact,
				INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead,
				{
					inputSchema: {
						...INTAKE_OPERATION_SCHEMA_REFS.submissionContactRead.inputSchema,
						version: 2
					}
				}
			)
		]);
		let requested = false;
		const port = createIntakeSubmissionsLivePort({
			manifest: candidate,
			contactCapability: { kind: 'available' },
			request: async () => {
				requested = true;
				return { kind: 'success', data: success(contact) };
			}
		});
		if (port.contact.kind !== 'available') throw new TypeError('contact capability expected');

		expect(await port.contact.read(id(1))).toEqual({
			kind: 'unavailable', operation: 'contact', reason: 'operation_contract_mismatch'
		});
		expect(requested).toBe(false);
	});
});
