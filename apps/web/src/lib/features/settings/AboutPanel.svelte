<script lang="ts">
	/**
	 * This describes the software, not the workspace, so it is the one section
	 * that still reads correctly before anything has been set up — and the only
	 * place in the product carrying every maker link. Someone who came here is
	 * looking for the source or the person, which no one signing in is.
	 */
	import {
		ATTRIBUTION_PLACEMENT,
		COPYRIGHT_FULL,
		LICENSE_NAME,
		LICENSE_POSTURE,
		MAKER,
		SOURCE_URL
	} from '$lib/brand/attribution';
</script>

{#if ATTRIBUTION_PLACEMENT.about}
	<section class="panel about" id="settings-about" aria-label="About JooEvents">
		<header class="panel__head">
			<div class="panel__title"><h2>About</h2></div>
		</header>

		<dl class="about__facts">
			<dt>Licence</dt>
			<dd>{LICENSE_POSTURE} — {LICENSE_NAME}</dd>
			<dt>Copyright</dt>
			<dd>{COPYRIGHT_FULL}</dd>
			<dt>Made by</dt>
			<dd>
				<span class="about__maker">{MAKER.name}</span>
				<span class="about__links">
					<a href={MAKER.x.href} target="_blank" rel="me noopener" aria-label={MAKER.x.label}
						>{MAKER.x.handle}</a>
					<a href={MAKER.github.href} target="_blank" rel="me noopener" aria-label={MAKER.github.label}
						>GitHub</a>
					{#if SOURCE_URL}
						<a href={SOURCE_URL} target="_blank" rel="noopener">Source</a>
					{/if}
				</span>
			</dd>
		</dl>
	</section>
{/if}

<style>
	.panel {
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
		padding: var(--je-space-4);
	}

	.panel__head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-4);
		margin-block-end: var(--je-space-4);
	}

	.panel__title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--je-space-2) var(--je-space-3);
	}

	.panel__head h2 {
		margin: 0;
		font-size: var(--je-font-size-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: var(--je-tracking-caps);
		color: var(--je-color-text-muted);
	}

	/* A reference list rather than a settings form: the labels stay quiet, the
	   values carry the ink, and nothing here takes a control — the panel is read
	   once and must not invite editing. */
	.about__facts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--je-space-2) var(--je-space-4);
		margin: 0;
		font-size: var(--je-font-size-sm);
	}

	.about__facts dt {
		color: var(--je-color-text-muted);
	}

	.about__facts dd {
		margin: 0;
	}

	.about__maker {
		font-weight: 600;
	}

	.about__links {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--je-space-3);
		margin-inline-start: var(--je-space-3);
	}

	.about__links a {
		color: var(--je-color-action);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		border-radius: var(--je-radius-sm);
	}

	.about__links a:hover {
		color: var(--je-color-action-hover);
	}

	.about__links a:focus-visible {
		outline: 2px solid var(--je-color-focus);
		outline-offset: 2px;
	}

	@media (max-width: 920px) {
		/* One column: the licence value is long enough that a label column at this
		   width leaves it wrapping in a few characters. */
		.about__facts {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--je-space-1);
		}

		.about__facts dd:not(:last-of-type) {
			margin-block-end: var(--je-space-3);
		}
	}
</style>
