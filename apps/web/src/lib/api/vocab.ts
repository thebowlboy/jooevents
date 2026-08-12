/**
 * Vocabulary usage: the counting predicates and the copy that depends on them.
 * One module owns all three, so what a list reports, what a screen explains
 * before an attempt, and what a refused removal returns cannot disagree.
 */

import type { VocabStatus, VocabUsage } from './types';

export type VocabKind = 'track' | 'format' | 'room';

/** The records a usage count is drawn from. */
export interface VocabUsageSource {
	submissions: readonly { trackId: string; formatId: string }[];
	sessions: readonly { trackId: string; formatId: string }[];
	placements: readonly { roomId: string }[];
}

export function trackUsage(id: string, source: VocabUsageSource): VocabUsage {
	return {
		submissions: source.submissions.filter((submission) => submission.trackId === id).length,
		sessions: source.sessions.filter((session) => session.trackId === id).length,
		placements: 0
	};
}

export function formatUsage(id: string, source: VocabUsageSource): VocabUsage {
	return {
		submissions: source.submissions.filter((submission) => submission.formatId === id).length,
		sessions: source.sessions.filter((session) => session.formatId === id).length,
		placements: 0
	};
}

export function roomUsage(id: string, source: VocabUsageSource): VocabUsage {
	return {
		submissions: 0,
		sessions: 0,
		placements: source.placements.filter((placement) => placement.roomId === id).length
	};
}

export function usageOf(kind: VocabKind, id: string, source: VocabUsageSource): VocabUsage {
	if (kind === 'track') return trackUsage(id, source);
	if (kind === 'format') return formatUsage(id, source);
	return roomUsage(id, source);
}

export function usageTotal(usage: VocabUsage): number {
	return usage.submissions + usage.sessions + usage.placements;
}

function counted(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** The entry's own line: what points at it today. */
export function usageLabel(kind: VocabKind, usage: VocabUsage): string {
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
 */
export function removalBlockReason(
	kind: VocabKind,
	usage: VocabUsage,
	status: VocabStatus = 'active'
): string | null {
	const total = usageTotal(usage);
	if (total === 0) return null;
	const referenced =
		kind === 'room'
			? `${counted(usage.placements, 'scheduled session')} ${usage.placements === 1 ? 'sits' : 'sit'} in this room`
			: kind === 'track'
				? `${counted(total, 'submission')} and sessions reference this track`
				: `${counted(total, 'submission')} and sessions use this format`;
	const remedy =
		status === 'retired'
			? 'It stays retired and keeps rendering wherever it is used.'
			: 'Retire it to stop new use — everything already using it keeps rendering.';
	return `${referenced}. ${remedy}`;
}
