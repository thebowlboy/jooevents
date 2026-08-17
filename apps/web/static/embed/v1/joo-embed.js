// joo-embed v1 — the one script an organizer's site loads to host an inline
// JooEvents embed.
//
// The element renders an internal iframe inside a shadow root and grows it to
// the embedded document's own reported height, so the block takes its natural
// size without a nested scrollbar. Messaging follows the versioned embed
// protocol exactly: the only accepted frame messages are ready, a bounded
// height, a hosted-page navigation intent, and a completion notice; the only
// message sent down is constrained display context. Both directions use exact
// origins — never '*' — and any payload outside the closed vocabulary is
// ignored. No session, token, form value, speaker record, or style payload
// ever crosses the boundary.
(function () {
	'use strict';
	var TAG = 'joo-embed';
	var SUBMISSION_EVENT = 'joo-embed:submitted';
	var PROTOCOL_VERSION = 1;
	var HEIGHT_MAX_PX = 20000;
	var HOSTED_PATH = /^\/s\/(schedule|speakers|apply)(\?scope=[a-z]+:[A-Za-z0-9._-]{1,64})?$/;
	if (window.customElements === undefined || window.customElements.get(TAG) !== undefined) {
		return;
	}

	function embedOriginOf(src) {
		var url;
		try {
			url = new URL(src, window.location.href);
		} catch (error) {
			return null;
		}
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		if (url.pathname.indexOf('/embed/') !== 0) return null;
		return url;
	}

	function instanceId() {
		var raw =
			window.crypto && window.crypto.randomUUID
				? window.crypto.randomUUID()
				: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
		return raw.toLowerCase().slice(0, 64);
	}

	function validChildMessage(data, embedId) {
		if (data === null || typeof data !== 'object') return null;
		if (data.protocolVersion !== PROTOCOL_VERSION) return null;
		if (data.embedId !== embedId) return null;
		if (data.kind === 'ready' || data.kind === 'submission_complete') return data;
		if (
			data.kind === 'height_changed' &&
			typeof data.heightPx === 'number' &&
			Number.isInteger(data.heightPx) &&
			data.heightPx >= 0 &&
			data.heightPx <= HEIGHT_MAX_PX
		) {
			return data;
		}
		if (data.kind === 'navigate' && typeof data.path === 'string' && HOSTED_PATH.test(data.path)) {
			return data;
		}
		return null;
	}

	var JooEmbed = function () {
		return Reflect.construct(HTMLElement, [], JooEmbed);
	};
	JooEmbed.prototype = Object.create(HTMLElement.prototype);
	JooEmbed.prototype.constructor = JooEmbed;

	JooEmbed.prototype.connectedCallback = function () {
		if (this.__jooConnected) return;
		this.__jooConnected = true;
		var source = this.getAttribute('src') || '';
		var url = embedOriginOf(source);
		if (url === null) return; // an address that is not an embed document renders nothing
		var embedOrigin = url.origin;
		var embedId = instanceId();
		url.searchParams.set('embed', embedId);
		url.searchParams.set('host', window.location.origin);

		var root = this.shadowRoot || this.attachShadow({ mode: 'open' });
		var wrapper = document.createElement('div');
		wrapper.style.width = '100%';
		var maxWidth = parseInt(this.getAttribute('max-width') || '', 10);
		if (Number.isInteger(maxWidth) && maxWidth > 0) {
			wrapper.style.maxWidth = maxWidth + 'px';
			if (this.getAttribute('align') === 'center') wrapper.style.margin = '0 auto';
		}
		var frame = document.createElement('iframe');
		frame.src = url.toString();
		frame.title = this.getAttribute('title') || 'Event embed';
		frame.style.width = '100%';
		frame.style.border = '0';
		frame.style.display = 'block';
		frame.style.minHeight = '160px';
		frame.setAttribute('loading', 'lazy');
		wrapper.appendChild(frame);
		root.appendChild(wrapper);

		var element = this;
		this.__jooOnMessage = function (event) {
			// Exact-origin, exact-window acceptance: anything else is ignored.
			if (event.origin !== embedOrigin) return;
			if (event.source !== frame.contentWindow) return;
			var message = validChildMessage(event.data, embedId);
			if (message === null) return;
			if (message.kind === 'ready') {
				var scheme = null;
				try {
					scheme = window.matchMedia('(prefers-color-scheme: dark)').matches
						? 'dark'
						: 'light';
				} catch (error) {
					scheme = null;
				}
				var locale = null;
				if (
					typeof navigator.language === 'string' &&
					/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/.test(navigator.language)
				) {
					locale = navigator.language;
				}
				if (frame.contentWindow) {
					frame.contentWindow.postMessage(
						{
							kind: 'host_context',
							protocolVersion: PROTOCOL_VERSION,
							embedId: embedId,
							colorScheme: scheme,
							locale: locale
						},
						embedOrigin
					);
				}
				return;
			}
			if (message.kind === 'height_changed') {
				frame.style.height = message.heightPx + 'px';
				frame.style.minHeight = '0';
				return;
			}
			if (message.kind === 'submission_complete') {
				// Stable host API: the protocol envelope stays private to the loader.
				// No submission, identity, answer, or ceremony detail crosses here.
				element.dispatchEvent(
					new CustomEvent(SUBMISSION_EVENT, { bubbles: true, composed: true })
				);
				return;
			}
			if (message.kind === 'navigate') {
				// A navigation intent points at the hosted page; opening it is the
				// host page user's own gesture completed in a new tab.
				window.open(embedOrigin + message.path, '_blank', 'noopener');
			}
		};
		window.addEventListener('message', this.__jooOnMessage);
	};

	JooEmbed.prototype.disconnectedCallback = function () {
		if (this.__jooOnMessage) {
			window.removeEventListener('message', this.__jooOnMessage);
			this.__jooOnMessage = null;
		}
	};

	window.customElements.define(TAG, JooEmbed);
})();
