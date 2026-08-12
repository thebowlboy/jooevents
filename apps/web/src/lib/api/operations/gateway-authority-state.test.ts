import { describe, expect, test } from 'bun:test';
import { parseGatewayAuthorityProjection } from '@jooevents/contracts';
import {
	applyGatewayAuthorityTransition,
	classifyGatewayAuthorityTransition,
	gatewayAuthorityFromAccessContext
} from './gateway-authority-state';

const partitionA = 'gpp_aaaaaaaaaaaaaaaa';
const partitionB = 'gpp_bbbbbbbbbbbbbbbb';
const partitionC = 'gpp_cccccccccccccccc';
const epoch1 = 'gde_1111111111111111';
const epoch2 = 'gde_2222222222222222';

function projection(current = partitionA, aliases: readonly string[] = [], epoch = epoch1) {
	return parseGatewayAuthorityProjection({
		schemaVersion: 1,
		principalPartition: { current, aliases },
		disclosureEpoch: epoch
	});
}

describe('gateway authority browser state', () => {
	test('treats absent, anonymous, or malformed projection as explicitly unavailable', () => {
		expect(gatewayAuthorityFromAccessContext({ state: 'anonymous' })).toEqual({
			kind: 'unavailable',
			reason: 'not_active'
		});
		expect(gatewayAuthorityFromAccessContext({
			state: 'active',
			user: { id: 'user_ada', displayName: 'Ada' },
			workspace: { id: 'workspace_summit', name: 'Summit Operations' }
		})).toEqual({ kind: 'unavailable', reason: 'projection_absent' });
		expect(gatewayAuthorityFromAccessContext({
			state: 'active',
			user: { id: 'user_ada', displayName: 'Ada' },
			workspace: { id: 'workspace_summit', name: 'Summit Operations' },
			gatewayAuthority: { principalPartition: 'user_ada' }
		})).toEqual({ kind: 'unavailable', reason: 'projection_invalid' });
	});

	test('preserves pending identity but clears presentations on permission downgrade', () => {
		expect(classifyGatewayAuthorityTransition(
			projection(partitionA, [], epoch1),
			projection(partitionA, [], epoch2)
		)).toEqual({
			kind: 'disclosure_changed',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'preserved_requires_server_resolution'
		});
	});

	test('recognizes rotation only through current/alias overlap', () => {
		expect(classifyGatewayAuthorityTransition(
			projection(partitionA),
			projection(partitionB, [partitionA])
		)).toEqual({
			kind: 'profile_rotated',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'preserved'
		});
		expect(classifyGatewayAuthorityTransition(
			projection(partitionA, [partitionC]),
			projection(partitionB)
		)).toEqual({
			kind: 'principal_replaced',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'isolated'
		});
	});

	test('isolates both stores on account or membership partition replacement', () => {
		expect(classifyGatewayAuthorityTransition(projection(partitionA), projection(partitionB)))
			.toEqual({
				kind: 'principal_replaced',
				clearProtectedPresentations: true,
				pendingActionIdentity: 'isolated'
			});
		expect(classifyGatewayAuthorityTransition(projection(), undefined)).toEqual({
			kind: 'unavailable',
			clearProtectedPresentations: true,
			pendingActionIdentity: 'unavailable'
		});
	});

	test('runs the protected-presentation clear before accepting a changed epoch or sign-out', async () => {
		let clears = 0;
		const downgrade = await applyGatewayAuthorityTransition({
			previous: projection(partitionA, [], epoch1),
			current: projection(partitionA, [], epoch2),
			clearProtectedPresentations: () => { clears += 1; }
		});
		expect(downgrade.pendingActionIdentity)
			.toBe('preserved_requires_server_resolution');
		expect(clears).toBe(1);

		await applyGatewayAuthorityTransition({
			previous: projection(partitionA, [], epoch2),
			current: undefined,
			clearProtectedPresentations: () => { clears += 1; }
		});
		expect(clears).toBe(2);

		await applyGatewayAuthorityTransition({
			previous: projection(partitionA, [], epoch2),
			current: projection(partitionA, [], epoch2),
			clearProtectedPresentations: () => { clears += 1; }
		});
		expect(clears).toBe(2);
	});
});
