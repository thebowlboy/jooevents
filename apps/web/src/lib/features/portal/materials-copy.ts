import type { PortalFilesRefusalReason } from '$lib/api/files/portal-files-port';
import type { FileScanHonesty } from '$lib/api/files/view-models';

/**
 * The Materials section's reviewed sentences, in the portal's own voice —
 * spoken to someone who never asked to learn a product. Codes travel;
 * sentences are chosen here, with one safe fallback for unknown codes.
 */

const refusalSentences: Partial<Record<PortalFilesRefusalReason, string>> = {
	content_type_refused:
		'This kind of file can’t be uploaded here. PDF, PNG, JPEG, WebP, PowerPoint, Keynote, and ZIP files work.',
	video_refused_use_link:
		'Videos are too large to upload here. Add a link to it instead — Drive or Dropbox works well.',
	file_too_large:
		'This file is larger than this event accepts. Try a smaller export, or add a link to it instead.',
	byte_cap_exceeded:
		'This file is larger than this event accepts. Try a smaller export, or add a link to it instead.',
	event_quota_exceeded:
		'You’ve used up your upload space for this event. Add a link instead, or ask the organizers for room.',
	display_filename_invalid: 'That file name can’t be used. Rename the file and try again.',
	upload_interrupted: 'The upload didn’t finish. Check your connection and try again.',
	hash_mismatch: 'The file changed while it was uploading. Try again.',
	intent_expired: 'The upload took too long. Try again.',
	empty_stream: 'That file is empty. Pick the file you meant to send.',
	image_decode_failed: 'This image can’t be read. Re-export it and try again.',
	request_not_open: 'The organizers already settled this ask — your file was still saved.',
	not_yours: 'This isn’t yours to change any more. Reload to see where things stand.',
	not_served: 'Uploads aren’t available here yet.',
	request_unconfirmed: 'We couldn’t confirm what happened. Reload to see where things stand.'
};

export function materialsRefusalSentence(reason: PortalFilesRefusalReason): string {
	return refusalSentences[reason] ?? 'That didn’t work just now. Try again in a moment.';
}

/** Scan-state honesty, portal voice. No fake safety badges (L5). */
export const materialsScanLabel: Record<FileScanHonesty, string> = {
	not_scanned: 'not virus-scanned',
	scan_pending: 'virus scan pending',
	scanned: 'virus-scanned',
	blocked: 'blocked by the virus scan'
};

export const materialsCopy = {
	heading: 'Materials',
	requestsIntro: 'The organizers asked for:',
	uploadButton: 'Upload a file',
	uploadBusy: 'Uploading…',
	linkToggle: 'Add a link instead',
	linkSubmit: 'Add link',
	linkBusy: 'Adding…',
	/**
	 * D6 owner annotation: people must be reminded to share the Drive/Dropbox
	 * file with the organizers. The receiving address is a settings concern the
	 * served contract does not expose yet, so the reminder stays neutral until
	 * it does.
	 */
	linkShareReminder:
		'Make sure the organizers can open it — share the file with them, or turn on link access.',
	yoursHeading: 'Your files',
	fromOrganizersHeading: 'From the organizers',
	emptyYours: 'Nothing uploaded yet.',
	uploaded: (name: string) => `Uploaded “${name}”.`,
	uploadedButRequestOpen: (name: string) =>
		`Uploaded “${name}”. The ask below could not be marked done — reload to see where it stands.`,
	linked: (label: string) => `Added “${label}”.`,
	download: 'Download',
	failedTitle: 'Your materials could not be loaded.',
	retry: 'Try again',
	/** An ask that names a deadline the portal cannot date yet stays honest. */
	deadlineUnresolved: 'the organizers set a deadline for this'
} as const;
