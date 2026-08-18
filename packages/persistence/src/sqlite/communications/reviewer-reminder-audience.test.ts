import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createEventCommunicationPurposeSeedPlan } from '@jooevents/communications';
import { parseEventId, parseWorkspaceId } from '@jooevents/kernel';
import { createSQLiteReviewerReminderAudienceSource } from './reviewer-reminder-audience';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const digest = (value: string) => value.repeat(64).slice(0, 64);
const scope = { workspaceId: parseWorkspaceId(id(1)), eventId: parseEventId(id(2)) };
const purposeRevision = createEventCommunicationPurposeSeedPlan(scope).reviewerReminderPurpose
	.purposeRevision;

const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((sqlite) => sqlite.close(false)));

function fixture() {
	const sqlite = new Database(':memory:', { strict: true });
	databases.push(sqlite);
	sqlite.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
		CREATE TABLE workspace_memberships (
			id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
			status TEXT NOT NULL, version INTEGER NOT NULL
		);
		CREATE TABLE user_emails (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_email TEXT NOT NULL,
			verified INTEGER NOT NULL, verified_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
		);
		CREATE TABLE unrelated_speaker_contacts (id TEXT PRIMARY KEY, email TEXT NOT NULL);
	`);

	const reviewers = [4, 5, 6, 7, 8, 9].map((value) => ({
		schemaVersion: 1, scope, reviewerId: id(value), version: 1,
		state: value === 8 ? 'revoked' : 'included',
		accessSubject: {
			kind: value === 7 ? 'access_reservation' : 'workspace_membership',
			id: id(100 + value), version: 1
		},
		reviews: [], addedByUserId: id(3), addedAt: '2026-08-19T00:00:00.000Z',
		...(value === 8
			? { revokedByUserId: id(3), revokedAt: '2026-08-19T01:00:00.000Z' }
			: {})
	}));
	const facts = reviewers.map((record, index) => ({
		schemaVersion: 1, scope, rosterSubject: record.accessSubject,
		currentSubject: record.accessSubject,
		state: record.accessSubject.kind === 'access_reservation' ? 'reserved' : 'active',
		version: 1, capabilityIds: [], evidenceIds: [], digestSha256: digest(String(index + 1)),
		displayName: `Reviewer ${record.reviewerId.slice(-2)}`
	}));
	const assignments = [
		{ id: id(204), roundId: id(200), submissionId: id(304), reviewerId: id(4), version: 1, state: 'assigned' },
		{ id: id(205), roundId: id(200), submissionId: id(305), reviewerId: id(5), version: 1, state: 'assigned' },
		{ id: id(206), roundId: id(200), submissionId: id(306), reviewerId: id(6), version: 1, state: 'assigned' },
		{ id: id(207), roundId: id(200), submissionId: id(307), reviewerId: id(7), version: 1, state: 'assigned' },
		{ id: id(208), roundId: id(200), submissionId: id(308), reviewerId: id(8), version: 1, state: 'assigned' },
		{ id: id(209), roundId: id(200), submissionId: id(309), reviewerId: id(9), version: 2, state: 'stepped_back' }
	];
	const completed = new Set([id(206)]);

	for (const value of [4, 5, 6, 8, 9]) {
		sqlite.query(`INSERT INTO users VALUES (?,'active')`).run(id(400 + value));
		sqlite.query(`INSERT INTO workspace_memberships VALUES (?,?,?,'active',1)`).run(
			id(100 + value), scope.workspaceId, id(400 + value)
		);
	}
	sqlite.query(`INSERT INTO user_emails VALUES (?,?,?,1,?,NULL,?)`).run(
		id(504), id(404), 'reviewer.four@example.test', 1, 1
	);
	sqlite.query(`INSERT INTO user_emails VALUES (?,?,?,1,?,NULL,?)`).run(
		id(505), id(405), 'reviewer.five@example.test', 1, 1
	);
	// The completed reviewer has two eligible addresses; either condition independently excludes them.
	sqlite.query(`INSERT INTO user_emails VALUES (?,?,?,1,?,NULL,?)`).run(id(506), id(406), 'six.a@example.test', 1, 1);
	sqlite.query(`INSERT INTO user_emails VALUES (?,?,?,1,?,NULL,?)`).run(id(507), id(406), 'six.b@example.test', 1, 1);
	// Equal email in an unrelated speaker record is deliberately not an identity edge.
	sqlite.query(`INSERT INTO unrelated_speaker_contacts VALUES (?,?)`).run(
		id(600), 'reviewer.four@example.test'
	);

	const roster = {
		readReviewerRoster: () => ({
			schemaVersion: 1, scope, version: 3, digestSha256: digest('a'), reviewers
		}),
		readReviewerAuthority: () => ({
			schemaVersion: 1, scope, version: 4, digestSha256: digest('b'), facts
		})
	};
	const reviews = {
		readCatalog: () => ({ rounds: [{ id: id(200), state: 'open' }] }),
		listAssignments: () => assignments,
		readReviewHead: (_scope: unknown, assignmentId: string) =>
			completed.has(assignmentId) ? { assignmentId } : undefined
	};
	const source = createSQLiteReviewerReminderAudienceSource({
		sqlite,
		roster: roster as never,
		reviews: reviews as never,
		addressFingerprintKeyBytes: new Uint8Array(32).fill(7),
		addressFingerprintProfile: { key: 'reviewer-address.test', version: 1 }
	});
	const audience = {
		schemaVersion: 1,
		binding: 'current_snapshot',
		purposeRevision,
		source: { kind: 'explicit_contacts', contactRefIds: [] }
	} as const;
	return { sqlite, source, audience, completed, reviewers, facts };
}

describe('SQLite reviewer reminder audience', () => {
	test('keeps exactly selected active reviewers with unfinished assignments', () => {
		const { source, audience } = fixture();
		const snapshot = source.resolveExplicitContacts!({
			scope,
			audience: { ...audience, source: {
				kind: 'explicit_contacts',
				contactRefIds: [`reviewer:${id(4)}`, `reviewer:${id(5)}`, `reviewer:${id(6)}`]
			} },
			contactRefIds: [`reviewer:${id(4)}`, `reviewer:${id(5)}`, `reviewer:${id(6)}`]
		});
		expect(snapshot.candidates.map((candidate) => candidate.contactRefId)).toEqual([
			`reviewer:${id(4)}`, `reviewer:${id(5)}`
		]);
		expect(new Set(snapshot.candidates.map((candidate) => candidate.personRefId)).size).toBe(2);
	});

	test('excludes reservation-only, revoked, completed, and stepped-back reviewers', () => {
		const { source, audience } = fixture();
		const refs = [6, 7, 8, 9].map((value) => `reviewer:${id(value)}`);
		const snapshot = source.resolveExplicitContacts!({
			scope, audience: { ...audience, source: { kind: 'explicit_contacts', contactRefIds: refs } },
			contactRefIds: refs
		});
		expect(snapshot.candidates).toEqual([]);
	});

	test('follows membership to one User address and reports ambiguity as no eligible address', () => {
		const { source, audience, completed } = fixture();
		const selected = source.resolveExplicitContacts!({
			scope,
			audience: { ...audience, source: {
				kind: 'explicit_contacts', contactRefIds: [`reviewer:${id(4)}`]
			} },
			contactRefIds: [`reviewer:${id(4)}`]
		}).candidates[0]!;
		const resolved = source.resolveEmail({ scope, purposeRevision, candidate: selected,
			asOf: '2026-08-19T02:00:00.000Z' });
		expect(resolved.kind).toBe('evaluated');
		if (resolved.kind === 'evaluated') {
			expect(resolved.address.contactRefId).toBe(`reviewer:${id(4)}`);
			expect(resolved.address.classifiedValue.value).toBe('reviewer.four@example.test');
		}

		completed.delete(id(206));
		const ambiguous = source.resolveExplicitContacts!({
			scope,
			audience: { ...audience, source: {
				kind: 'explicit_contacts', contactRefIds: [`reviewer:${id(6)}`]
			} },
			contactRefIds: [`reviewer:${id(6)}`]
		}).candidates[0]!;
		expect(source.resolveEmail({ scope, purposeRevision, candidate: ambiguous,
			asOf: '2026-08-19T02:00:00.000Z' })).toMatchObject({ kind: 'no_eligible_address' });
	});
});
