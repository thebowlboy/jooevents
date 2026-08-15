<script lang="ts">
	/**
	 * An invitation to speak, and the answer to it.
	 *
	 * Two things this panel refuses to blur. A confirmation says who gave it —
	 * on a co-presented session one person answers for the group, and an
	 * organizer may record an agreement made elsewhere, so "Confirmed" alone
	 * would hide whose word it was. And asking to cancel is a message to people,
	 * not a state change: it alerts the organizers, and nothing about the session
	 * moves until they act.
	 */
	import { arrival } from '$lib/ui';
	import type { PortalEngagementView } from '$lib/api/portal/view-models';
	import { recordAction } from '$lib/features/workspace/actions.svelte';
	import { param } from '$lib/features/workspace/url-state.svelte';
	import { engagementStatusCopy, refusalCopy, unavailableCopy } from '../copy';
	import { formatDeadline, formatInstant } from '../format';
	import { usePortalStore } from '../store.svelte';
	import MaterialsSection from './MaterialsSection.svelte';
	import RefusalNote from './RefusalNote.svelte';
	import StateBadge from './StateBadge.svelte';

	let { engagement }: { engagement: PortalEngagementView } = $props();

	const store = usePortalStore();
	const timezone = $derived(store.snapshot?.event.timezone ?? 'UTC');
	const now = Date.now();

	let busy = $state<'confirm' | 'decline' | null>(null);
	let refusal = $state('');

	const others = $derived(engagement.speakers.filter((speaker) => !speaker.isYou));
	const cancelNoticeId = $derived(`cancel-notice-${engagement.id}`);
	const asked = $derived(param('engagement') === engagement.id);

	const attribution = $derived.by(() => {
		const confirmation = engagement.confirmation;
		if (!confirmation) return null;
		const at = formatInstant(confirmation.at, timezone);
		switch (confirmation.by) {
			case 'you':
				return `You confirmed on ${at}.`;
			case 'co_speaker':
				return `${confirmation.displayName} confirmed on ${at}. One speaker's answer counts for everyone listed.`;
			case 'organizer':
				return `The organizers recorded this for you on ${at}, from an answer you gave them elsewhere.`;
		}
	});

	async function respond(response: 'confirm' | 'decline') {
		if (busy !== null) return;
		busy = response;
		refusal = '';
		const outcome = await store.api.respondToEngagement({
			engagementId: engagement.id,
			response
		});
		busy = null;
		if (!outcome.ok) {
			refusal = refusalCopy[outcome.reason];
			return;
		}
		recordAction({
			label:
				response === 'confirm'
					? `Confirmed “${engagement.sessionTitle}”`
					: `Told the organizers you cannot do “${engagement.sessionTitle}”`,
			area: 'Portal',
			notUndoableReason: 'The organizers have your answer. Ask them if it needs changing.'
		});
		await store.reload();
	}
</script>

<article class="engagement" {@attach arrival(asked, { block: 'center' })}>
	<div class="engagement__head">
		<h3 class="engagement__title">{engagement.sessionTitle}</h3>
		<StateBadge state={engagementStatusCopy[engagement.status]} />
	</div>

	{#if others.length > 0}
		<p class="engagement__speakers">
			With {others.map((speaker) => speaker.displayName).join(', ')}. Any of you can answer, and the
			others are told.
		</p>
	{/if}

	{#if engagement.status === 'invited'}
		<p class="engagement__line">
			Invited {formatInstant(engagement.invitedAt, timezone)}.
			{#if engagement.respondBy}
				The organizers asked for an answer by {formatDeadline(engagement.respondBy, timezone, now)}.
			{/if}
		</p>
		<div class="engagement__actions">
			<button
				type="button"
				class="ui-button ui-button--primary"
				disabled={busy !== null}
				aria-busy={busy === 'confirm' || undefined}
				onclick={() => respond('confirm')}>
				{busy === 'confirm' ? 'Confirming…' : 'Yes, I can speak'}
			</button>
			<button
				type="button"
				class="ui-button ui-button--secondary"
				disabled={busy !== null}
				aria-busy={busy === 'decline' || undefined}
				onclick={() => respond('decline')}>
				{busy === 'decline' ? 'Saving…' : 'No, I cannot'}
			</button>
		</div>
	{:else if engagement.status === 'confirmed'}
		{#if attribution}<p class="engagement__line">{attribution}</p>{/if}
		<div class="engagement__actions">
			<button
				type="button"
				class="ui-button ui-button--secondary ui-button--sm"
				aria-disabled="true"
				aria-describedby={cancelNoticeId}>
				Ask to cancel
			</button>
		</div>
		<p class="engagement__notice" id={cancelNoticeId}>{unavailableCopy.cancellationRequest}</p>
	{:else}
		<p class="engagement__line">{engagementStatusCopy[engagement.status].meaning}</p>
	{/if}

	{#if refusal}
		<RefusalNote message={refusal} tone="refused" />
	{/if}

	{#if engagement.status === 'invited' || engagement.status === 'confirmed'}
		<!-- Materials live with the engagement they belong to: asks, uploads,
		     and organizer-shared resources for exactly this session. -->
		<MaterialsSection engagementId={engagement.id} />
	{/if}
</article>

<style>
	.engagement {
		display: grid;
		gap: var(--je-space-2);
		padding: var(--je-space-4);
		background: var(--je-color-surface);
		border: 1px solid var(--je-color-border);
		border-radius: var(--je-radius-surface);
	}

	.engagement__head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--je-space-2);
	}

	.engagement__title {
		margin: 0;
		font-size: var(--je-font-size-md);
		font-weight: 600;
	}

	.engagement__speakers,
	.engagement__line,
	.engagement__notice {
		margin: 0;
		color: var(--je-color-text-muted);
		font-size: var(--je-font-size-sm);
		max-inline-size: 62ch;
		line-height: var(--je-leading-normal);
	}

	.engagement__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--je-space-2);
		margin-block-start: var(--je-space-1);
	}
</style>
