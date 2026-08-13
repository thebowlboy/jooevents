<script lang="ts">
	/**
	 * A lifecycle state, always as a badge. The word is the encoding and the
	 * glyph is recognition support, so the two never disagree and a state is
	 * never left as plain grey text.
	 */
	import { Badge } from '$lib/ui';
	import type { StateCopy } from '../copy';

	let { state }: { state: StateCopy } = $props();
</script>

<Badge tone={state.tone} icon={state.icon}>{state.label}</Badge>
