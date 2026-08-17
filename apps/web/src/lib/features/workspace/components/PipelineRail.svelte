<script module lang="ts">
	/**
	 * The event's pipeline as a path: seven stages in work order, each wearing
	 * its area's glyph, with position — not health — as the only claim.
	 *
	 * The grammar is the submission journey strip's, one level up: what runs
	 * holds full ink, the next stage is ringed, what has not begun recedes, and
	 * a stage nobody counts is dashed out of play. Neutral ink throughout,
	 * because "how far along" is not "how good" — health belongs to the lanes,
	 * which carry it in shape and hue beside their words. A rail that also
	 * painted status would say every fact twice.
	 *
	 * Non-interactive by design: the lanes are the doors, and a second pressable
	 * copy of each stage would be the one-fact-two-doors defect. The labels are
	 * visible text, so the list reads for everyone; the state travels as a
	 * visually hidden word beside each label, never as ink alone.
	 */
	import type { IconComponent } from '$lib/features/workspace/navigation';

	export interface RailNode {
		readonly key: string;
		readonly label: string;
		readonly icon: IconComponent;
		readonly state: 'running' | 'gate' | 'upcoming' | 'uncounted';
	}
</script>

<script lang="ts">
	let {
		nodes,
		variant = 'strip'
	}: {
		readonly nodes: readonly RailNode[];
		/** `hero` is the dormant event's centerpiece; `strip` is the running dashboard's one-line map. */
		readonly variant?: 'hero' | 'strip';
	} = $props();

	/** The state, as a word a screen reader hears beside the label. */
	const stateWord = {
		running: 'running',
		gate: 'next',
		upcoming: 'not started',
		uncounted: 'not counted'
	} as const;
</script>

<ol class="rail rail--{variant}">
	{#each nodes as node (node.key)}
		{@const Glyph = node.icon}
		<li class="rail__node rail__node--{node.state}">
			<span class="rail__plate" aria-hidden="true"><Glyph size={variant === 'hero' ? 18 : 14} /></span>
			<span class="rail__label">{node.label}<span class="ui-sr-only">, {stateWord[node.state]}</span></span>
		</li>
	{/each}
</ol>

<style>
	.rail {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rail__plate {
		display: grid;
		place-items: center;
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		flex-shrink: 0;
	}

	/* Position is ink, never hue: running holds full ink on a filled plate, the
	   ringed node is the frontier, not-started recedes, uncounted is dashed out
	   of play. Subtle ink on a glyph clears the 3:1 non-text floor at 4.14:1;
	   the label never drops below muted, because dimmed must not mean illegible. */
	.rail__node--running .rail__plate {
		background: var(--je-color-surface-sunken);
		border: 1px solid var(--je-color-border-strong);
		color: var(--je-color-text);
	}

	.rail__node--gate .rail__plate {
		border: 2px solid var(--je-color-text);
		color: var(--je-color-text);
	}

	.rail__node--upcoming .rail__plate {
		border: 1px solid var(--je-color-border-strong);
		color: var(--je-color-text-subtle);
	}

	.rail__node--uncounted .rail__plate {
		border: 1px dashed var(--je-color-border-strong);
		color: var(--je-color-text-subtle);
	}

	.rail__label {
		font-size: var(--je-font-size-sm);
		color: var(--je-color-text);
	}

	.rail__node--gate .rail__label {
		font-weight: 600;
	}

	.rail__node--upcoming .rail__label,
	.rail__node--uncounted .rail__label {
		color: var(--je-color-text-muted);
	}

	/* ------------------------------------------------------------------ hero */

	/* Seven equal columns so the connector arithmetic holds at any width; the
	   line runs plate-centre to plate-centre and the plates paint over it. */
	.rail--hero {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		row-gap: var(--je-space-2);
	}

	.rail--hero .rail__node {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.rail--hero .rail__plate {
		inline-size: 2.5rem;
		block-size: 2.5rem;
	}

	.rail--hero .rail__node + .rail__node::before {
		content: '';
		position: absolute;
		inset-block-start: calc(1.25rem - 0.5px);
		inset-inline-end: calc(50% + 1.25rem + var(--je-space-1));
		inline-size: calc(100% - 2.5rem - 2 * var(--je-space-1));
		block-size: 1px;
		background: var(--je-color-border-strong);
	}

	.rail--hero .rail__label {
		text-align: center;
		max-inline-size: 100%;
		overflow-wrap: anywhere;
	}

	/* The phone is not a narrow desktop: the path re-composes onto the vertical
	   axis — plates down a fixed rail, labels beside them, the connector rotated
	   with the flow rather than hidden. */
	@media (max-width: 560px) {
		.rail--hero {
			display: flex;
			flex-direction: column;
			row-gap: var(--je-space-3);
			align-items: stretch;
		}

		.rail--hero .rail__node {
			flex-direction: row;
			gap: var(--je-space-3);
			align-items: center;
		}

		.rail--hero .rail__node + .rail__node::before {
			inset-block-start: calc(-1 * var(--je-space-3));
			inset-inline-end: auto;
			inset-inline-start: calc(1.25rem - 0.5px);
			inline-size: 1px;
			block-size: var(--je-space-3);
		}

		.rail--hero .rail__label {
			text-align: start;
		}
	}

	/* ----------------------------------------------------------------- strip */

	/* A one-line map that wraps instead of scrolling: order carries the
	   sequence, so the strip spends no connectors and survives any width. */
	.rail--strip {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2) var(--je-space-4);
	}

	.rail--strip .rail__node {
		display: flex;
		align-items: center;
		gap: var(--je-space-2);
		min-width: 0;
	}

	.rail--strip .rail__plate {
		inline-size: 1.75rem;
		block-size: 1.75rem;
	}

	.rail--strip .rail__node--gate .rail__plate {
		border-width: 2px;
	}
</style>
