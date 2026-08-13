<script lang="ts">
	import { onMount } from 'svelte';
	import { Field } from '$lib/ui';
	import type { EventProgramPort } from '$lib/api/event-program/port';
	import {
		buildScheduleVocabulary,
		type ScheduleVocabulary,
		type ScheduleVocabularyKind,
		type ScheduleVocabularyOption
	} from './program-vocabulary';

	export interface ScheduleVocabularySelection {
		readonly roomId?: string;
		readonly trackId?: string;
		readonly formatId?: string;
	}

	interface Props {
		port: EventProgramPort;
		value?: ScheduleVocabularySelection;
		disabled?: boolean;
		onchange?: (value: ScheduleVocabularySelection) => void;
	}

	let { port, value = {}, disabled = false, onchange }: Props = $props();
	let vocabulary = $state<ScheduleVocabulary | null>(null);
	let error = $state('');

	onMount(async () => {
		const result = await port.vocabulary.read();
		if (result.kind === 'success') {
			vocabulary = buildScheduleVocabulary(result.data);
			return;
		}
		error = result.kind === 'unavailable'
			? 'Program choices are not available in this build.'
			: 'Program choices could not be loaded.';
	});

	function options(kind: ScheduleVocabularyKind): readonly ScheduleVocabularyOption[] {
		if (!vocabulary) return [];
		return kind === 'room' ? vocabulary.rooms : kind === 'track' ? vocabulary.tracks : vocabulary.formats;
	}

	function selected(kind: ScheduleVocabularyKind): string {
		return kind === 'room' ? (value.roomId ?? '') : kind === 'track' ? (value.trackId ?? '') : (value.formatId ?? '');
	}

	function choose(kind: ScheduleVocabularyKind, event: Event) {
		const id = (event.currentTarget as HTMLSelectElement).value || undefined;
		value = kind === 'room'
			? { ...value, roomId: id }
			: kind === 'track'
				? { ...value, trackId: id }
				: { ...value, formatId: id };
		onchange?.(value);
	}
</script>

<div class="schedule-vocabulary" aria-busy={!vocabulary && !error}>
	{#if error}
		<p class="error" role="status">{error}</p>
	{:else if !vocabulary}
		<div class="loading" aria-label="Loading program choices"></div>
	{:else}
		{#each [
			{ kind: 'room' as const, label: 'Room' },
			{ kind: 'track' as const, label: 'Track' },
			{ kind: 'format' as const, label: 'Format' }
		] as field (field.kind)}
			<Field id={`schedule-${field.kind}`} label={field.label}>
				{#snippet children({ id, describedBy })}
					<select class="ui-control" {id} aria-describedby={describedBy} {disabled}
						value={selected(field.kind)} onchange={(event) => choose(field.kind, event)}>
						<option value="">Choose {field.label.toLowerCase()}</option>
						{#each options(field.kind) as option (option.id)}
							{#if option.selectable || option.id === selected(field.kind)}
								<option value={option.id} disabled={!option.selectable}>
									{option.label}{option.status === 'retired' ? ' · retired' : ''}
								</option>
							{/if}
						{/each}
					</select>
				{/snippet}
			</Field>
		{/each}
	{/if}
</div>

<style>
	.schedule-vocabulary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--je-space-3); min-block-size: 4.75rem; }
	.error { grid-column: 1 / -1; margin: 0; padding: var(--je-space-3); border-radius: var(--je-radius-sm); background: var(--je-color-danger-soft); color: var(--je-color-danger); font-size: var(--je-font-size-sm); }
	.loading { grid-column: 1 / -1; border-radius: var(--je-radius-sm); background: var(--je-color-surface-sunken); }
	@media (max-width: 42rem) { .schedule-vocabulary { grid-template-columns: 1fr; } }
</style>
