/**
 * What speakers actually sent, keyed to the assignment they sent it against.
 *
 * The one fact the sample workspace never held. Every organizer surface could
 * say a task was `received`; none could show the material, which is how a
 * travel-details form ended up offering "Accept as complete" with nothing to
 * read. This module is that missing half, authored for the `flight` scenario so
 * each deliverable state has somewhere real to render.
 *
 * It is a separate module rather than rows inside the dataset because the
 * content is keyed by *assignment* — a pair — while a dataset states records.
 * Keeping it here also means the assignment states in `flight.ts` and the
 * material behind them can be read, and disagreed with, in one place.
 *
 * A deliberate hole is part of the fixture: `task-slides:spk-7` is `received`
 * with nothing authored, so the record renders the no-accept-above-unviewable
 * refusal somewhere real instead of only in a test.
 */

import type { TaskSubmission } from '../speaker-record-port';

/** `${taskId}:${speakerId}` — the pair an assignment is identified by. */
type AssignmentKey = string;

export function assignmentKey(taskId: string, speakerId: string): AssignmentKey {
	return `${taskId}:${speakerId}`;
}

/**
 * Authored material, by assignment.
 *
 * Content kind always agrees with its task definition's `kind`: a form task
 * carries answers, an upload carries files. A record that disagreed would let
 * the page render an upload as answers, and the state matrix would stop meaning
 * anything.
 */
const content: Readonly<Record<AssignmentKey, TaskSubmission>> = Object.freeze({
	/*
	 * The owner's example, whole: the received form whose answers no organizer
	 * surface could show. Lukas sent these three days ago and the row has been
	 * offering "Accept as complete" ever since.
	 */
	'task-travel:spk-5': {
		kind: 'form',
		submittedAt: 'Aug 15, 09:12 EDT',
		answers: [
			{ fieldId: 'arrival', label: 'Arriving', value: 'Mon Oct 12, 18:40 — LH 462 into JFK' },
			{ fieldId: 'departure', label: 'Leaving', value: 'Thu Oct 15, late afternoon; anything after 16:00 works' },
			{ fieldId: 'hotel', label: 'Accommodation', value: 'Booked myself — The Wallace, 3 nights. No reimbursement needed.' },
			{ fieldId: 'access', label: 'Access or mobility needs', value: '' },
			{
				fieldId: 'dietary',
				label: 'Dietary requirements',
				value: 'Vegetarian. Severe walnut allergy — please flag it to catering; I carry an EpiPen.'
			},
			{
				fieldId: 'notes',
				label: 'Anything else we should know',
				value:
					'I am co-presenting with Sofia and we would like 20 minutes in the room beforehand to test the handoff.\nHappy to do press or a podcast on the Tuesday if that is useful.'
			}
		]
	},

	/* A received upload: the keynote headshot, in and waiting to be looked at. */
	'task-headshot:spk-6': {
		kind: 'upload',
		submittedAt: 'Aug 16, 21:05 EDT',
		files: [
			{
				id: 'file-ravi-headshot',
				name: 'ravi-chandran-2026.png',
				kindLabel: 'PNG image',
				sizeLabel: '2.4 MB',
				href: '/app/files'
			}
		]
	},

	/* Settled work whose material stays readable — the archive half of §3.5. */
	'task-bio:spk-5': {
		kind: 'form',
		submittedAt: 'Jul 30, 11:48 EDT',
		answers: [
			{
				fieldId: 'bio',
				label: 'Speaker bio',
				value:
					'Lukas Brandt builds the reliability tooling behind PerfPanel’s agent platform. He has spent four years learning that most agent failures are queueing problems wearing a costume.'
			},
			{ fieldId: 'pronouns', label: 'Pronouns', value: 'he/him' },
			{ fieldId: 'title', label: 'Job title', value: 'Staff Engineer, PerfPanel' }
		]
	},
	'task-slides:spk-5': {
		kind: 'upload',
		submittedAt: 'Aug 09, 16:22 EDT',
		files: [
			{
				id: 'file-lukas-slides',
				name: 'who-owns-agent-reliability-draft.pdf',
				kindLabel: 'PDF document',
				sizeLabel: '8.1 MB',
				href: '/app/files'
			}
		]
	},
	'task-travel:spk-6': {
		kind: 'form',
		submittedAt: 'Aug 02, 08:30 EDT',
		answers: [
			{ fieldId: 'arrival', label: 'Arriving', value: 'Sun Oct 11 — driving, no flight to book' },
			{ fieldId: 'departure', label: 'Leaving', value: 'Wed Oct 14 after the closing panel' },
			{ fieldId: 'hotel', label: 'Accommodation', value: 'Staying with family in Queens.' },
			{ fieldId: 'access', label: 'Access or mobility needs', value: '' },
			{ fieldId: 'dietary', label: 'Dietary requirements', value: 'No restrictions.' },
			{ fieldId: 'notes', label: 'Anything else we should know', value: '' }
		]
	},

	/*
	 * Maya's material, kept whole through a cancellation request. The archive is
	 * the point: whatever happens to the engagement, what she sent stays readable.
	 */
	'task-headshot:spk-1': {
		kind: 'upload',
		submittedAt: 'Jul 21, 13:02 EDT',
		files: [
			{
				id: 'file-maya-headshot',
				name: 'maya-lindqvist.jpg',
				kindLabel: 'JPEG image',
				sizeLabel: '1.1 MB',
				href: '/app/files'
			}
		]
	},
	'task-bio:spk-1': {
		kind: 'form',
		submittedAt: 'Jul 21, 13:06 EDT',
		answers: [
			{
				fieldId: 'bio',
				label: 'Speaker bio',
				value:
					'Maya Lindqvist works on CDN invalidation and cache correctness at NordicWeb, where she is responsible for the incident review that nobody enjoys.'
			},
			{ fieldId: 'pronouns', label: 'Pronouns', value: 'she/her' },
			{ fieldId: 'title', label: 'Job title', value: 'Platform Engineer, NordicWeb' }
		]
	},
	'task-av:spk-1': {
		kind: 'form',
		submittedAt: 'Aug 04, 19:55 EDT',
		answers: [
			{ fieldId: 'laptop', label: 'Presenting from', value: 'My own laptop — USB-C, I will bring an HDMI adapter' },
			{ fieldId: 'audio', label: 'Audio needed', value: 'Yes — one clip with sound, about 40 seconds' },
			{ fieldId: 'mic', label: 'Microphone preference', value: 'Headset, not handheld' }
		]
	},

	/* Sofia is the record that is boring on purpose: everything settled. */
	'task-av:spk-4': {
		kind: 'form',
		submittedAt: 'Aug 01, 10:15 EDT',
		answers: [
			{ fieldId: 'laptop', label: 'Presenting from', value: 'House machine is fine' },
			{ fieldId: 'audio', label: 'Audio needed', value: 'No' },
			{ fieldId: 'mic', label: 'Microphone preference', value: 'Lapel' }
		]
	},
	'task-headshot:spk-4': {
		kind: 'upload',
		submittedAt: 'Jul 18, 09:40 EDT',
		files: [
			{
				id: 'file-sofia-headshot',
				name: 'sofia-berg-panel.png',
				kindLabel: 'PNG image',
				sizeLabel: '3.0 MB',
				href: '/app/files'
			}
		]
	},

	/*
	 * Elena started her headshot in the portal and never submitted it. The
	 * organizer must never see this: an autosave is her own workspace, and the
	 * row says "Not yet submitted" instead. It is authored precisely so the rule
	 * has something real to suppress.
	 */
	'task-headshot:spk-7': {
		kind: 'draft',
		startedAt: 'Aug 12, 22:41 EDT'
	}
});

/** The material committed against one assignment, or null when there is none. */
export function sampleTaskSubmission(taskId: string, speakerId: string): TaskSubmission | null {
	return content[assignmentKey(taskId, speakerId)] ?? null;
}

/**
 * Who closed an assignment and when, for work that was already settled before
 * this session began. Acts committed during the session record their own.
 */
const settlements: Readonly<Record<AssignmentKey, { readonly at: string; readonly by: string }>> =
	Object.freeze({
		'task-headshot:spk-1': { at: 'Jul 22, 09:14 EDT', by: 'Jonas Weber' },
		'task-bio:spk-1': { at: 'Jul 22, 09:15 EDT', by: 'Jonas Weber' },
		'task-av:spk-1': { at: 'Aug 05, 08:02 EDT', by: 'you' },
		'task-bio:spk-5': { at: 'Jul 31, 07:50 EDT', by: 'Jonas Weber' },
		'task-slides:spk-5': { at: 'Aug 10, 09:31 EDT', by: 'you' },
		'task-travel:spk-6': { at: 'Aug 02, 14:12 EDT', by: 'you' },
		'task-av:spk-4': { at: 'Aug 01, 16:44 EDT', by: 'Jonas Weber' },
		'task-headshot:spk-4': { at: 'Jul 18, 12:00 EDT', by: 'Jonas Weber' },
		/* Daniel's slides were waived: an optional deliverable nobody is chasing. */
		'task-slides:spk-8': { at: 'Aug 14, 15:20 EDT', by: 'you' }
	});

export function sampleTaskSettlement(
	taskId: string,
	speakerId: string
): { readonly at: string; readonly by: string } | null {
	return settlements[assignmentKey(taskId, speakerId)] ?? null;
}
