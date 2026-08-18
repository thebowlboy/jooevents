import type { OrganizerEngagementFilesView } from '$lib/api/files/view-models';

export interface ReceivedFilesFilter {
	readonly file: string;
	readonly session: string;
}

/** Filters only the event-scoped groups supplied by the Files port. */
export function filterReceivedFiles(
	groups: readonly OrganizerEngagementFilesView[],
	filter: ReceivedFilesFilter
): OrganizerEngagementFilesView[] {
	const fileQuery = filter.file.trim().toLocaleLowerCase();
	return groups.flatMap((group) => {
		if (filter.session && group.label.session !== filter.session) return [];
		const items = fileQuery
			? group.items.filter((item) =>
				(item.kind === 'file' ? item.name : item.label).toLocaleLowerCase().includes(fileQuery))
			: group.items;
		return items.length > 0 ? [{ ...group, items }] : [];
	});
}

export function receivedSessionChoices(
	groups: readonly OrganizerEngagementFilesView[]
): readonly string[] {
	return [...new Set(groups.map((group) => group.label.session))]
		.sort((left, right) => left.localeCompare(right));
}
