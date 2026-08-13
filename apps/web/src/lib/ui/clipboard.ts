/**
 * Putting text on the clipboard — one implementation, because the fallback is
 * the subtle part and a second copy of it would rot.
 *
 * `navigator.clipboard` exists only in a secure context, and the shared
 * development origin is plain HTTP on the tailnet — so on the URL the team
 * actually uses it is `undefined`. A control that assumes the async API
 * silently fails there. The legacy selection path is therefore a fallback
 * rather than the default: it briefly takes the selection, which must then be
 * restored, because not disturbing a hand-made selection is the whole promise
 * a copy shortcut makes.
 *
 * Returns whether the text actually reached the clipboard, so a caller can say
 * so rather than showing a success the clipboard never received.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* Permission refused; try the selection path before giving up. */
		}
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.cssText = 'position:fixed;top:0;opacity:0;pointer-events:none';
	document.body.append(area);
	const selection = document.getSelection();
	const held = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	try {
		area.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		area.remove();
		if (held && selection) {
			selection.removeAllRanges();
			selection.addRange(held);
		}
	}
}
