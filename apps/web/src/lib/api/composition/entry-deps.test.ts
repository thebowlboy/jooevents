import { describe, expect, test } from 'bun:test';
import { entryDependencies } from './entry-deps';

describe('sample entry dependencies', () => {
	test('a link request answers identically whoever asks', async () => {
		const known = await entryDependencies.participant.requestLink({ email: 'amara@contractual.io' });
		const unknown = await entryDependencies.participant.requestLink({ email: 'nobody@example.invalid' });
		expect(known).toEqual(unknown);
		expect(known.kind === 'success' && known.data.outcome).toBe('link_requested');

		const operator = await entryDependencies.operator.requestSignInLink({ email: 'nobody@example.invalid' });
		expect(operator.kind === 'success' && operator.data.outcome).toBe('link_requested');
	});

	test('the participant context is a resolved server state, never a browser guess', async () => {
		const result = await entryDependencies.participant.getContext();
		expect(result.kind).toBe('success');
		if (result.kind !== 'success') return;
		expect(result.data.state).toBe('active');
		expect(result.data.state === 'active' && result.data.participant.displayName).toBe(
			'Amara Okafor'
		);
	});

	test('following a link resolves to a named outcome', async () => {
		const result = await entryDependencies.participant.completeLink({ token: 'sample' });
		expect(result.kind === 'success' && result.data.outcome).toBe('signed_in');
	});

	test('the operator lane starts anonymous rather than assuming a session', async () => {
		const result = await entryDependencies.operator.getContext();
		expect(result.kind === 'success' && result.data.state).toBe('anonymous');
	});
});
