import type { FilesPageRefusalReason } from '$lib/api/files/files-page-port';
import type { FileScanHonesty } from '$lib/api/files/view-models';

/**
 * The organizer Files surface's reviewed vocabulary. Codes travel on the
 * wire; sentences are chosen here — never raw identifiers, never provider or
 * transport text. One fallback covers unknown codes.
 */

const refusalSentences: Partial<Record<FilesPageRefusalReason, string>> = {
	content_type_refused:
		'This file type can’t be stored here. PDF, PNG, JPEG, WebP, PowerPoint, Keynote, and ZIP files are accepted.',
	video_refused_use_link:
		'Videos are better shared as a link — add a Drive or Dropbox link instead of uploading.',
	file_too_large: 'This file is larger than this event accepts.',
	event_quota_exceeded: 'This event’s upload space is full.',
	display_filename_invalid: 'That file name can’t be used. Rename the file and try again.',
	upload_interrupted: 'The upload didn’t finish. Check your connection and try again.',
	hash_mismatch: 'The file changed while it was uploading. Try again.',
	intent_expired: 'The upload took too long and expired. Try again.',
	asset_blocked: 'This file was blocked by the virus scan and can’t be shared.',
	asset_not_available: 'This file isn’t ready to share yet. Try again in a moment.',
	stale_attachment: 'This changed on another screen. Reload to see where it stands.',
	already_detached: 'This was already removed.',
	attachment_missing: 'This item no longer exists. Reload to see where things stand.',
	stale_share: 'This resource changed on another screen. Reload and try again.',
	already_revoked: 'This resource was already unshared.',
	share_missing: 'This resource no longer exists. Reload to see where things stand.',
	track_missing: 'That track no longer exists. Pick another audience.',
	engagement_missing: 'That speaker engagement no longer exists.',
	engagement_cancelled: 'That engagement was cancelled, so nothing can be asked of it.',
	deadline_unavailable: 'That deadline is no longer in the event’s calendar. Pick another one.',
	request_missing: 'This request no longer exists. Reload to see where things stand.',
	request_not_open: 'This request was already settled.',
	stale_request: 'This request changed on another screen. Reload and try again.',
	not_served: 'File tools aren’t available on this installation yet.',
	not_authorized: 'Your access has changed. Reload to see where things stand.',
	event_required: 'Create an event before sharing files.',
	request_unconfirmed: 'We couldn’t confirm what happened. Reload to see where things stand.'
};

export function filesRefusalSentence(reason: FilesPageRefusalReason): string {
	return refusalSentences[reason] ?? 'That didn’t work. Reload and try again.';
}

/** L5 honesty: what scanning actually happened, with no fake safety badge. */
export const scanHonestyLabel: Record<FileScanHonesty, string> = {
	not_scanned: 'not virus-scanned',
	scan_pending: 'virus scan pending',
	scanned: 'virus-scanned',
	blocked: 'blocked by virus scan'
};

export const linkProviderLabel = {
	drive: 'Google Drive',
	dropbox: 'Dropbox',
	url: 'Link'
} as const;
