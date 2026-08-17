declare module 'jooevents-public-surface-root' {
	import type { Component, Snippet } from 'svelte';
	const PublicSurfaceRoot: Component<{ children: Snippet }>;
	export default PublicSurfaceRoot;
}

declare module 'jooevents-public-surface-page' {
	import type { Component } from 'svelte';
	const PublicSurfacePage: Component<{
		kind?: string;
		presentation?: 'page' | 'embed';
		onSubmitted?: () => void;
	}>;
	export default PublicSurfacePage;
}
