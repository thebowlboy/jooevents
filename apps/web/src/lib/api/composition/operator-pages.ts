export const operatorPageIds = Object.freeze([
	'overview',
	'submissions',
	'review',
	'review_lineup',
	'decisions',
	'speakers',
	'reviewers',
	'tasks',
	'schedule',
	'communications',
	'forms',
	'templates',
	'embeds',
	'settings'
] as const);

export type OperatorPageId = (typeof operatorPageIds)[number];
