<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		legend: string;
		layout?: 'stack' | 'inline';
		children: Snippet;
	}

	let { legend, layout = 'stack', children }: Props = $props();
</script>

<fieldset class="ui-choice-group">
	<legend class="ui-choice-group__legend">{legend}</legend>
	<div class:ui-choice-group__choices--inline={layout === 'inline'} class="ui-choice-group__choices">
		{@render children()}
	</div>
</fieldset>
