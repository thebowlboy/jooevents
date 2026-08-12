/**
 * The operator workspace's navigation model. Shared so the shell, destination
 * titles, and active-state logic cannot drift apart. Counts beside labels are
 * runtime data (workspace summary), not part of this static model.
 */

import type { Icon } from 'lucide-svelte';
import {
	CalendarDays,
	FileText,
	Inbox,
	LayoutDashboard,
	LayoutTemplate,
	ListChecks,
	Send,
	Settings,
	Stamp,
	Users
} from 'lucide-svelte';
import type { AreaKey, NavCounts } from '$lib/api/types';

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
			{ key: 'tasks', label: 'Tasks', href: '/app/tasks', icon: ListChecks }
		]
	},
	{
		label: 'Event',
		items: [
			{ key: 'schedule', label: 'Schedule', href: '/app/schedule', icon: CalendarDays },
			{ key: 'messages', label: 'Messages', href: '/app/messages', icon: Send },
			{ key: 'forms', label: 'Forms', href: '/app/forms', icon: FileText },
			{ key: 'templates', label: 'Templates', href: '/app/templates', icon: LayoutTemplate }
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
