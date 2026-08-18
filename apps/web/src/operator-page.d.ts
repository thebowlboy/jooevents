declare module 'jooevents-operator-page' {
	import type { Component } from 'svelte';
	import type { OperatorPageId } from '$lib/api/composition/operator-pages';
	/**
	 * `engagementId` is the record routes' path parameter, handed down from the
	 * route file rather than read from `$app/state` inside the feature: a record
	 * page then takes its subject as an ordinary prop and stays testable without
	 * a router.
	 */
	const OperatorPage: Component<{
		readonly area: OperatorPageId;
		readonly engagementId?: string;
	}>;
	export default OperatorPage;
}
