import { describe, expect, test } from 'bun:test';
import type { AccessContext } from '@jooevents/contracts';
import type { ApiResult } from '../client';
import { resolveOperatorAccess } from './operator-entry';

const active: AccessContext = {
	state: 'active',
	user: { id: 'user_ada', displayName: 'Ada' },
	workspace: { id: 'workspace_summit', name: 'Summit' }
};
if (active.state !== 'active') throw new TypeError('active fixture required');

function success(data: AccessContext): ApiResult<AccessContext> {
	return { kind: 'success', data };
}

describe('operator access resolution', () => {
	test('retains only an operator return path and accepts active server context', () => {
		expect(resolveOperatorAccess({
			result: success(active),
			pathname: '/app/schedule',
			search: '?panel=conflicts'
		})).toEqual({
			kind: 'active',
			user: active.user,
			workspace: active.workspace
		});
	});

	test('routes every non-active server state through the canonical entry surface', () => {
		const cases: readonly [AccessContext, string][] = [
			[{ state: 'anonymous' }, '/sign-in'],
			[{ state: 'provisioning', retryAfterSeconds: 2, correlationId: 'correlation-1' }, '/auth/complete'],
			[{
				state: 'pending_review',
				user: { id: 'user_ada', displayName: 'Ada' },
				membership: { id: 'membership_ada', workspaceId: 'workspace_summit', status: 'pending_review', version: 1 },
				workspace: { id: 'workspace_summit', name: 'Summit' }
			}, '/access/pending'],
			[{ state: 'blocked', code: 'suspended' }, '/access/blocked']
		];
		for (const [context, destination] of cases) {
			expect(resolveOperatorAccess({
				result: success(context),
				pathname: '/app/submissions',
				search: '?scope=new'
			})).toEqual({
				kind: 'redirect',
				path: `${destination}?returnTo=${encodeURIComponent('/app/submissions?scope=new')}`
			});
		}
	});

	test('does not preserve a non-operator path and keeps transport failure closed', () => {
		expect(resolveOperatorAccess({
			result: success({ state: 'anonymous' }),
			pathname: 'https://attacker.invalid/',
			search: '?next=/app'
		})).toEqual({ kind: 'redirect', path: '/sign-in?returnTo=%2Fapp' });
		expect(resolveOperatorAccess({
			result: { kind: 'error', error: { code: 'network_unavailable', retryable: true } },
			pathname: '/app',
			search: ''
		})).toEqual({
			kind: 'transport_error',
			error: { code: 'network_unavailable', retryable: true }
		});
	});
});
