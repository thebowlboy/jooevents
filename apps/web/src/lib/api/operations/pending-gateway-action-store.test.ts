import { describe, expect, test } from 'bun:test';
import {
	encodeGatewayPendingActionResolutionProofClaims,
	parseGatewayAuthorityProjection,
	parseGatewayPendingActionResolutionBinding,
	parseGatewayPendingActionResolutionProof,
	type GatewayAuthorityProjection,
	type GatewayPendingActionResolutionBinding,
	type GatewayPendingActionResolutionProof,
	type GatewayPrincipalPartitionKey
} from '@jooevents/contracts';
import {
	parseGatewayActionKey,
	parseGatewayCompletionReference,
	parseGatewayDisclosureEpoch,
	parseGatewayPrincipalPartitionKey,
	parseGatewayScopeKey,
	parseGatewaySourceKey,
	parseGatewayStageIdempotencyKey,
	parsePendingGatewayActionRecord,
	pendingGatewayActionPartitionKey,
	pendingGatewayActionStorageKey,
	type GatewayActionKey,
	type GatewayDisclosureEpoch,
	type PendingGatewayActionIdentity,
	type PendingGatewayActionPartition,
	type PendingGatewayActionRecord
} from './pending-gateway-action';
import {
	createIndexedDbPendingGatewayActionDriver,
	createPendingGatewayActionStore,
	type PendingGatewayActionResolutionProofVerifier,
	type PendingGatewayActionStorageDriver,
	type PendingGatewayActionStorageRow
} from './pending-gateway-action-store';

class MemoryDriver implements PendingGatewayActionStorageDriver {
	readonly rows = new Map<string, PendingGatewayActionStorageRow>();
	unavailable = false;

	private ready(): void {
		if (this.unavailable) throw new Error('storage_unavailable');
	}

	async create(row: PendingGatewayActionStorageRow): Promise<'created' | 'exists'> {
		this.ready();
		if (this.rows.has(row.storageKey)) return 'exists';
		this.rows.set(row.storageKey, structuredClone(row));
		return 'created';
	}

	async get(storageKey: PendingGatewayActionStorageRow['storageKey']) {
		this.ready();
		const row = this.rows.get(storageKey);
		return row ? structuredClone(row) : null;
	}

	async list(partitionKey: PendingGatewayActionStorageRow['partitionKey']) {
		this.ready();
		return [...this.rows.values()]
			.filter((row) => row.partitionKey === partitionKey)
			.map((row) => structuredClone(row));
	}

	async compareAndSwap(
		storageKey: PendingGatewayActionStorageRow['storageKey'],
		expectedRevision: number,
		next: PendingGatewayActionStorageRow
	): Promise<'advanced' | 'stale' | 'not_found'> {
		this.ready();
		const current = this.rows.get(storageKey);
		if (!current) return 'not_found';
		if (current.revision !== expectedRevision) return 'stale';
		this.rows.set(storageKey, structuredClone(next));
		return 'advanced';
	}

	async deleteIfRevision(
		storageKey: PendingGatewayActionStorageRow['storageKey'],
		expectedRevision: number
	): Promise<'deleted' | 'stale' | 'not_found'> {
		this.ready();
		const current = this.rows.get(storageKey);
		if (!current) return 'not_found';
		if (current.revision !== expectedRevision) return 'stale';
		this.rows.delete(storageKey);
		return 'deleted';
	}
}

const sourceKey = parseGatewaySourceKey('gws_0123456789abcdef');
const scopeKey = parseGatewayScopeKey('gsc_0123456789abcdef');
const principalPartitionKey = parseGatewayPrincipalPartitionKey('gpp_0123456789abcdef');
const disclosureEpoch = parseGatewayDisclosureEpoch('gde_0123456789abcdef');
const changedDisclosureEpoch = parseGatewayDisclosureEpoch('gde_fedcba9876543210');

function authority(input: {
	readonly current?: GatewayPrincipalPartitionKey;
	readonly aliases?: readonly GatewayPrincipalPartitionKey[];
	readonly epoch?: GatewayDisclosureEpoch;
} = {}): GatewayAuthorityProjection {
	return parseGatewayAuthorityProjection({
		schemaVersion: 1,
		principalPartition: {
			current: input.current ?? principalPartitionKey,
			aliases: input.aliases ?? []
		},
		disclosureEpoch: input.epoch ?? disclosureEpoch
	});
}

function identity(actionKey: GatewayActionKey): PendingGatewayActionIdentity {
	return { sourceKey, scopeKey, principalPartitionKey, actionKey };
}

const partition: PendingGatewayActionPartition = { sourceKey, scopeKey, principalPartitionKey };

function record(input: {
	readonly action?: string;
	readonly epoch?: GatewayDisclosureEpoch;
	readonly createdAt?: string;
	readonly expiresAt?: string;
	readonly retainUntil?: string;
} = {}): PendingGatewayActionRecord {
	const createdAt = input.createdAt ?? '2026-08-11T00:00:00.000Z';
	return parsePendingGatewayActionRecord({
		schemaVersion: 1,
		identity: identity(parseGatewayActionKey(input.action ?? 'gac_0123456789abcdef')),
		disclosureEpoch: input.epoch ?? disclosureEpoch,
		choreography: { key: 'program_vocabulary.create', version: 1 },
		createdAt,
		updatedAt: createdAt,
		expiresAt: input.expiresAt ?? '2026-08-12T00:00:00.000Z',
		retainUntil: input.retainUntil ?? '2026-08-15T00:00:00.000Z',
		revision: 1,
		state: { kind: 'active' },
		currentStep: {
			stepKey: 'draft',
			operation: { name: 'program_vocabulary.create.draft', version: 1 },
			idempotencyKey: parseGatewayStageIdempotencyKey('gik_0123456789abcdef'),
			request: {
				kind: 'safe_inline',
				classificationPolicy: { key: 'browser_safe.program_vocabulary', version: 1 },
				inputSchema: {
					key: 'schema.program_vocabulary.create.input',
					version: 1,
					digestSha256: 'a'.repeat(64)
				},
				maximumCanonicalBytes: 256,
				value: { expectedSetVersion: 4, name: 'Workshop' }
			}
		},
		completedSteps: []
	});
}

function clock(initial = '2026-08-11T00:00:01.000Z') {
	let value = initial;
	return {
		now: () => new Date(value),
		set: (next: string) => {
			value = next;
		}
	};
}

const resolutionVerifierProfile = {
	key: 'gateway.pending_action_resolution.hmac',
	version: 1
} as const;
const disposableResolutionKey = new TextEncoder().encode(
	'jooevents-disposable-resolution-key-v1'
);

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function bytesFromHex(value: string): Uint8Array<ArrayBuffer> {
	const pairs = value.match(/.{2}/g) ?? [];
	const result = new Uint8Array(pairs.length);
	for (const [index, pair] of pairs.entries()) result[index] = Number.parseInt(pair, 16);
	return result;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(value.byteLength);
	result.set(value);
	return result;
}

class DisposableResolutionProofCodec implements PendingGatewayActionResolutionProofVerifier {
	readonly consumedProofIds = new Set<string>();
	private nextProof = 1;

	constructor(
		private readonly currentTime: () => Date,
		readonly verifierProfile: PendingGatewayActionResolutionProofVerifier['verifierProfile'] =
			resolutionVerifierProfile
	) {}

	private async key(): Promise<CryptoKey> {
		return await crypto.subtle.importKey(
			'raw',
			disposableResolutionKey,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);
	}

	async issue(
		binding: GatewayPendingActionResolutionBinding,
		options: { readonly lifetimeMs?: number } = {}
	): Promise<GatewayPendingActionResolutionProof> {
		const issuedAt = this.currentTime();
		const claims = {
			schemaVersion: 1,
			purpose: 'pending_action_disclosure_rebind',
			proofId: `gar_${String(this.nextProof).padStart(16, '0')}`,
			verifierProfile: this.verifierProfile,
			binding: parseGatewayPendingActionResolutionBinding(binding),
			issuedAt: issuedAt.toISOString(),
			expiresAt: new Date(
				issuedAt.getTime() + (options.lifetimeMs ?? 60_000)
			).toISOString(),
			replayMode: 'single_use'
		} as const;
		this.nextProof += 1;
		const tag = await crypto.subtle.sign(
			'HMAC',
			await this.key(),
			ownedBytes(encodeGatewayPendingActionResolutionProofClaims(claims))
		);
		return parseGatewayPendingActionResolutionProof({
			...claims,
			authenticator: { algorithm: 'hmac_sha256', tagHex: hex(tag) }
		});
	}

	async verifyAndConsume(input: {
		readonly proof: GatewayPendingActionResolutionProof;
		readonly expectedBinding: GatewayPendingActionResolutionBinding;
	}) {
		const proof = parseGatewayPendingActionResolutionProof(input.proof);
		const now = this.currentTime().getTime();
		if (
			JSON.stringify(proof.verifierProfile) !== JSON.stringify(this.verifierProfile) ||
			JSON.stringify(proof.binding) !== JSON.stringify(input.expectedBinding) ||
			now < Date.parse(proof.issuedAt) ||
			now >= Date.parse(proof.expiresAt)
		) {
			return { kind: 'rejected' as const };
		}
		const verified = await crypto.subtle.verify(
			'HMAC',
			await this.key(),
			bytesFromHex(proof.authenticator.tagHex),
			ownedBytes(encodeGatewayPendingActionResolutionProofClaims(proof))
		);
		if (!verified || this.consumedProofIds.has(proof.proofId)) {
			return { kind: 'rejected' as const };
		}
		this.consumedProofIds.add(proof.proofId);
		return { kind: 'verified' as const, proof };
	}
}

const rejectingResolutionProofVerifier: PendingGatewayActionResolutionProofVerifier =
	Object.freeze({
		verifierProfile: resolutionVerifierProfile,
		async verifyAndConsume() {
			return { kind: 'rejected' as const };
		}
	});

function storeOptions(
	driver: PendingGatewayActionStorageDriver,
	time: ReturnType<typeof clock>,
	resolutionProofVerifier: PendingGatewayActionResolutionProofVerifier =
		rejectingResolutionProofVerifier
) {
	return { driver, clock: time.now, resolutionProofVerifier };
}

function rowOf(value: PendingGatewayActionRecord): PendingGatewayActionStorageRow {
	return {
		storageKey: pendingGatewayActionStorageKey(value.identity),
		partitionKey: pendingGatewayActionPartitionKey(value.identity),
		revision: value.revision,
		value
	};
}

describe('PendingGatewayAction durable store', () => {
	test('survives store recreation and lists only the exact source/scope/principal partition', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const first = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		expect(await first.create({ record: target, authority: authority() }))
			.toMatchObject({ kind: 'created' });

		const restarted = createPendingGatewayActionStore(storeOptions(driver, time));
		const loaded = await restarted.get({
			identity: target.identity,
			authority: authority()
		});
		expect(loaded).toEqual({ kind: 'recoverable', record: target });
		const listed = await restarted.list({ sourceKey, scopeKey, authority: authority() });
		expect(listed).toEqual({
			kind: 'success',
			recoverable: [target],
			requiresServerResolution: []
		});

		const otherPartitions: PendingGatewayActionPartition[] = [
			{ ...partition, sourceKey: parseGatewaySourceKey('gws_fedcba9876543210') },
			{ ...partition, scopeKey: parseGatewayScopeKey('gsc_fedcba9876543210') },
			{
				...partition,
				principalPartitionKey: parseGatewayPrincipalPartitionKey('gpp_fedcba9876543210')
			}
		];
		for (const other of otherPartitions) {
			const otherAuthority = authority({ current: other.principalPartitionKey });
			expect(
				await restarted.list({
					sourceKey: other.sourceKey,
					scopeKey: other.scopeKey,
					authority: otherAuthority
				})
			).toEqual({
				kind: 'success',
				recoverable: [],
				requiresServerResolution: []
			});
		}
	});

	test('rebinds a quarantined epoch only with an exact authenticated server resolution', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const codec = new DisposableResolutionProofCodec(time.now);
		const store = createPendingGatewayActionStore(storeOptions(driver, time, codec));
		const target = record();
		await store.create({ record: target, authority: authority() });

		const listed = await store.list({
			sourceKey,
			scopeKey,
			authority: authority({ epoch: changedDisclosureEpoch })
		});
		expect(listed.kind).toBe('success');
		if (listed.kind !== 'success') throw new TypeError('expected_success');
		expect(listed.recoverable).toEqual([]);
		expect(listed.requiresServerResolution).toHaveLength(1);
		const ticket = listed.requiresServerResolution[0];
		expect(ticket).toMatchObject({
			kind: 'requires_server_resolution',
			reason: 'disclosure_epoch_changed',
			binding: {
				pendingActionIdentity: target.identity,
				currentPrincipalPartitionKey: principalPartitionKey,
				previousDisclosureEpoch: disclosureEpoch,
				resolvedDisclosureEpoch: changedDisclosureEpoch,
				pendingActionRevision: 2,
				currentStep: {
					stepKey: target.currentStep.stepKey,
					operation: target.currentStep.operation,
					idempotencyKey: target.currentStep.idempotencyKey
				}
			}
		});
		expect(Object.keys(ticket ?? {}).sort()).toEqual(['binding', 'kind', 'reason']);
		if (!ticket) throw new TypeError('expected_resolution_ticket');

		const stored = driver.rows.get(pendingGatewayActionStorageKey(target.identity));
		const quarantined = parsePendingGatewayActionRecord(stored?.value);
		expect(quarantined.state).toMatchObject({
			kind: 'quarantined',
			requiresServerResolution: true
		});
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority({ epoch: changedDisclosureEpoch }),
				expectedRevision: 2,
				next: { ...quarantined, revision: 3 }
			})
		).toMatchObject({
			kind: 'requires_server_resolution',
			binding: { pendingActionRevision: 2 }
		});

		expect(await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: 'gpp_0123456789abcdef' as never
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });

		const mismatchedBindings = [
			{
				...ticket.binding,
				pendingActionIdentity: {
					...ticket.binding.pendingActionIdentity,
					sourceKey: parseGatewaySourceKey('gws_fedcba9876543210')
				}
			},
			{
				...ticket.binding,
				pendingActionIdentity: {
					...ticket.binding.pendingActionIdentity,
					scopeKey: parseGatewayScopeKey('gsc_fedcba9876543210')
				}
			},
			{
				...ticket.binding,
				pendingActionIdentity: {
					...ticket.binding.pendingActionIdentity,
					actionKey: parseGatewayActionKey('gac_fedcba9876543210')
				}
			},
			{
				...ticket.binding,
				currentPrincipalPartitionKey: parseGatewayPrincipalPartitionKey(
					'gpp_bbbbbbbbbbbbbbbb'
				)
			},
			{
				...ticket.binding,
				resolvedDisclosureEpoch: parseGatewayDisclosureEpoch('gde_aaaaaaaaaaaaaaaa')
			},
			{
				...ticket.binding,
				previousDisclosureEpoch: parseGatewayDisclosureEpoch('gde_bbbbbbbbbbbbbbbb')
			},
			{ ...ticket.binding, pendingActionRevision: ticket.binding.pendingActionRevision + 1 },
			{
				...ticket.binding,
				currentStep: { ...ticket.binding.currentStep, stepKey: 'commit' }
			},
			{
				...ticket.binding,
				currentStep: {
					...ticket.binding.currentStep,
					operation: { ...ticket.binding.currentStep.operation, name: 'event.settings.update' }
				}
			},
			{
				...ticket.binding,
				currentStep: {
					...ticket.binding.currentStep,
					operation: { ...ticket.binding.currentStep.operation, version: 2 }
				}
			},
			{
				...ticket.binding,
				currentStep: {
					...ticket.binding.currentStep,
					idempotencyKey: parseGatewayStageIdempotencyKey('gik_fedcba9876543210')
				}
			}
		].map(parseGatewayPendingActionResolutionBinding);
		for (const mismatchedBinding of mismatchedBindings) {
			const mismatchedProof = await codec.issue(mismatchedBinding);
			expect(await store.rebindDisclosureEpoch({
				identity: target.identity,
				authority: authority({ epoch: changedDisclosureEpoch }),
				expectedRevision: 2,
				resolutionProof: mismatchedProof
			})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });
		}
		const rotatedCodec = new DisposableResolutionProofCodec(time.now, {
			...resolutionVerifierProfile,
			version: 2
		});
		const wrongProfileProof = await rotatedCodec.issue(ticket.binding);
		expect(await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: wrongProfileProof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });

		const expiredProof = await codec.issue(ticket.binding, { lifetimeMs: 1_000 });
		time.set('2026-08-11T00:00:02.000Z');
		expect(await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: expiredProof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });

		const proof = await codec.issue(ticket.binding);
		const inventedProof = parseGatewayPendingActionResolutionProof({
			...proof,
			proofId: 'gar_fedcba9876543210',
			authenticator: { ...proof.authenticator, tagHex: 'f'.repeat(64) }
		});
		expect(await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: inventedProof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });
		const unavailableVerifier: PendingGatewayActionResolutionProofVerifier = {
			verifierProfile: resolutionVerifierProfile,
			async verifyAndConsume() {
				throw new Error('server_unavailable');
			}
		};
		const unavailableStore = createPendingGatewayActionStore(
			storeOptions(driver, time, unavailableVerifier)
		);
		expect(await unavailableStore.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: proof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_verifier_unavailable' });

		const rebound = await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: proof
		});
		expect(rebound).toMatchObject({
			kind: 'rebound',
			record: {
				identity: target.identity,
				disclosureEpoch: changedDisclosureEpoch,
				revision: 3,
				state: { kind: 'active' },
				currentStep: target.currentStep
			}
		});
		const persisted = JSON.stringify(
			driver.rows.get(pendingGatewayActionStorageKey(target.identity))
		);
		expect(persisted).not.toContain(proof.proofId);
		expect(persisted).not.toContain(proof.authenticator.tagHex);
		expect(codec.consumedProofIds.has(proof.proofId)).toBe(true);
		expect(await store.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 3,
			resolutionProof: proof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });
		expect(await store.get({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch })
		})).toMatchObject({ kind: 'recoverable', record: { revision: 3 } });
	});

	test('single-use resolution survives browser-store recreation and rejects replay', async () => {
		const firstDriver = new MemoryDriver();
		const secondDriver = new MemoryDriver();
		const time = clock();
		const codec = new DisposableResolutionProofCodec(time.now);
		const firstStore = createPendingGatewayActionStore(
			storeOptions(firstDriver, time, codec)
		);
		const target = record();
		await firstStore.create({ record: target, authority: authority() });
		const listed = await firstStore.list({
			sourceKey,
			scopeKey,
			authority: authority({ epoch: changedDisclosureEpoch })
		});
		if (listed.kind !== 'success' || !listed.requiresServerResolution[0]) {
			throw new TypeError('expected_resolution_ticket');
		}
		for (const [key, value] of firstDriver.rows) {
			secondDriver.rows.set(key, structuredClone(value));
		}
		const proof = await codec.issue(listed.requiresServerResolution[0].binding);
		expect(await firstStore.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: proof
		})).toMatchObject({ kind: 'rebound' });

		const recreatedStore = createPendingGatewayActionStore(
			storeOptions(secondDriver, time, codec)
		);
		expect(await recreatedStore.rebindDisclosureEpoch({
			identity: target.identity,
			authority: authority({ epoch: changedDisclosureEpoch }),
			expectedRevision: 2,
			resolutionProof: proof
		})).toEqual({ kind: 'unavailable', reason: 'resolution_proof_rejected' });
	});

	test('recovers retained-profile records only through a server-issued alias projection', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		await store.create({ record: target, authority: authority() });
		const rotatedKey = parseGatewayPrincipalPartitionKey('gpp_aaaaaaaaaaaaaaaa');
		const rotatedAuthority = authority({
			current: rotatedKey,
			aliases: [principalPartitionKey]
		});

		expect(await store.list({
			sourceKey,
			scopeKey,
			authority: rotatedAuthority
		})).toMatchObject({
			kind: 'success',
			recoverable: [{ identity: target.identity }]
		});
		expect(await store.list({
			sourceKey,
			scopeKey,
			authority: authority({ current: rotatedKey })
		})).toEqual({
			kind: 'success',
			recoverable: [],
			requiresServerResolution: []
		});
	});

	test('keeps a near-rotation maximum-lifetime record reachable through terminal retention', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record({
			expiresAt: '2026-09-10T00:00:00.000Z',
			retainUntil: '2026-09-17T00:00:00.000Z'
		});
		await store.create({ record: target, authority: authority() });
		const rotatedAuthority = authority({
			current: parseGatewayPrincipalPartitionKey('gpp_aaaaaaaaaaaaaaaa'),
			aliases: [principalPartitionKey]
		});

		time.set('2026-09-09T23:59:59.999Z');
		expect(await store.get({ identity: target.identity, authority: rotatedAuthority }))
			.toMatchObject({ kind: 'recoverable' });
		time.set('2026-09-10T00:00:00.000Z');
		expect(await store.get({ identity: target.identity, authority: rotatedAuthority }))
			.toMatchObject({ kind: 'terminal', state: 'expired' });
		time.set('2026-09-16T23:59:59.999Z');
		expect(await store.get({ identity: target.identity, authority: rotatedAuthority }))
			.toMatchObject({ kind: 'terminal', state: 'expired' });
		time.set('2026-09-17T00:00:00.000Z');
		expect(await store.get({ identity: target.identity, authority: rotatedAuthority }))
			.toEqual({ kind: 'not_found' });
	});

	test('rejects creation and recovery when the server projection is absent or mismatched', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		expect(await store.create({
			record: target,
			authority: undefined as never
		})).toEqual({ kind: 'unavailable', reason: 'authority_unavailable' });
		expect(await store.create({
			record: target,
			authority: authority({
				current: parseGatewayPrincipalPartitionKey('gpp_bbbbbbbbbbbbbbbb')
			})
		})).toEqual({ kind: 'unavailable', reason: 'invalid_record' });
		expect(driver.rows).toHaveLength(0);
	});

	test('allows exactly one cross-tab CAS winner and preserves the idempotent stage on replay', async () => {
		const driver = new MemoryDriver();
		const time = clock('2026-08-11T00:01:00.000Z');
		const firstTab = createPendingGatewayActionStore(storeOptions(driver, time));
		const secondTab = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		await firstTab.create({ record: target, authority: authority() });

		const abandoned = {
			...target,
			revision: 2,
			updatedAt: '2026-08-11T00:00:30.000Z',
			state: { kind: 'abandoned', abandonedAt: '2026-08-11T00:00:30.000Z' }
		};
		const completed = {
			...target,
			revision: 2,
			updatedAt: '2026-08-11T00:00:31.000Z',
			state: { kind: 'completed', completedAt: '2026-08-11T00:00:31.000Z' },
			completedSteps: [
				{
					stepKey: target.currentStep.stepKey,
					operation: target.currentStep.operation,
					completionReference: parseGatewayCompletionReference('gcr_0123456789abcdef')
				}
			]
		};
		const results = await Promise.all([
			firstTab.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 1,
				next: abandoned
			}),
			secondTab.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 1,
				next: completed
			})
		]);
		expect(results.filter((result) => result.kind === 'advanced')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'stale')).toHaveLength(1);

		const stored = driver.rows.get(pendingGatewayActionStorageKey(target.identity));
		const winner = parsePendingGatewayActionRecord(stored?.value);
		expect(winner.currentStep).toEqual(target.currentStep);
		expect(winner.currentStep.idempotencyKey).toBe(target.currentStep.idempotencyKey);
		expect(winner.currentStep.request).toEqual(target.currentStep.request);
	});

	test('rejects a forged terminal completion without final-step server evidence', async () => {
		const driver = new MemoryDriver();
		const time = clock('2026-08-11T00:02:00.000Z');
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		await store.create({ record: target, authority: authority() });

		const forgedCompletion = {
			...target,
			revision: 2,
			updatedAt: '2026-08-11T00:01:00.000Z',
			state: { kind: 'completed', completedAt: '2026-08-11T00:01:00.000Z' }
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 1,
				next: forgedCompletion
			})
		).toEqual({ kind: 'invalid_transition' });

		const finalCompletion = {
			...forgedCompletion,
			completedSteps: [
				{
					stepKey: target.currentStep.stepKey,
					operation: target.currentStep.operation,
					completionReference: parseGatewayCompletionReference('gcr_0123456789abcdef')
				}
			]
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 1,
				next: finalCompletion
			})
		).toMatchObject({
			kind: 'advanced',
			record: {
				state: { kind: 'completed' },
				completedSteps: [{ completionReference: 'gcr_0123456789abcdef' }]
			}
		});
	});

	test('permits a same-stage revision only with the exact retry anchor and requires completion evidence to advance', async () => {
		const driver = new MemoryDriver();
		const time = clock('2026-08-11T00:02:00.000Z');
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		await store.create({ record: target, authority: authority() });
		const sameStage = {
			...target,
			revision: 2,
			updatedAt: '2026-08-11T00:01:00.000Z'
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 1,
				next: sameStage
			})
		).toMatchObject({ kind: 'advanced', record: { revision: 2 } });

		const changedRetry = {
			...sameStage,
			revision: 3,
			updatedAt: '2026-08-11T00:01:30.000Z',
			currentStep: {
				...sameStage.currentStep,
				idempotencyKey: parseGatewayStageIdempotencyKey('gik_fedcba9876543210')
			}
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 2,
				next: changedRetry
			})
		).toEqual({ kind: 'invalid_transition' });
		const changedRequest = {
			...sameStage,
			revision: 3,
			updatedAt: '2026-08-11T00:01:30.000Z',
			currentStep: {
				...sameStage.currentStep,
				request: {
					...sameStage.currentStep.request,
					value: { expectedSetVersion: 5, name: 'Workshop' }
				}
			}
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 2,
				next: changedRequest
			})
		).toEqual({ kind: 'invalid_transition' });

		const nextStep = {
			...sameStage,
			revision: 3,
			updatedAt: '2026-08-11T00:01:30.000Z',
			completedSteps: [
				{
					stepKey: sameStage.currentStep.stepKey,
					operation: sameStage.currentStep.operation,
					completionReference: parseGatewayCompletionReference('gcr_0123456789abcdef')
				}
			],
			currentStep: {
				stepKey: 'commit',
				operation: { name: 'event.settings.update', version: 1 },
				idempotencyKey: parseGatewayStageIdempotencyKey('gik_fedcba9876543210'),
				request: sameStage.currentStep.request
			}
		};
		expect(
			await store.compareAndSwap({
				identity: target.identity,
				authority: authority(),
				expectedRevision: 2,
				next: nextStep
			})
		).toMatchObject({ kind: 'advanced', record: { revision: 3 } });
	});

	test('expires records, retains terminal evidence briefly, then removes only local metadata', async () => {
		const driver = new MemoryDriver();
		const time = clock();
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record({
			expiresAt: '2026-08-11T00:01:00.000Z',
			retainUntil: '2026-08-11T00:02:00.000Z'
		});
		await store.create({ record: target, authority: authority() });

		time.set('2026-08-11T00:01:00.000Z');
		expect(
			await store.get({ identity: target.identity, authority: authority() })
		).toMatchObject({
			kind: 'terminal',
			state: 'expired',
			revision: 2
		});
		expect(driver.rows).toHaveLength(1);

		time.set('2026-08-11T00:02:00.000Z');
		expect(
			await store.get({ identity: target.identity, authority: authority() })
		).toEqual({
			kind: 'not_found'
		});
		expect(driver.rows).toHaveLength(0);
	});

	test('fails closed on invalid, corrupt, leaking, or unavailable storage', async () => {
		const time = clock();
		const driver = new MemoryDriver();
		const store = createPendingGatewayActionStore(storeOptions(driver, time));
		const target = record();
		expect(await store.create({
			record: { ...target, revision: 4 },
			authority: authority()
		})).toEqual({
			kind: 'unavailable',
			reason: 'invalid_record'
		});

		const corrupt = rowOf(target);
		driver.rows.set(corrupt.storageKey, { ...corrupt, value: { schemaVersion: 999 } });
		expect(await store.list({ sourceKey, scopeKey, authority: authority() })).toEqual({
			kind: 'unavailable',
			reason: 'corrupt_record'
		});

		class LeakingDriver extends MemoryDriver {
			override async list() {
				return [...this.rows.values()].map((row) => structuredClone(row));
			}
		}
		const leaking = new LeakingDriver();
		const other = record({ action: 'gac_fedcba9876543210' });
		const otherPartition = {
			...partition,
			scopeKey: parseGatewayScopeKey('gsc_fedcba9876543210')
		};
		const otherIdentity = { ...other.identity, scopeKey: otherPartition.scopeKey };
		const outside = parsePendingGatewayActionRecord({ ...other, identity: otherIdentity });
		leaking.rows.set(rowOf(outside).storageKey, rowOf(outside));
		const leakingStore = createPendingGatewayActionStore(storeOptions(leaking, time));
		expect(
			await leakingStore.list({ sourceKey, scopeKey, authority: authority() })
		).toEqual({
			kind: 'unavailable',
			reason: 'partition_mismatch'
		});

		driver.rows.clear();
		driver.unavailable = true;
		expect(await store.create({ record: target, authority: authority() })).toEqual({
			kind: 'unavailable',
			reason: 'storage_unavailable'
		});
	});

	test('the production IndexedDB driver fails closed on absence or a version/open failure', async () => {
		const time = clock();
		const absentStore = createPendingGatewayActionStore({
			driver: createIndexedDbPendingGatewayActionDriver({ indexedDB: undefined }),
			clock: time.now,
			resolutionProofVerifier: rejectingResolutionProofVerifier
		});
		expect(await absentStore.create({ record: record(), authority: authority() })).toEqual({
			kind: 'unavailable',
			reason: 'storage_unavailable'
		});

		const versionFailure = {
			open() {
				const error = new Error('IndexedDB schema version cannot be opened.');
				error.name = 'VersionError';
				throw error;
			}
		} as unknown as IDBFactory;
		const failedUpgradeStore = createPendingGatewayActionStore({
			driver: createIndexedDbPendingGatewayActionDriver({ indexedDB: versionFailure }),
			clock: time.now,
			resolutionProofVerifier: rejectingResolutionProofVerifier
		});
		expect(await failedUpgradeStore.create({ record: record(), authority: authority() })).toEqual({
			kind: 'unavailable',
			reason: 'storage_unavailable'
		});
	});
});
