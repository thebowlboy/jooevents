/**
 * Presentation facts shared by the tuned workspace screens and the canonical
 * Program Vocabulary adapter. Keeping these tiny formatters outside the live
 * client lets sample and live compositions render the same truthful states.
 */

export interface ProgramVocabularyReferenceUsage {
	readonly currentReferences: number;
	readonly historicalPins: number;
}

export type ProgramVocabularyUsagePresentation =
	| { readonly kind: 'unused'; readonly label: 'Not used yet' }
	| {
			readonly kind: 'references';
			readonly currentReferences: number;
			readonly historicalPins: number;
			readonly label: string;
	  };

export type ProgramRoomCapacityPresentation =
	| { readonly kind: 'known'; readonly seats: number; readonly label: string }
	| { readonly kind: 'unknown'; readonly label: 'Capacity not set' };

function counted(value: number, singular: string): string {
	return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

export function presentProgramVocabularyUsage(
	usage: ProgramVocabularyReferenceUsage
): ProgramVocabularyUsagePresentation {
	if (usage.currentReferences === 0 && usage.historicalPins === 0) {
		return Object.freeze({ kind: 'unused', label: 'Not used yet' });
	}
	const parts: string[] = [];
	if (usage.currentReferences > 0) {
		parts.push(counted(usage.currentReferences, 'current reference'));
	}
	if (usage.historicalPins > 0) {
		parts.push(counted(usage.historicalPins, 'historical pin'));
	}
	return Object.freeze({
		kind: 'references',
		currentReferences: usage.currentReferences,
		historicalPins: usage.historicalPins,
		label: parts.join(' · ')
	});
}

export function presentProgramRoomCapacity(
	capacity: number | null
): ProgramRoomCapacityPresentation {
	return capacity === null
		? Object.freeze({ kind: 'unknown', label: 'Capacity not set' })
		: Object.freeze({ kind: 'known', seats: capacity, label: counted(capacity, 'seat') });
}
