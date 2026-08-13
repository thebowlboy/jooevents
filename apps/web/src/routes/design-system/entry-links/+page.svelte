<script lang="ts">
	/**
	 * The magic link, both lanes, every state it can be in.
	 *
	 * The two surfaces share a frame and a geometry contract but not their
	 * words: the operator's acknowledgement is deliberately conditional, because
	 * that lane never registers anyone, and the participant's is plain, because
	 * that lane does. Put side by side, the difference is the point.
	 */
	import AccessEntryFrame from '$lib/features/access/components/AccessEntryFrame.svelte';
	import EntryState from '$lib/features/access/components/EntryState.svelte';
	import PortalEntryState from '$lib/features/portal-access/components/PortalEntryState.svelte';
	import type { AccessEntryState } from '$lib/features/access/AccessEntryController';
	import type { ParticipantEntryState } from '$lib/features/portal-access/ParticipantEntryController';

	type Lane = 'operator' | 'participant';

	interface Specimen {
		readonly id: string;
		readonly lane: Lane;
		readonly name: string;
		readonly blurb: string;
	}

	const specimens: readonly Specimen[] = [
		{
			id: 'operator-resolving',
			lane: 'operator',
			name: 'Operator · resolving',
			blurb: 'The skeleton is the card it becomes, row for row, inside the footprint the card will need — which is why arriving never moves the panel.'
		},
		{
			id: 'operator-anonymous',
			lane: 'operator',
			name: 'Operator · resting',
			blurb: 'Two equal choices. A sparkle and an eyebrow name the method once, so the field below can stay a plain "Email address"; the divider is all that separates the group from Google.'
		},
		{
			id: 'operator-busy',
			lane: 'operator',
			name: 'Operator · sending',
			blurb: 'The address stays put while the request is in flight; only the action changes.'
		},
		{
			id: 'operator-invalid',
			lane: 'operator',
			name: 'Operator · rejected address',
			blurb: 'Shape is checked locally, so a typo costs no round trip and no email.'
		},
		{
			id: 'operator-requested',
			lane: 'operator',
			name: 'Operator · acknowledged',
			blurb: 'One answer for every address, matched or not — the surface cannot enumerate accounts. The envelope joins the heading; the words stay the meaning.'
		},
		{
			id: 'participant-resolving',
			lane: 'participant',
			name: 'Speaker · resolving',
			blurb: 'A shorter lane reserves a shorter panel: one method, no provider control, no aside.'
		},
		{
			id: 'participant-anonymous',
			lane: 'participant',
			name: 'Speaker · one field',
			blurb: 'The same named method group, its own warm helper. No provider button here: one address serves first arrival and return alike.'
		},
		{
			id: 'participant-requested',
			lane: 'participant',
			name: 'Speaker · acknowledged',
			blurb: 'Plain, because this lane really does create access. The heading names no method, so a code can take the same room later.'
		},
		{
			id: 'participant-expired',
			lane: 'participant',
			name: 'Speaker · spent link',
			blurb: 'A followed link that no longer works explains itself without judging the address.'
		}
	];

	/* Opens on the resting operator card — the state the surface is in almost
	   all of the time — with the resolver one step to its left. */
	let index = $state(specimens.findIndex((entry) => entry.id === 'operator-anonymous'));
	let email = $state('ada@example.com');
	const specimen = $derived(specimens[index]);

	const operatorState = $derived<AccessEntryState>(
		specimen.id === 'operator-resolving'
			? { kind: 'resolving', delayed: true }
			: specimen.id === 'operator-busy'
				? { kind: 'anonymous', email, busy: true, invalid: false }
				: specimen.id === 'operator-invalid'
					? { kind: 'anonymous', email: 'ada@', busy: false, invalid: true }
					: specimen.id === 'operator-requested'
						? { kind: 'link_requested', email }
						: { kind: 'anonymous', email: '', busy: false, invalid: false }
	);

	const participantState = $derived<ParticipantEntryState>(
		specimen.id === 'participant-resolving'
			? { kind: 'resolving', delayed: true }
			: specimen.id === 'participant-requested'
				? { kind: 'link_requested', email }
				: specimen.id === 'participant-expired'
					? { kind: 'callback_error', outcome: 'link_expired' }
					: { kind: 'anonymous', email: '', invalid: false }
	);

	function show(id: string) {
		const next = specimens.findIndex((entry) => entry.id === id);
		if (next >= 0) index = next;
	}

	function select(next: number) {
		index = (next + specimens.length) % specimens.length;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowRight') select(index + 1);
		if (event.key === 'ArrowLeft') select(index - 1);
	}

	const noop = () => undefined;
</script>

<svelte:head>
	<title>Sign-in link states · JooEvents design system</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<svelte:window onkeydown={onKeydown} />

<AccessEntryFrame>
	{#if specimen.lane === 'operator'}
		<EntryState
			state={operatorState}
			onGoogle={noop}
			onRetry={noop}
			onCheck={noop}
			onSignOut={noop}
			onLinkEmail={(value) => (email = value)}
			onSubmitLink={() => show('operator-requested')}
			onDifferentAddress={() => show('operator-anonymous')} />
	{:else}
		<PortalEntryState
			state={participantState}
			onEmail={(value) => (email = value)}
			onSubmit={() => show('participant-requested')}
			onDifferentAddress={() => show('participant-anonymous')}
			onBackToSignIn={() => show('participant-anonymous')}
			onRetry={noop} />
	{/if}
</AccessEntryFrame>

<nav class="specimen-bar" aria-label="Sign-in link states">
	<div class="specimen-bar__choices">
		{#each specimens as entry, position (entry.id)}
			<button type="button" aria-pressed={position === index} onclick={() => (index = position)}>
				{entry.name}
			</button>
		{/each}
	</div>
	<p>{specimen.blurb} <span>&larr;/&rarr; to browse</span></p>
</nav>

<style>
	.specimen-bar {
		position: fixed;
		inset-inline: 0;
		inset-block-end: 0;
		z-index: 10;
		display: grid;
		justify-items: center;
		gap: var(--je-space-2);
		padding: var(--je-space-3) var(--je-space-4) max(var(--je-space-3), env(safe-area-inset-bottom));
		background: color-mix(in srgb, var(--je-color-surface) 92%, transparent);
		border-block-start: 1px solid var(--je-color-border-subtle);
		backdrop-filter: blur(8px);
	}

	.specimen-bar__choices {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--je-space-2);
	}

	.specimen-bar__choices button {
		padding: 0.35rem 0.7rem;
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-round);
		background: var(--je-color-surface);
		color: var(--je-color-text);
		font-size: var(--je-font-size-sm);
		cursor: pointer;
	}

	.specimen-bar__choices button[aria-pressed='true'] {
		border-color: var(--je-color-action);
		background: var(--je-color-action-soft);
		font-weight: 700;
	}

	.specimen-bar p {
		max-inline-size: 60ch;
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		text-align: center;
	}

	.specimen-bar p span {
		color: var(--je-color-text-subtle);
	}
</style>
