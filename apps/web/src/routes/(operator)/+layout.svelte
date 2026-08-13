<script lang="ts">
	import OperatorWorkspaceRoot from 'jooevents-operator-workspace-root';

	let { children } = $props();

	// The shell is chrome, not content: owning it here keeps one sidebar instance
	// alive across every in-app navigation. A per-page shell had to be rebuilt on
	// each visit, which is why a clicked destination could not report itself
	// selected until its page had finished arriving.
	//
	// Operator surfaces also run at internal-operations density.
	$effect(() => {
		const previous = document.documentElement.dataset.density;
		document.documentElement.dataset.density = 'compact';
		return () => {
			if (previous === undefined) delete document.documentElement.dataset.density;
			else document.documentElement.dataset.density = previous;
		};
	});
</script>

<OperatorWorkspaceRoot>
	{@render children()}
</OperatorWorkspaceRoot>
