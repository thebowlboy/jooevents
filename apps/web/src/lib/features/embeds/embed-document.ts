import {
	EMBED_HEIGHT_MAX_PX,
	EMBED_MESSAGE_PROTOCOL_VERSION,
	acceptEmbedHostMessage,
	embedChildMessageSchema,
	embedInstanceIdSchema,
	normalizeEmbedFrameOrigin,
	type EmbedHostMessage
} from '@jooevents/contracts';

/**
 * The frame side of the versioned embed message protocol, as the `/embed/*`
 * documents speak it.
 *
 * A channel exists only when the loader identified this frame: a valid embed
 * instance id and a host origin that is exactly one normalized origin. A
 * document opened directly (or framed without the loader) gets the inert
 * channel — it renders fine and says nothing. Outbound messages are parsed
 * against the child schema before they leave and always target the exact host
 * origin, never `'*'`; inbound messages are accepted only from that origin and
 * only in the constrained host vocabulary.
 */
export interface EmbedChildChannel {
	readonly active: boolean;
	announceReady(): void;
	reportHeight(heightPx: number): void;
	/** Wires the host-message listener; returns the disposer. */
	listen(handler: (message: EmbedHostMessage) => void): () => void;
}

const inertChannel: EmbedChildChannel = Object.freeze({
	active: false,
	announceReady() {},
	reportHeight() {},
	listen() {
		return () => {};
	}
});

export function createEmbedChildChannel(input: {
	readonly embedId: string | null;
	readonly hostOrigin: string | null;
	readonly frame: Pick<Window, 'parent' | 'addEventListener' | 'removeEventListener'>;
}): EmbedChildChannel {
	const embedId = embedInstanceIdSchema.safeParse(input.embedId ?? '');
	if (!embedId.success) return inertChannel;
	const host = normalizeEmbedFrameOrigin(input.hostOrigin ?? '');
	if (host.kind !== 'normalized' || host.origin !== input.hostOrigin) return inertChannel;
	const hostOrigin = host.origin;
	const frame = input.frame;
	if (frame.parent === (frame as unknown)) return inertChannel;

	function send(candidate: unknown): void {
		const message = embedChildMessageSchema.safeParse(candidate);
		if (!message.success) return;
		(frame.parent as Window).postMessage(message.data, hostOrigin);
	}

	return Object.freeze({
		active: true,
		announceReady() {
			send({
				kind: 'ready',
				protocolVersion: EMBED_MESSAGE_PROTOCOL_VERSION,
				embedId: embedId.data
			});
		},
		reportHeight(heightPx: number) {
			send({
				kind: 'height_changed',
				protocolVersion: EMBED_MESSAGE_PROTOCOL_VERSION,
				embedId: embedId.data,
				heightPx: Math.min(EMBED_HEIGHT_MAX_PX, Math.max(0, Math.round(heightPx)))
			});
		},
		listen(handler: (message: EmbedHostMessage) => void) {
			const onMessage = (event: MessageEvent) => {
				const accepted = acceptEmbedHostMessage({
					data: event.data,
					senderOrigin: event.origin,
					hostOrigin
				});
				if (accepted.kind !== 'accepted') return;
				if (accepted.message.embedId !== embedId.data) return;
				handler(accepted.message);
			};
			frame.addEventListener('message', onMessage as EventListener);
			return () => frame.removeEventListener('message', onMessage as EventListener);
		}
	});
}
