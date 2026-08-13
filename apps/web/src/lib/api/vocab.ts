/**
 * Vocabulary usage: the counting predicates and the copy that depends on them.
 * One module owns all three, so what a list reports, what a screen explains
 * before an attempt, and what a refused removal returns cannot disagree.
 */

import { presentProgramVocabularyUsage } from './program-vocabulary-presentation';
import type {
	ReferenceVocabUsage,
	VocabStatus,
	VocabUsage,
	WorkflowVocabUsage
} from './types';

export type VocabKind = 'track' | 'format' | 'room';

/** The records a usage count is drawn from. */
export interface VocabUsageSource {
	submissions: readonly { trackId: string; formatId: string }[];
	sessions: readonly { trackId: string; formatId: string }[];
	placements: readonly { roomId: string }[];
}

export function trackUsage(id: string, source: VocabUsageSource): WorkflowVocabUsage {
	return {
		submissions: source.submissions.filter((submission) => submission.trackId === id).length,
		sessions: source.sessions.filter((session) => session.trackId === id).length,
		placements: 0
	};
}

export function formatUsage(id: string, source: VocabUsageSource): WorkflowVocabUsage {
	return {
		submissions: source.submissions.filter((submission) => submission.formatId === id).length,
		sessions: source.sessions.filter((session) => session.formatId === id).length,
		placements: 0
	};
}

export function roomUsage(id: string, source: VocabUsageSource): WorkflowVocabUsage {
	return {
		submissions: 0,
		sessions: 0,
		placements: source.placements.filter((placement) => placement.roomId === id).length
	};
}

export function usageOf(kind: VocabKind, id: string, source: VocabUsageSource): WorkflowVocabUsage {
	if (kind === 'track') return trackUsage(id, source);
	if (kind === 'format') return formatUsage(id, source);
	return roomUsage(id, source);
}

export function usageTotal(usage: VocabUsage): number {
	return isReferenceUsage(usage)
		? usage.currentReferences + usage.historicalPins
		: usage.submissions + usage.sessions + usage.placements;
}

function counted(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** The entry's own line: what points at it today. */
export function usageLabel(kind: VocabKind, usage: VocabUsage): string {
	if (isReferenceUsage(usage)) {
		const presentation = presentProgramVocabularyUsage(usage);
		return presentation.kind === 'unused' ? 'not used yet' : presentation.label;
	}
	if (usageTotal(usage) === 0) return 'not used yet';
	if (kind === 'room') return counted(usage.placements, 'scheduled session');
	const parts: string[] = [];
	if (usage.submissions > 0) parts.push(counted(usage.submissions, 'submission'));
	if (usage.sessions > 0) parts.push(counted(usage.sessions, 'session'));
	return parts.join(' · ');
}

/**
 * Why deletion is unavailable, or null while nothing references the entry and
 * deletion is offered. The same sentence explains the state before an attempt
 * and answers an attempt that reaches the server anyway.
 *
 * `reviewerScopes` is the count of reviewer scopes naming this entry (counted
 * by `scopeRefCount` in the reviewers module); a scope ref blocks removal
 * like any other reference, while retiring stays available.
 */
export function removalBlockReason(
	kind: VocabKind,
	usage: VocabUsage,
	status: VocabStatus = 'active',
	reviewerScopes = 0
): string | null {
	const total = usageTotal(usage);
	if (total === 0 && reviewerScopes === 0) return null;
	if (isReferenceUsage(usage)) {
		const references = presentProgramVocabularyUsage(usage);
		const referenced = references.kind === 'unused'
			? ''
			: `${references.label} ${total === 1 ? 'keeps' : 'keep'} this ${kind} resolvable`;
		const scoped = `it is in ${counted(reviewerScopes, 'reviewer scope')}`;
		const claim = total === 0
			? `This ${kind} is in ${counted(reviewerScopes, 'reviewer scope')}`
			: reviewerScopes === 0
				? referenced
				: `${referenced}, and ${scoped}`;
		const remedy = status === 'retired'
			? 'It stays retired and remains available to the records that already use it.'
			: 'Retire it to stop new use — existing records keep resolving it.';
		return `${claim}. ${remedy}`;
	}
	const referenced =
		kind === 'room'
			? `${counted(usage.placements, 'scheduled session')} ${usage.placements === 1 ? 'sits' : 'sit'} in this room`
			: kind === 'track'
				? `${counted(total, 'submission')} and sessions reference this track`
				: `${counted(total, 'submission')} and sessions use this format`;
	const scoped = `in ${counted(reviewerScopes, 'reviewer scope')}`;
	const claim =
		total === 0
			? `This ${kind} is ${scoped}`
			: reviewerScopes === 0
				? referenced
				: `${referenced}, and it is ${scoped}`;
	const remedy =
		status === 'retired'
			? 'It stays retired and keeps rendering wherever it is used.'
			: 'Retire it to stop new use — everything already using it keeps rendering.';
	return `${claim}. ${remedy}`;
}

function isReferenceUsage(usage: VocabUsage): usage is ReferenceVocabUsage {
	return 'currentReferences' in usage;
}
