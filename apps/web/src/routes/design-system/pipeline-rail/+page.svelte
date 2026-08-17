<script lang="ts">
	import PipelineRail, { type RailNode } from '$lib/features/workspace/components/PipelineRail.svelte';
	import { pipelineStageMeta } from '$lib/api/pipeline-stages';
	import {
		navGroups,
		overviewItem,
		settingsItem
	} from '$lib/features/workspace/navigation';

	// The Overview runs at the operator shell's density; the specimen matches it
	// so the plates and labels are judged at the size they actually render.
	$effect(() => {
		const previous = document.documentElement.dataset.density;
		document.documentElement.dataset.density = 'compact';
		return () => {
			if (previous === undefined) delete document.documentElement.dataset.density;
			else document.documentElement.dataset.density = previous;
		};
	});

	const navItems = [overviewItem, ...navGroups.flatMap((group) => group.items), settingsItem];
	const areaIcon = Object.fromEntries(navItems.map((item) => [item.key, item.icon]));

	function nodes(states: readonly RailNode['state'][]): RailNode[] {
		return pipelineStageMeta.map((meta, index) => ({
			key: meta.key,
			label: meta.label,
			icon: areaIcon[meta.iconArea ?? meta.area],
			state: states[index]
		}));
	}

	/** Nothing has begun: every node recedes and the first is the gate. */
	const dormantNodes = nodes(['gate', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
	/** Collecting and triage run; review is the next gate; speakers uncounted. */
	const midNodes = nodes(['running', 'running', 'gate', 'upcoming', 'uncounted', 'upcoming', 'upcoming']);
</script>

<svelte:head>
	<title>Pipeline rail · JooEvents design system</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="page">
	<h1>Pipeline rail</h1>
	<p class="lede">
		The event's pipeline as a path — the submission journey strip's grammar one level up.
		Position only, in neutral ink: running holds full ink, the ringed node is the next
		gate, not-started recedes, uncounted is dashed out of play. Health never paints the
		rail; it already speaks once, on the lanes.
	</p>

	<section class="specimen">
		<h2>Hero — a dormant event</h2>
		<p class="note">
			The dormant Overview's centerpiece: nothing runs, the first stage is the gate, and
			the gate's condition and door render beneath (on the Overview, not here). Narrow
			widths re-compose the path onto the vertical axis.
		</p>
		<div class="plate">
			<PipelineRail nodes={dormantNodes} variant="hero" />
		</div>
	</section>

	<section class="specimen">
		<h2>Hero — mid-flight</h2>
		<div class="plate">
			<PipelineRail nodes={midNodes} variant="hero" />
		</div>
	</section>

	<section class="specimen">
		<h2>Strip — the running dashboard's map</h2>
		<p class="note">
			Rendered above the lanes only while some stage is missing from them; once every
			stage runs, the lanes are the whole story and the strip retires. Order carries the
			sequence, so the strip spends no connectors and wraps at any width.
		</p>
		<div class="plate">
			<PipelineRail nodes={midNodes} variant="strip" />
		</div>
	</section>
</main>

<style>
	.page {
		max-inline-size: 56rem;
		margin-inline: auto;
		padding: var(--je-space-8) var(--je-space-4) var(--je-space-12);
	}

	h1 {
		margin: 0 0 var(--je-space-2);
		font-family: var(--je-font-display);
		font-size: var(--je-font-size-2xl);
	}

	.lede {
		margin: 0 0 var(--je-space-8);
		color: var(--je-color-text-muted);
		max-inline-size: 44rem;
	}

	.specimen + .specimen {
		margin-block-start: var(--je-space-8);
	}

	h2 {
		margin: 0 0 var(--je-space-2);
		font-size: var(--je-font-size-md);
	}

	.note {
		margin: 0 0 var(--je-space-3);
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text-muted);
		max-inline-size: 44rem;
	}

	.plate {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}
</style>
