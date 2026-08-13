/**
 * The operator workspace's navigation model. Shared so the shell, destination
 * titles, and active-state logic cannot drift apart. Counts beside labels are
 * runtime data (workspace summary), not part of this static model.
 */

import type { Icon } from 'lucide-svelte';
import {
	CalendarDays,
	CodeXml,
	FileText,
	Inbox,
	LayoutDashboard,
	LayoutTemplate,
	ListChecks,
	Send,
	Settings,
	Stamp,
	UserPen,
	Users
} from 'lucide-svelte';
import type { AreaKey, NavCounts } from '$lib/api/types';

/** Viewer facts needed to shape navigation, independent of any data source. */
export type WorkspaceNavigationViewer =
	| { readonly kind: 'organizer' }
	| { readonly kind: 'reviewer'; readonly reviewerId: string };

export type IconComponent = typeof Icon;

export interface NavItem {
	key: AreaKey;
	label: string;
	href: string;
	icon: IconComponent;
}

export interface NavGroup {
	label: string;
	items: NavItem[];
}

export const overviewItem: NavItem = {
	key: 'overview',
	label: 'Overview',
	href: '/app',
	icon: LayoutDashboard
};

export const navGroups: NavGroup[] = [
	{
		label: 'Program',
		items: [
			{ key: 'submissions', label: 'Submissions', href: '/app/submissions', icon: Inbox },
			{ key: 'review', label: 'Review', href: '/app/review', icon: ListChecks },
			{ key: 'decisions', label: 'Decisions', href: '/app/decisions', icon: Stamp }
		]
	},
	{
		label: 'People',
		items: [
			{ key: 'speakers', label: 'Speakers', href: '/app/speakers', icon: Users },
			{ key: 'reviewers', label: 'Reviewers', href: '/app/reviewers', icon: UserPen },
			{ key: 'tasks', label: 'Tasks', href: '/app/tasks', icon: ListChecks }
		]
	},
	{
		label: 'Event',
		items: [
			{ key: 'schedule', label: 'Schedule', href: '/app/schedule', icon: CalendarDays },
			{ key: 'messages', label: 'Communications', href: '/app/messages', icon: Send },
			{ key: 'forms', label: 'Forms', href: '/app/forms', icon: FileText },
			{ key: 'templates', label: 'Templates', href: '/app/templates', icon: LayoutTemplate },
			/*
			 * Embeds is its own row rather than a fourth tab under Templates. The
			 * word is what someone hunting for this feature actually looks for —
			 * "Templates" names how the pages are authored, not that they can be
			 * put on your own site — and the job is genuinely a different one:
			 * Templates decides what a public page says, Embeds hands you the code
			 * that carries it onto somebody else's page. Every surface's snippet
			 * resolves here, from all four directions.
			 */
			{ key: 'embeds', label: 'Embeds', href: '/app/embeds', icon: CodeXml }
		]
	}
];

export const settingsItem: NavItem = {
	key: 'settings',
	label: 'Settings',
	href: '/app/settings',
	icon: Settings
};

const allItems = [overviewItem, ...navGroups.flatMap((group) => group.items), settingsItem];

/**
 * The rail, for whoever is looking at it.
 *
 * A reviewer holds review permissions and nothing else, so every other row
 * would be a door that refuses. They are absent rather than locked: the locked
 * treatment promises "not yet" — it is how the shell says an area opens once an
 * event exists — and for this person it never opens. Absent is also the only
 * honest option for the areas whose surfaces are organizer projections through
 * and through; a reviewer-shaped Submissions or Overview does not exist, and a
 * row leading to sample-looking rows they may not read would be worse than no
 * row at all.
 *
 * The organizer model returns the shared items unchanged, so the rail it
 * renders is the same one it rendered before this projection existed.
 */
export interface NavModel {
	/** Where the wordmark goes: the viewer's own first surface. */
	home: string;
	/** Present when the viewer has an overview projection to land on. */
	overview?: NavItem;
	groups: NavGroup[];
	/** Present when the viewer administers the workspace. */
	settings?: NavItem;
}

/** The areas a reviewer-only principal has a surface for. */
const reviewerAreas: readonly AreaKey[] = ['review'];

export function navModel(viewer: WorkspaceNavigationViewer): NavModel {
	if (viewer.kind === 'organizer') {
		return { home: overviewItem.href, overview: overviewItem, groups: navGroups, settings: settingsItem };
	}
	const groups = navGroups
		.map((group) => ({
			label: group.label,
			items: group.items.filter((item) => reviewerAreas.includes(item.key))
		}))
		.filter((group) => group.items.length > 0);
	return { home: groups[0]?.items[0]?.href ?? overviewItem.href, groups };
}

/** Overview matches only itself; every other destination owns its subtree. */
export function isActive(pathname: string, href: string): boolean {
	if (href === '/app') return pathname === '/app';
	return pathname === href || pathname.startsWith(`${href}/`);
}

/** The navigation label owning this path, for titling a destination. */
export function destinationLabel(pathname: string): string | undefined {
	return allItems
		.filter((item) => isActive(pathname, item.href))
		.sort((a, b) => b.href.length - a.href.length)[0]?.label;
}

/**
 * Where a blocking count sends its nav item.
 *
 * A count beside a label never becomes a second, separately-clickable control —
 * it re-aims the one link the row already has. `Schedule 2` in danger tone means
 * the schedule cannot publish, so the better destination is the conflicts panel
 * rather than the area root. Warning and inventory counts keep the root: they
 * describe a workload, not a blockage, and the whole area is the answer.
 *
 * These are the same addresses the matching Overview attention rows use, so one
 * fact never acquires two landings.
 */
const blockedDestination: Partial<Record<AreaKey, string>> = {
	decisions: '/app/decisions?scope=unnotified',
	tasks: '/app/tasks?filter=overdue',
	schedule: '/app/schedule?panel=conflicts'
};

/** The address a nav item points at, given the count it is currently showing. */
export function navHref(item: NavItem, meta?: { tone?: 'warning' | 'danger' }): string {
	if (meta?.tone !== 'danger') return item.href;
	return blockedDestination[item.key] ?? item.href;
}

/** The count (and chip tone, when actionable) a nav item shows. */
export function navMeta(
	counts: NavCounts,
	key: AreaKey
): { value: string; tone?: 'warning' | 'danger' } | undefined {
	switch (key) {
		case 'submissions':
			return counts.submissions ? { value: counts.submissions } : undefined;
		case 'review':
			return counts.review ? { value: counts.review } : undefined;
		case 'decisions':
			return counts.decisions;
		case 'speakers':
			return counts.speakers ? { value: counts.speakers } : undefined;
		case 'reviewers':
			return counts.reviewers ? { value: counts.reviewers } : undefined;
		case 'tasks':
			return counts.tasks;
		case 'schedule':
			return counts.schedule;
		case 'messages':
			return counts.messages ? { value: counts.messages } : undefined;
		case 'templates':
			return counts.templates ? { value: counts.templates } : undefined;
		default:
			return undefined;
	}
}
