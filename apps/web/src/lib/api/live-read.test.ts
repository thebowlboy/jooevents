import { describe, expect, test } from 'bun:test';
import { LiveRead, type LiveReadState } from './live-read';

class TypedFailure extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.retryable = retryable;
	}
}

/** A port that never answers — the exact shape that produced eternal skeletons. */
function neverResolves(): { read: () => Promise<never>; calls: () => number } {
	let calls = 0;
	return {
		read: () => {
			calls += 1;
			return new Promise<never>(() => {});
		},
		calls: () => calls
	};
}

/** A promise whose settlement this test controls, to order two live requests. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('LiveRead states', () => {
	test('starts resolving and never claims to be resolved before an answer', () => {
		const port = neverResolves();
		const read = new LiveRead({ read: port.read });
		void read.read();
		expect(read.state.kind).toBe('resolving');
	});

	test('a rejecting port becomes unavailable, not a permanent wait', async () => {
		const read = new LiveRead<string>({
			read: async () => {
				throw new TypedFailure('Review coverage is not available here yet.', false);
			}
		});
		await read.read();
		expect(read.state).toEqual({
			kind: 'unavailable',
			message: 'Review coverage is not available here yet.',
			retryable: false
		});
	});

	test('an unclassified rejection stays retryable behind reviewed fallback copy', async () => {
		const read = new LiveRead<string>({
			read: async () => {
				throw new Error('');
			},
			fallback: 'The reviewer roster could not be loaded.'
		});
		await read.read();
		expect(read.state).toEqual({
			kind: 'unavailable',
			message: 'The reviewer roster could not be loaded.',
			retryable: true
		});
	});

	test('a retry after failure can resolve, replacing the failure entirely', async () => {
		let attempt = 0;
		const read = new LiveRead<string>({
			read: async () => {
				attempt += 1;
				if (attempt === 1) throw new TypedFailure('Could not be reached.', true);
				return 'roster';
			}
		});
		await read.read();
		expect(read.state.kind).toBe('unavailable');
		await read.refresh();
		expect(read.state).toEqual({ kind: 'resolved', value: 'roster' });
	});

	test('a refresh failing over data already on screen keeps the data', async () => {
		let attempt = 0;
		const read = new LiveRead<string>({
			read: async () => {
				attempt += 1;
				if (attempt === 1) return 'roster';
				throw new TypedFailure('The refresh could not be completed.', true);
			}
		});
		await read.read();
		await read.refresh();
		expect(read.state).toEqual({
			kind: 'resolved',
			value: 'roster',
			refreshFailure: 'The refresh could not be completed.'
		});
	});
});

describe('LiveRead ordering', () => {
	test('a second read while one is open does not open another request', async () => {
		const port = neverResolves();
		const read = new LiveRead({ read: port.read });
		void read.read();
		void read.read();
		void read.read();
		expect(port.calls()).toBe(1);
	});

	test('newest wins: a slow earlier answer never overwrites the later one', async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const answers = [first.promise, second.promise];
		let call = 0;
		const read = new LiveRead<string>({ read: () => answers[call++]! });

		const a = read.refresh();
		const b = read.refresh();
		second.resolve('newest');
		await b;
		expect(read.state).toEqual({ kind: 'resolved', value: 'newest' });

		first.resolve('stale');
		await a;
		expect(read.state).toEqual({ kind: 'resolved', value: 'newest' });
	});

	test('a superseded rejection cannot blank the surface the newest read filled', async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const answers = [first.promise, second.promise];
		let call = 0;
		const read = new LiveRead<string>({ read: () => answers[call++]! });

		const a = read.refresh();
		const b = read.refresh();
		second.resolve('newest');
		await b;

		first.reject(new TypedFailure('Stale failure.', true));
		await a;
		expect(read.state).toEqual({ kind: 'resolved', value: 'newest' });
	});

	test('every state change is announced so a surface can mirror it', async () => {
		const seen: LiveReadState<string>[] = [];
		const read = new LiveRead<string>({
			read: async () => 'roster',
			onChange: (state) => seen.push(state)
		});
		await read.read();
		expect(seen).toEqual([{ kind: 'resolved', value: 'roster' }]);
	});

	test('pending reports the open request and clears once it answers', async () => {
		const gate = deferred<string>();
		const read = new LiveRead<string>({ read: () => gate.promise });
		const run = read.read();
		expect(read.pending).toBe(true);
		gate.resolve('roster');
		await run;
		expect(read.pending).toBe(false);
	});
});
