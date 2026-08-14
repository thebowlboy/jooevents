import { describe, expect, test } from 'bun:test';
import { EMBED_MESSAGE_PROTOCOL_VERSION } from '@jooevents/contracts';
import { createEmbedChildChannel } from './embed-document';

interface Sent {
	readonly data: unknown;
	readonly targetOrigin: string;
}

function frameStub(): {
	frame: Parameters<typeof createEmbedChildChannel>[0]['frame'];
	sent: Sent[];
	dispatch(data: unknown, origin: string): void;
} {
	const sent: Sent[] = [];
	const listeners = new Set<(event: MessageEvent) => void>();
	const parent = {
		postMessage(data: unknown, targetOrigin: string) {
			sent.push({ data, targetOrigin });
		}
	};
	const frame = {
		parent: parent as unknown as Window,
		addEventListener(_type: string, listener: EventListener) {
			listeners.add(listener as (event: MessageEvent) => void);
		},
		removeEventListener(_type: string, listener: EventListener) {
			listeners.delete(listener as (event: MessageEvent) => void);
		}
	} as unknown as Parameters<typeof createEmbedChildChannel>[0]['frame'];
	return {
		frame,
		sent,
		dispatch(data: unknown, origin: string) {
			for (const listener of listeners) {
				listener({ data, origin } as MessageEvent);
			}
		}
	};
}

const embedId = 'embed-instance-1';
const hostOrigin = 'https://partner.example.com';

describe('embed child channel', () => {
	test('a loader-identified frame speaks the exact-origin protocol', () => {
		const stub = frameStub();
		const channel = createEmbedChildChannel({ embedId, hostOrigin, frame: stub.frame });
		expect(channel.active).toBe(true);
		channel.announceReady();
		channel.reportHeight(1234.6);
		expect(stub.sent).toEqual([
			{
				data: { kind: 'ready', protocolVersion: EMBED_MESSAGE_PROTOCOL_VERSION, embedId },
				targetOrigin: hostOrigin
			},
			{
				data: {
					kind: 'height_changed',
					protocolVersion: EMBED_MESSAGE_PROTOCOL_VERSION,
					embedId,
					heightPx: 1235
				},
				targetOrigin: hostOrigin
			}
		]);
		// Never '*': every outbound message targets the named host origin.
		expect(stub.sent.every((entry) => entry.targetOrigin === hostOrigin)).toBe(true);
	});

	test('heights are clamped into the protocol bound before sending', () => {
		const stub = frameStub();
		const channel = createEmbedChildChannel({ embedId, hostOrigin, frame: stub.frame });
		channel.reportHeight(999_999);
		channel.reportHeight(-50);
		expect(
			stub.sent.map((entry) => (entry.data as { heightPx: number }).heightPx)
		).toEqual([20_000, 0]);
	});

	test('a document without loader identity stays inert', () => {
		const stub = frameStub();
		for (const inert of [
			createEmbedChildChannel({ embedId: null, hostOrigin, frame: stub.frame }),
			createEmbedChildChannel({ embedId, hostOrigin: null, frame: stub.frame }),
			createEmbedChildChannel({ embedId, hostOrigin: "https://evil.example;x", frame: stub.frame }),
			createEmbedChildChannel({ embedId, hostOrigin: '*', frame: stub.frame }),
			createEmbedChildChannel({ embedId: 'Bad_Id!', hostOrigin, frame: stub.frame })
		]) {
			expect(inert.active).toBe(false);
			inert.announceReady();
			inert.reportHeight(500);
		}
		expect(stub.sent).toEqual([]);
	});

	test('host messages are accepted only from the exact host origin and vocabulary', () => {
		const stub = frameStub();
		const channel = createEmbedChildChannel({ embedId, hostOrigin, frame: stub.frame });
		const received: unknown[] = [];
		channel.listen((message) => received.push(message));
		const context = {
			kind: 'host_context',
			protocolVersion: EMBED_MESSAGE_PROTOCOL_VERSION,
			embedId,
			colorScheme: 'dark',
			locale: 'en-US'
		};
		stub.dispatch(context, 'https://other.example.com'); // wrong origin
		stub.dispatch({ ...context, kind: 'steal_token' }, hostOrigin); // outside vocabulary
		stub.dispatch({ ...context, embedId: 'other-embed' }, hostOrigin); // another instance
		stub.dispatch(context, hostOrigin);
		expect(received).toEqual([context]);
	});
});
