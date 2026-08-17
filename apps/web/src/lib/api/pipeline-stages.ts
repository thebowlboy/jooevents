import type { AreaKey, PipelineStage } from './types';

/**
 * The event pipeline as a product constant: seven stages, in the order work
 * flows through them. The Overview's rail, its lanes, and the live projection
 * mapping all read this one model, so a stage cannot spell its name, its
 * landing, or its not-started condition differently on two surfaces.
 */
export interface PipelineStageMeta {
	readonly key: PipelineStage['key'];
	readonly label: string;
	/**
	 * The area whose screen answers for this stage's facts — the lane's door.
	 * Collect and triage both resolve on the submissions screen; comms resolves
	 * on messages.
	 */
	readonly area: AreaKey;
	/**
	 * The area whose glyph is this stage's recognizable identity, where it
	 * differs from the door. Collect's door is the submissions screen, but its
	 * face is the form that collects — without this split, Collect and Triage
	 * would wear the same inbox mark, and two stages sharing one glyph on one
	 * rail defeats the recognition the glyph exists for.
	 */
	readonly iconArea?: AreaKey;
	/**
	 * The one sentence naming what starts this stage, shown while the stage is
	 * provably not begun. Stated as a fact about the mechanism, never as a
	 * refusal (`interface-language.md` §3).
	 */
	readonly unlock: string;
	/**
	 * The organizer act that starts the stage, where one exists. Arrival-gated
	 * stages (triage, decide) carry none: nothing an organizer presses makes a
	 * submission arrive. The label names the act, and the address must keep the
	 * label's promise — `?new=1` lands inside form creation, the rest land on
	 * the area root where the named act lives.
	 */
	readonly door?: { readonly label: string; readonly href: string };
}

/**
 * `Messages` rather than `Comms`: an abbreviation is forbidden on anything a
 * person reads as a control, and Messages is the name that matches the area's
 * route inside the label column's width.
 *
 * The collect door speaks the CFP vocabulary — the same words, landing on the
 * same address, as the empty submissions inbox's nudge — because opening the
 * call for proposals is the act's product name, and one act keeps one name
 * wherever it is offered (04 §2 direction note, 2026-08-13).
 */
export const pipelineStageMeta: readonly PipelineStageMeta[] = Object.freeze([
	{
		key: 'collect',
		label: 'Collect',
		area: 'submissions',
		iconArea: 'forms',
		unlock: 'Collecting starts when your call for proposals (CFP) opens.',
		door: { label: 'Open a call for proposals', href: '/app/forms?new=1' }
	},
	{
		key: 'triage',
		label: 'Triage',
		area: 'submissions',
		unlock: 'The first submission to arrive lands here.'
	},
	{
		key: 'review',
		label: 'Review',
		area: 'review',
		unlock: 'Reviewing starts when you open a round.',
		door: { label: 'Open Review', href: '/app/review' }
	},
	{
		key: 'decide',
		label: 'Decide',
		area: 'decisions',
		unlock: 'Submissions get their answer here, once they arrive.'
	},
	{
		key: 'speakers',
		label: 'Speakers',
		area: 'speakers',
		unlock: 'Speakers appear here once you invite someone.',
		door: { label: 'Open Speakers', href: '/app/speakers' }
	},
	{
		key: 'schedule',
		label: 'Schedule',
		area: 'schedule',
		unlock: 'Scheduling starts with the first session in the programme.',
		door: { label: 'Open Schedule', href: '/app/schedule' }
	},
	{
		key: 'comms',
		label: 'Messages',
		area: 'messages',
		unlock: 'Messages appear here once you send your first one.',
		door: { label: 'Open Messages', href: '/app/messages' }
	}
] as const);

export const pipelineStageByKey: ReadonlyMap<PipelineStage['key'], PipelineStageMeta> = new Map(
	pipelineStageMeta.map((stage) => [stage.key, stage])
);
