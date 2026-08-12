/**
 * The critical escalation tier: the catalog of situations serious enough to
 * interrupt an otherwise calm surface, and the switches that keep it dark.
 *
 * One module owns the catalog, the activation switches, and the per-view
 * selection so no surface can invent its own emergency or disagree with
 * another about which situation a view is currently in.
 */

export type CriticalSituationKey =
	| 'deadline-imminent'
	| 'cancellation-unresolved'
	| 'publish-blocked';

export interface CriticalSituationDef {
	key: CriticalSituationKey;
	title: string;
	description: string;
	/** When the situation would activate, in prose, for the switch owner. */
	activation: string;
	/** The one view the situation escalates. */
	view: 'tasks' | 'speakers' | 'schedule';
}

/** Priority order: when situations compete, the first match wins. */
export const criticalSituations: readonly CriticalSituationDef[] = [
	{
		key: 'deadline-imminent',
		title: 'Hard deadline imminent',
		description: 'A hard deadline is close and required work is still outstanding',
		activation:
			'Within the configured window of a hard deadline while required tasks remain incomplete',
		view: 'tasks'
	},
	{
		key: 'cancellation-unresolved',
		title: 'Cancellation unresolved',
		description: 'A cancellation request is still unanswered as the event nears',
		activation:
			'While a cancellation request remains unanswered inside the configured window before the event',
		view: 'speakers'
	},
	{
		key: 'publish-blocked',
		title: 'Publish blocked',
		description: 'Publication is blocked by unresolved conflicts close to the event',
		activation:
			'While unresolved schedule conflicts still block publication inside the configured window before the event',
		view: 'schedule'
	}
];

/**
 * The tier's whole activation surface. The tier is defined but dormant: every
 * switch ships false, and turning one on is a product tuning decision, not a
 * code path. No feature code may self-declare an emergency — a view either
 * receives its situation through this registry or it stays calm.
 */
export const escalationConfig: {
	enabled: boolean;
	situations: Record<CriticalSituationKey, boolean>;
} = {
	enabled: false,
	situations: {
		'deadline-imminent': false,
		'cancellation-unresolved': false,
		'publish-blocked': false
	}
};

/**
 * The one situation a view may currently escalate, or null while it is calm.
 * A situation surfaces only when its own switch and the master switch are both
 * on. Returning at most one per view is deliberate structure, not a
 * simplification: the tier works only while it is scarce, so when situations
 * compete for a view the catalog order decides and the rest wait rather than
 * stack.
 */
export function criticalSituationFor(view: CriticalSituationDef['view']): CriticalSituationDef | null {
	if (!escalationConfig.enabled) return null;
	return (
		criticalSituations.find(
			(situation) => situation.view === view && escalationConfig.situations[situation.key]
		) ?? null
	);
}
