declare module 'jooevents-operator-page' {
	import type { Component } from 'svelte';
	import type { OperatorPageId } from '$lib/api/composition/operator-pages';
	const OperatorPage: Component<{ readonly area: OperatorPageId }>;
	export default OperatorPage;
}
