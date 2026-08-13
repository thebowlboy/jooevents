import { describe, expect, test } from 'bun:test';
import { describePortFailure } from './port-failure';

class TypedFailure extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.retryable = retryable;
	}
}

describe('describePortFailure', () => {
	test('carries the typed error copy and its declared retryability', () => {
		expect(describePortFailure(new TypedFailure('You no longer have permission.', false)))
			.toEqual({ message: 'You no longer have permission.', retryable: false });
		expect(describePortFailure(new TypedFailure('Could not be reached. Try again.', true)))
			.toEqual({ message: 'Could not be reached. Try again.', retryable: true });
	});

	test('an undeclared failure keeps the fallback copy and stays retryable', () => {
		expect(describePortFailure(new Error(''))).toEqual({
			message: 'This request could not be completed.',
			retryable: true
		});
		expect(describePortFailure('boom', 'The list could not be loaded.')).toEqual({
			message: 'The list could not be loaded.',
			retryable: true
		});
	});
});
